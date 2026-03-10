'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const logger = require('./logger');
const db = require('./db');
const auth = require('./auth');
const sessionManager = require('./session-manager');
const Session = require('./session');
const { resolveAllowedRoots } = require('./path-validator');
const { runStartupChecks } = require('./startup-checks');
const { startOrphanScan } = require('./orphan-scan');

// ──────────────────────────────────────────────────────────────────────────
// Configuration

const PORT = parseInt(process.env.BRIDGE_PORT || '7001', 10);
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;
const CLIENT_SECRET = process.env.REMOTEDEV_CLIENT_SECRET;
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const PROTOCOL_VERSION = 1;
const MAX_UNAUTH_PER_IP = 10;

const ALLOWED_ROOTS_RAW = (process.env.ALLOWED_ROOTS || process.env.HOME || '/tmp')
  .split(':')
  .filter(Boolean);

let resolvedRoots;

// ──────────────────────────────────────────────────────────────────────────
// Validate required environment

function validateEnv() {
  if (!BRIDGE_AUTH_TOKEN) {
    logger.fatal('BRIDGE_AUTH_TOKEN is required');
    process.exit(1);
  }
  if (!CLIENT_SECRET) {
    logger.fatal('REMOTEDEV_CLIENT_SECRET is required');
    process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Global process traps

function killAllSessions() {
    try {
      for (const session of sessionManager.allSessions()) {
        try {
          if (session.proc) {
            if (typeof session.proc.kill === 'function') {
              session.proc.kill('SIGKILL');
            } else {
              process.kill(-session.proc.pid, 'SIGKILL');
            }
          }
          if (session.caffeinateProc) {
            session.caffeinateProc.kill('SIGKILL');
          }
        } catch {}
      }
    } catch (innerErr) {
    logger.fatal({ innerErr }, 'killAllSessions threw — calling process.abort()');
    process.abort();
  }
}

function installTraps() {
  process.on('exit', killAllSessions);

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received — shutting down');
    killAllSessions();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received — shutting down');
    killAllSessions();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    try {
      killAllSessions();
    } catch {
      process.abort();
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Build WS server

function buildServer() {
  if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    const server = https.createServer({
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
    });
    logger.info({ cert: TLS_CERT }, 'TLS enabled');
    return server;
  }

  logger.warn('TLS not configured — using plain WS (development only)');
  return http.createServer();
}

// ──────────────────────────────────────────────────────────────────────────
// WS connection handler

function handleConnection(ws, req) {
  const ip = req.socket.remoteAddress || 'unknown';

  // Per-IP unauthenticated limit
  if (!auth.trackUnauthConnect(ip)) {
    logger.warn({ ip }, 'Too many unauthenticated connections from IP');
    ws.close(4429, 'too_many_connections');
    return;
  }

  let isAuthed = false;
  let sessionId = null;
  let authTimeout;

  // Auth timeout — 5s to authenticate
  authTimeout = setTimeout(() => {
    if (!isAuthed) {
      logger.warn({ ip }, 'Auth timeout');
      ws.close(4008, 'auth_timeout');
    }
  }, auth.AUTH_TIMEOUT_MS);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      ws.close(4400, 'invalid_json');
      return;
    }

    // Protocol version check (after auth)
    if (isAuthed && msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
      logger.warn({ ip, v: msg.v }, 'Protocol version mismatch');
      ws.close(4400, 'protocol_version_mismatch');
      return;
    }

    if (!isAuthed) {
      if (msg.type === 'authenticate') {
        handleAuthenticate(ws, ip, msg, (ok, epoch) => {
          if (ok) {
            clearTimeout(authTimeout);
            isAuthed = true;
            auth.trackUnauthDisconnect(ip);
          }
        });
      } else {
        ws.close(4003, 'not_authenticated');
      }
      return;
    }

    // Validate controller epoch on all mutating messages
    const mutatingTypes = new Set([
      'create_session', 'input', 'stop', 'approval_response', 'resume_session',
    ]);

    if (mutatingTypes.has(msg.type)) {
      if (!sessionManager.validateEpoch(msg.controllerEpoch)) {
        logger.warn({ ip, type: msg.type, epoch: msg.controllerEpoch }, 'Stale epoch');
        sendMsg(ws, buildMsg('bridge_warning', null, {
          subtype: 'stale_epoch',
          reason: 'Another tab may have taken control',
        }));
        ws.close(4403, 'stale_epoch');
        return;
      }
    }

    // Route message
    routeMessage(ws, ip, msg, () => {
      sessionId = msg.sessionId || sessionId;
    });
  });

  ws.on('close', (code, reason) => {
    clearTimeout(authTimeout);

    if (!isAuthed) {
      auth.trackUnauthDisconnect(ip);
      return;
    }

    const reasonStr = reason?.toString() || '';
    const intentional = [1000, 1001, 4403].includes(code);

    // Release controller + disconnect current session
    const session = sessionId ? sessionManager.get(sessionId) : null;
    if (session && !session.destroyed) {
      session.onDisconnect(intentional);
    }

    logger.info({ ip, code, reason: reasonStr }, 'WS closed');
  });

  ws.on('error', (err) => {
    logger.debug({ ip, err }, 'WS error');
  });
}

function handleAuthenticate(ws, ip, msg, cb) {
  // Check IP lockout
  const lockout = auth.checkIpLockout(ip);
  if (!lockout.allowed) {
    logger.warn({ ip, remainingMs: lockout.remaining }, 'IP locked out');
    ws.close(4003, 'ip_locked');
    return cb(false);
  }

  const result = auth.validateAuthenticate(msg.payload || msg, BRIDGE_AUTH_TOKEN, CLIENT_SECRET);

  if (!result.ok) {
    const isStaleAssertion = result.reason === 'hmac_mismatch';
    const locked = auth.recordAuthFailure(ip, { isStaleAssertion });
    logger.warn({ ip, reason: result.reason, locked }, 'Auth failed');

    // 4003 with stale-assertion subtype doesn't count toward lockout
    ws.close(result.code || 4003, result.reason);
    return cb(false);
  }

  // Auth success
  auth.clearIpState(ip);
  const epoch = sessionManager.mintEpoch();

  sendMsg(ws, buildMsg('authenticated', null, { controllerEpoch: epoch }));
  logger.info({ ip }, 'Client authenticated');

  // Send state_sync of all sessions
  for (const session of sessionManager.allSessions()) {
    if (session.state !== 'IDLE') {
      sendMsg(ws, buildMsg('state_sync', session.id, {
        state: session.state,
        sessionId: session.id,
        seq: session.seq,
        lastAck: session.lastAck,
        pendingApproval: session.pendingApproval,
      }));
    }
  }

  cb(true, epoch);
}

function routeMessage(ws, ip, msg, onSession) {
  const { type, payload, sessionId } = msg;

  switch (type) {
    case 'create_session': {
      const id = crypto.randomUUID();
      const name = payload?.name || 'session';
      const workingDir = payload?.workingDir || process.env.HOME || '/tmp';

      // Validate workingDir is within allowed roots
      const { validatePath } = require('./path-validator');
      const check = validatePath(workingDir, workingDir, resolvedRoots);
      if (!check.safe) {
        sendMsg(ws, buildMsg('error', null, {
          message: 'workingDir not in ALLOWED_ROOTS',
          subtype: 'invalid_working_dir',
        }));
        return;
      }

      const session = sessionManager.create(Session, id, name, workingDir);
      session.attachWs(ws);
      session.resolvedRoots = resolvedRoots;
      sessionManager.setController(id);
      session._resetHeartbeatTimer();

      db.insertAuditLog(id, null, 'session_created', { name, workingDir });
      onSession();

      sendMsg(ws, buildMsg('state_sync', id, {
        state: 'IDLE', sessionId: id, seq: 0, lastAck: 0,
      }));
      break;
    }

    case 'input': {
      const session = sessionId ? sessionManager.get(sessionId) : null;
      if (!session) {
        sendMsg(ws, buildMsg('error', sessionId, { message: 'session_not_found', subtype: 'not_found' }));
        return;
      }
      if (session.state === 'RUNNING' || session.state === 'AWAITING_APPROVAL') {
        sendMsg(ws, buildMsg('session_busy', sessionId, {}));
        return;
      }

      session.rootMessageId = payload?.messageId || crypto.randomUUID();
      db.insertAuditLog(sessionId, session.rootMessageId, 'input', {
        instruction: (payload?.instruction || '').slice(0, 500),
      });

      session.startClaude(
        payload?.instruction || '',
        ALLOWED_ROOTS_RAW,
        resolvedRoots,
      );
      break;
    }

    case 'stop': {
      const session = sessionId ? sessionManager.get(sessionId) : null;
      if (!session) return;
      session.stop();
      break;
    }

    case 'approval_response': {
      const session = sessionId ? sessionManager.get(sessionId) : null;
      if (!session) return;
      session.handleApprovalResponse(payload?.requestId, payload?.decision);
      break;
    }

    case 'resume_session': {
      const targetId = payload?.sessionId || sessionId;
      const session = targetId ? sessionManager.get(targetId) : null;
      if (!session) {
        sendMsg(ws, buildMsg('error', targetId, { message: 'session_not_found', subtype: 'not_found' }));
        return;
      }
      if (session.state === 'DISCONNECTED') {
        session.onReconnect(ws);
      } else if (session.state === 'IDLE') {
        sendMsg(ws, buildMsg('state_sync', targetId, { state: 'IDLE', sessionId: targetId }));
      } else if (session.state === 'RUNNING' || session.state === 'AWAITING_APPROVAL') {
        // Another tab tried to resume an active session
        session.attachWs(ws);
        sendMsg(ws, buildMsg('session_busy', targetId, { state: session.state }));
      }
      break;
    }

    case 'ping': {
      const session = sessionId ? sessionManager.get(sessionId) : null;
      if (session) {
        session.onPing(payload?.lastAck);
      } else {
        sendMsg(ws, buildMsg('pong', null, { seq: 0 }));
      }
      break;
    }

    case 'client_error': {
      const session = sessionId ? sessionManager.get(sessionId) : null;
      if (session) {
        session.handleClientError(
          payload?.rootMessageId,
          payload?.error,
          payload?.context,
          payload?.uiBuildVersion,
        );
      } else {
        // Log even without a session
        logger.warn({ ip, payload }, 'client_error without session');
      }
      break;
    }

    default:
      logger.debug({ type, ip }, 'Unknown message type');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Message builders

function buildMsg(type, sessionId, payload) {
  return {
    v: PROTOCOL_VERSION,
    type,
    seq: null,
    sessionId: sessionId || null,
    rootMessageId: null,
    messageId: crypto.randomUUID(),
    ts: Date.now(),
    payload: payload || null,
    controllerEpoch: sessionManager.getCurrentEpoch(),
  };
}

function sendMsg(ws, msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────
// Main

async function main() {
  validateEnv();
  installTraps();

  // DB
  db.openDb();

  const dbDir = path.join(process.env.HOME || '/tmp', '.local', 'share', 'remotedev');
  runStartupChecks({
    certPath: TLS_CERT,
    dbDir,
  });

  // Resolve allowed roots
  resolvedRoots = resolveAllowedRoots(ALLOWED_ROOTS_RAW);
  logger.info({ resolvedRoots }, 'Allowed roots resolved');

  // Orphan scan
  startOrphanScan();

  // Build HTTP/HTTPS server + WS
  const server = buildServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', handleConnection);

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Bridge server listening');
    // Signal readiness for pm2 readiness poll
    if (process.send) process.send('ready');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
