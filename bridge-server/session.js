'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const pty = require('node-pty');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { WebSocket } = require('ws');

const logger = require('./logger');

/**
 * Log diagnostics when PTY spawn fails. On macOS node-pty spawns a helper binary (spawn-helper)
 * which then execs the target; posix_spawn can fail for the helper or for PTY setup.
 */
function logPtySpawnDiagnostics(claudePath, spawnOpts) {
  const diag = {};

  try {
    diag.claudePath = claudePath;
    diag.claudeExists = fs.existsSync(claudePath);
    if (diag.claudeExists) {
      const st = fs.statSync(claudePath);
      diag.claudeMode = st.mode.toString(8);
      diag.claudeIsFile = st.isFile();
      diag.claudeIsSymlink = st.isSymbolicLink ? st.isSymbolicLink() : false;
      try {
        diag.claudeRealpath = fs.realpathSync(claudePath);
      } catch {
        diag.claudeRealpath = null;
      }
      try {
        const head = fs.readFileSync(claudePath, { encoding: 'utf8', flag: 'r' }).slice(0, 120);
        diag.claudeShebang = head.split('\n')[0] || head;
      } catch {
        diag.claudeShebang = null;
      }
    }
  } catch (e) {
    diag.claudeStatError = e.message;
  }

  try {
    const r = spawnSync(claudePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: spawnOpts.env,
      cwd: spawnOpts.cwd || undefined,
    });
    diag.claudeSpawnSyncOk = r.status === 0;
    diag.claudeSpawnSyncStatus = r.status;
    diag.claudeSpawnSyncSignal = r.signal || null;
    if (r.error) diag.claudeSpawnSyncError = r.error.message;
  } catch (e) {
    diag.claudeSpawnSyncError = e.message;
  }

  try {
    const nodePtyLib = path.dirname(require.resolve('node-pty'));
    const nodePtyRoot = path.join(nodePtyLib, '..');
    const dirs = [
      path.join(nodePtyLib, 'build/Release'),
      path.join(nodePtyLib, 'build/Debug'),
      path.join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`),
    ];
    for (const dir of dirs) {
      const helperPath = path.join(dir, 'spawn-helper');
      if (fs.existsSync(helperPath)) {
        diag.ptyHelperPath = helperPath;
        const st = fs.statSync(helperPath);
        diag.ptyHelperExists = true;
        diag.ptyHelperMode = st.mode.toString(8);
        diag.ptyHelperExecutable = (st.mode & 0o111) !== 0;
        break;
      }
    }
    if (!diag.ptyHelperPath) diag.ptyHelperChecked = dirs;
  } catch (e) {
    diag.ptyHelperError = e.message;
  }

  diag.processUid = typeof process.getuid === 'function' ? process.getuid() : null;
  diag.processGid = typeof process.getgid === 'function' ? process.getgid() : null;
  diag.platform = process.platform;
  diag.arch = process.arch;
  diag.cwd = spawnOpts.cwd || process.cwd();
  diag.cwdExists = spawnOpts.cwd ? fs.existsSync(spawnOpts.cwd) : true;

  logger.warn({ ptySpawnDiagnostics: diag }, 'PTY spawn diagnostics (macOS: node-pty spawns helper binary first; failure may be helper or PTY setup)');
}
const db = require('./db');
const NdjsonFramer = require('./ndjson-framer');
const sessionManager = require('./session-manager');
const { validatePath } = require('./path-validator');
const { getClaudePath } = require('./startup-checks');

// Constants
const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const ORPHAN_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min no stdout
const BACKPRESSURE_WARN_MS = 30 * 1000;
const BACKPRESSURE_KILL_MS = 60 * 1000;
const BACKPRESSURE_THRESHOLD = 64 * 1024;   // 64KB
const MAX_CONSECUTIVE_PARSE_ERRORS = 5;
const PARSE_FATAL_THRESHOLD = 20;
const MAX_RAW_STDOUT_LINES_DB = 1000;
const MAX_RAW_STDOUT_BYTES_DB = 1024 * 1024; // 1MB
const OFFLINE_BUDGET_BYTES = 50 * 1024 * 1024; // 50MB
const RING_SIZE = 200;
const GAP_SMALL_THRESHOLD = 50;             // ≤50 → ring replay
const DB_FLUSH_INTERVAL_MS = 100;
const DB_FLUSH_MAX_EVENTS = 50;
const CLIENT_ERRORS_MAX = 10;
const APPROVAL_TTL_MS = 60 * 1000;

// Claude version requirements
const CLAUDE_MIN_VERSION = process.env.CLAUDE_MIN_VERSION || '0.0.0';

// After first PTY spawn failure (e.g. posix_spawnp under pm2), skip PTY for rest of process lifetime to avoid repeated WARN.
let ptyUnavailable = false;

/** On macOS node-pty spawns a helper binary; some npm installs leave it 0644 (no execute bit). Fix once so PTY can run. */
function ensurePtyHelperExecutable() {
  if (process.platform !== 'darwin') return;
  try {
    const nodePtyLib = path.dirname(require.resolve('node-pty'));
    const nodePtyRoot = path.join(nodePtyLib, '..');
    const helperDir = path.join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`);
    const helperPath = path.join(helperDir, 'spawn-helper');
    if (!fs.existsSync(helperPath)) return;
    const st = fs.statSync(helperPath);
    if ((st.mode & 0o111) !== 0) return;
    fs.chmodSync(helperPath, 0o755);
    logger.info({ helperPath }, 'Set node-pty spawn-helper executable (was 0644); PTY spawn may now succeed');
  } catch (e) {
    logger.debug({ err: e.message }, 'Could not fix spawn-helper permissions');
  }
}

// Fix spawn-helper permissions at startup so first PTY attempt can succeed (no need to wait for first spawn).
ensurePtyHelperExecutable();

class Session {
  constructor(id, name, workingDir, opts = {}) {
    this.id = id;
    this.name = name;
    this.workingDir = workingDir;

    this.state = 'IDLE';
    this.destroyed = false;

    this.ws = null;
    this.proc = null;
    this.caffeinateProc = null;

    // Sequencing
    this.seq = 0;
    this.lastAck = 0;

    // Ring buffer for gap recovery
    this.ring = [];

    // Pending DB writes
    this.pendingDbWrites = [];
    this.dbFlushTimeout = null;
    this.persistenceDegraded = false;

    // Offline transcript budget (per-session-total, reset only in endSession)
    this.offlineTranscriptBytes = 0;

    // Parse error tracking
    this.consecutiveParseErrors = 0;
    this.parseDegraded = false;
    this.rawNonJsonLines = 0;
    this.rawStdoutLines = 0;
    this.rawStdoutBytes = 0;

    // Approval FSM
    this.pendingApproval = null;
    this.lastRespondedRequestId = null;
    this.preDisconnectState = null;

    // Timers
    this.heartbeatTimer = null;
    this.orphanTimer = null;
    this.backpressureStallTimer = null;
    this.backpressurePausedAt = null;
    this.disconnectedApprovalTimer = null;
    this.dbFlushInterval = null;
    this.drainInterval = null;

    // NDJSON framer
    this._framer = new NdjsonFramer({
      onLine: (line) => this._onNdjsonLine(line),
      onError: (err) => this._onParseError(err),
    });

    // rootMessageId for current input
    this.rootMessageId = null;

    // Resolved path variables (set at create time)
    this.resolvedRoots = [];
    this.resolvedWorkingDir = null;

    // Client error count per session
    this.clientErrorCount = 0;

    if (!opts.skipDbInsert) {
      db.insertSession(id, name, workingDir);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WebSocket lifecycle

  attachWs(ws) {
    this.ws = ws;
  }

  onDisconnect(intentional = false) {
    if (this.destroyed) return;

    // Always clear heartbeat — prevents spurious DISCONNECTED on intentional ws.close
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;

    // Clear backpressure stall timer
    clearTimeout(this.backpressureStallTimer);
    this.backpressureStallTimer = null;
    this.backpressurePausedAt = null;
    clearInterval(this.drainInterval);
    this.drainInterval = null;

    // Save state before overwriting (critical for approval restoration)
    this.preDisconnectState = this.state;

    // Do NOT auto-deny pending approvals on disconnect.
    // The approval is preserved. TTL expiry timer fires the deny if needed.
    if (this.state === 'AWAITING_APPROVAL' && this.pendingApproval) {
      const msUntilExpiry = this.pendingApproval.expiresAt - Date.now();
      if (msUntilExpiry > 0) {
        this.disconnectedApprovalTimer = setTimeout(() => {
          if (this.state === 'DISCONNECTED' && this.pendingApproval) {
            this._emitControlResponse(this.pendingApproval.requestId, 'deny');
          }
        }, msUntilExpiry);
      } else {
        // TTL already expired
        this._emitControlResponse(this.pendingApproval.requestId, 'deny');
      }
    }

    this.state = 'DISCONNECTED';
    this.ws = null;
    sessionManager.releaseController(this.id);

    logger.info({ sessionId: this.id, preDisconnectState: this.preDisconnectState },
      'Session disconnected');

    this._resetOrphanTimer();
  }

  onReconnect(newWs) {
    if (this.destroyed) return;

    clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
    clearTimeout(this.disconnectedApprovalTimer);
    this.disconnectedApprovalTimer = null;

    this.ws = newWs;

    const procAlive = this.proc &&
      this.proc.exitCode === null &&
      this.proc.signalCode === null &&
      !this.proc.killed;

    // Restore from preDisconnectState
    if (this.preDisconnectState === 'AWAITING_APPROVAL' && this.pendingApproval) {
      if (this.pendingApproval.expiresAt > Date.now()) {
        this.state = 'AWAITING_APPROVAL'; // restore with modal
      } else {
        this._emitControlResponse(this.pendingApproval.requestId, 'deny');
        this.state = procAlive ? 'RUNNING' : 'IDLE';
      }
    } else {
      this.state = procAlive ? 'RUNNING' : 'IDLE';
    }

    this.preDisconnectState = null;
    sessionManager.setController(this.id);

    this._resetHeartbeatTimer();
    this._sendStateSync();
    this._handleGapRecovery();

    logger.info({ sessionId: this.id, state: this.state }, 'Session reconnected');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Claude process spawning

  startClaude(instruction, allowedRoots, resolvedRoots) {
    if (this.destroyed) return;
    if (this.proc) return; // already running

    this.resolvedRoots = resolvedRoots;
    try {
      this.resolvedWorkingDir = fs.realpathSync(this.workingDir);
    } catch {
      this.resolvedWorkingDir = this.workingDir;
    }

    // Spawn caffeinate to prevent sleep
    try {
      this.caffeinateProc = spawn('caffeinate', ['-i'], {
        stdio: 'ignore',
        detached: true,
      });
      this.caffeinateProc.unref();
    } catch {
      // caffeinate not available (e.g., Linux)
    }

    const env = {
      ...process.env,
      CI: 'true',
      NONINTERACTIVE: '1',
      REMOTEDEV_SESSION_ID: this.id,
    };

    // PTY first (when available): stream-json is documented for pipe use but the CLI buffers when stdout is not a TTY.
    // If PTY fails once (e.g. posix_spawnp under pm2), we set ptyUnavailable and use pipe only for the rest of this process.
    const claudePath = getClaudePath();
    const spawnArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'all', instruction];
    const spawnOpts = { cwd: this.resolvedWorkingDir || this.workingDir, env };
    let proc;
    let isPty = false;

    if (ptyUnavailable) {
      logger.info({ sessionId: this.id }, 'Using pipe spawn (PTY failed earlier this process). Restart bridge (npm run reload) to retry PTY.');
      try {
        proc = spawn(claudePath, spawnArgs, { ...spawnOpts, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        logger.error({ sessionId: this.id, err, claudePath }, 'Claude spawn failed');
        this.endSession('proc_spawn_failed');
        return;
      }
    } else {
      try {
        proc = pty.spawn(claudePath, spawnArgs, {
          ...spawnOpts,
          cols: 80,
          rows: 24,
        });
        isPty = true;
      } catch (err) {
        ptyUnavailable = true;
        logPtySpawnDiagnostics(claudePath, spawnOpts);
        logger.warn({ sessionId: this.id, err: err.message, claudePath }, 'PTY spawn failed, using pipe for this process (output may be buffered)');
        try {
          proc = spawn(claudePath, spawnArgs, { ...spawnOpts, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        } catch (err2) {
          logger.error({ sessionId: this.id, err: err2, claudePath }, 'Claude spawn failed');
          this.endSession('proc_spawn_failed');
          return;
        }
      }
    }

    this.proc = proc;
    this._isPty = isPty;
    this.state = 'RUNNING';
    db.updateSessionState(this.id, 'RUNNING');
    db.insertAuditLog(this.id, this.rootMessageId, 'session_start', {
      instruction: instruction.slice(0, 500),
    });

    logger.info({
      sessionId: this.id,
      pid: this.proc.pid,
      rootMessageId: this.rootMessageId,
      pty: isPty,
    }, 'Claude process spawned');

    this._sendStateSync();

    this._firstStdoutLogged = false;
    this._firstNdjsonLineLogged = false;

    if (isPty) {
      this.proc.onData((chunk) => {
        if (this.destroyed) return;
        if (!this._firstStdoutLogged) {
          this._firstStdoutLogged = true;
          logger.info({ sessionId: this.id, bytes: chunk.length }, 'First stdout chunk from Claude');
        }
        this._framer.push(chunk);
      });
      this.proc.onExit(({ exitCode, signal }) => {
        if (this.destroyed) return;
        logger.info({ sessionId: this.id, code: exitCode, signal }, 'Claude process closed');
        this._framer.flush();
        this.endSession(`proc_exit:${exitCode ?? signal ?? 'unknown'}`);
      });
    } else {
      this.proc.stdout.on('data', (chunk) => {
        if (this.destroyed) return;
        if (!this._firstStdoutLogged) {
          this._firstStdoutLogged = true;
          logger.info({ sessionId: this.id, bytes: chunk.length }, 'First stdout chunk from Claude');
        }
        this._framer.push(chunk);
      });
      this.proc.stderr.on('data', (chunk) => {
        if (this.destroyed) return;
        const text = chunk.toString('utf8');
        const event = this._buildEnvelope({
          type: 'output',
          payload: { type: 'stderr', text: text.slice(0, 1024 * 1024) },
        });
        this._emitAndBuffer(event);
      });
      this.proc.on('close', (code, signal) => {
        if (this.destroyed) return;
        logger.info({ sessionId: this.id, code, signal }, 'Claude process closed');
        this._framer.flush();
        this.endSession(`proc_exit:${code ?? signal ?? 'unknown'}`);
      });
      this.proc.on('error', (err) => {
        if (this.destroyed) return;
        logger.error({ sessionId: this.id, err }, 'Claude process error');
        this.endSession('proc_error');
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // NDJSON line handling

  _onNdjsonLine(line) {
    if (this.destroyed) return;

    if (!this._firstNdjsonLineLogged) {
      this._firstNdjsonLineLogged = true;
      logger.info({ sessionId: this.id, linePreview: line.slice(0, 80) }, 'First NDJSON line from Claude');
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
      this.consecutiveParseErrors = 0;
      if (this.parseDegraded) {
        this.rawNonJsonLines = 0;
      }
    } catch (e) {
      this._onParseError(e, line);
      return;
    }

    // Handle control_request from claude
    if (parsed.type === 'tool_use' || (parsed.type === 'control_request')) {
      this._handleControlRequest(parsed);
      return;
    }

    const event = this._buildEnvelope({
      type: 'output',
      payload: parsed,
    });
    this._emitAndBuffer(event);
  }

  _onParseError(err, rawLine = null) {
    if (this.destroyed) return;

    this.consecutiveParseErrors += 1;

    if (this.consecutiveParseErrors >= MAX_CONSECUTIVE_PARSE_ERRORS && !this.parseDegraded) {
      this.parseDegraded = true;
      this._send(this._buildEnvelope({
        type: 'bridge_warning',
        payload: { subtype: 'parse_degraded', consecutiveErrors: this.consecutiveParseErrors },
      }));
      logger.warn({ sessionId: this.id }, 'Parse degraded mode entered');
    }

    if (this.parseDegraded && rawLine) {
      this.rawNonJsonLines += 1;
      this._persistRawLine(rawLine);
      const event = this._buildEnvelope({
        type: 'output',
        payload: { type: 'raw_stdout', text: rawLine },
      });
      this._emitAndBuffer(event);

      if (this.rawNonJsonLines >= PARSE_FATAL_THRESHOLD) {
        logger.error({ sessionId: this.id }, 'Parse fatal threshold reached');
        this.endSession('parse_fatal');
      }
    }
  }

  _persistRawLine(line) {
    if (this.parseDegraded) {
      const currentLines = this.rawStdoutLines;
      const currentBytes = this.rawStdoutBytes;
      if (currentLines >= MAX_RAW_STDOUT_LINES_DB || currentBytes + line.length > MAX_RAW_STDOUT_BYTES_DB) {
        return; // cap reached
      }
      this.rawStdoutLines++;
      this.rawStdoutBytes += line.length;
      this._queueDbWrite({
        sessionId: this.id,
        seq: this.seq,
        rootMessageId: this.rootMessageId,
        type: 'raw_stdout',
        data: line,
        ts: Date.now(),
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Approval FSM

  _handleControlRequest(parsed) {
    if (this.destroyed) return;

    const requestId = parsed.id || crypto.randomUUID();
    const expiresAt = Date.now() + APPROVAL_TTL_MS;

    this.pendingApproval = { requestId, data: parsed, expiresAt };
    this.state = 'AWAITING_APPROVAL';
    db.updateSessionState(this.id, 'AWAITING_APPROVAL');
    db.insertAuditLog(this.id, this.rootMessageId, 'approval_requested', {
      requestId, toolName: parsed.name,
    });

    const event = this._buildEnvelope({
      type: 'output',
      payload: { type: 'control_request', requestId, data: parsed, expiresAt },
    });
    this._emitAndBuffer(event);
    this._sendStateSync();
  }

  handleApprovalResponse(requestId, decision) {
    if (this.destroyed) return;
    if (!this.pendingApproval) return;
    if (this.lastRespondedRequestId === requestId) return; // exactly-once

    this.lastRespondedRequestId = requestId;
    this._emitControlResponse(requestId, decision);
  }

  _emitControlResponse(requestId, decision) {
    if (this.destroyed) return;

    // Send to subprocess stdin (pty.write for node-pty, .stdin.write for child_process)
    if (!this.proc) return;
    try {
      if (this._isPty) {
        this.proc.write(JSON.stringify({ type: 'control_response', requestId, decision }) + '\n');
      } else if (this.proc.stdin && this.proc.stdin.writable) {
        this.proc.stdin.write(JSON.stringify({ type: 'control_response', requestId, decision }) + '\n');
      }
    } catch {}

    this.pendingApproval = null;
    this.state = this.proc ? 'RUNNING' : 'IDLE';
    db.updateSessionState(this.id, this.state);
    db.insertAuditLog(this.id, this.rootMessageId, 'approval_resolved', {
      requestId, decision,
    });

    clearTimeout(this.disconnectedApprovalTimer);
    this.disconnectedApprovalTimer = null;

    this._sendStateSync();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Gap recovery

  _handleGapRecovery() {
    if (this.destroyed) return;
    if (!this.ws) return;

    const clientLastAck = this.lastAck; // updated by ping messages
    const gap = this.seq - clientLastAck;

    if (gap <= 0) return; // client is up to date

    if (gap <= GAP_SMALL_THRESHOLD && this.ring.length > 0) {
      // Replay from ring
      const toReplay = this.ring.filter(e => e.seq > clientLastAck);
      for (const event of toReplay) {
        this._send(event);
      }
      logger.debug({ sessionId: this.id, gap, replayed: toReplay.length }, 'Gap recovery via ring');
    } else {
      // Large gap — send resync_required + transcript tail
      const resync = this._buildEnvelope({
        type: 'resync_required',
        payload: {
          fromSeq: clientLastAck,
          currentSeq: this.seq,
          persistenceDegraded: this.persistenceDegraded,
        },
      });
      this._send(resync);

      if (!this.persistenceDegraded) {
        const rows = db.getTranscriptTail(this.id);
        for (const row of rows) {
          this._send(this._buildEnvelope({
            type: 'transcript_chunk',
            payload: JSON.parse(row.data),
          }));
        }
        this._send(this._buildEnvelope({
          type: 'transcript_complete',
          payload: { truncated: rows.length >= 200 },
        }));
      }

      logger.info({ sessionId: this.id, gap, persistenceDegraded: this.persistenceDegraded },
        'Gap recovery via transcript');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Emit and buffer output

  _emitAndBuffer(event) {
    if (this.destroyed) return;

    // Update seq
    event.seq = ++this.seq;

    // Add to ring buffer
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();

    // Buffer to SQLite (if not over offline budget)
    const dataStr = JSON.stringify(event.payload);
    const size = dataStr.length;

    if (this.offlineTranscriptBytes + size <= OFFLINE_BUDGET_BYTES) {
      this.offlineTranscriptBytes += size;
      this._queueDbWrite({
        sessionId: this.id,
        seq: event.seq,
        rootMessageId: event.rootMessageId,
        type: event.payload?.type || event.type,
        data: dataStr,
        ts: event.ts,
      });
    } else if (!this._offlineBudgetWarned) {
      this._offlineBudgetWarned = true;
      this._send(this._buildEnvelope({
        type: 'bridge_warning',
        payload: { subtype: 'offline_budget_exceeded' },
      }));
      logger.warn({ sessionId: this.id }, 'Offline transcript budget exceeded');
    }

    // Send to client (with backpressure check)
    this._sendWithBackpressure(event);
  }

  _sendWithBackpressure(event) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
      if (!this.backpressurePausedAt) {
        this.backpressurePausedAt = Date.now();
        this._startBackpressureTimers();
      }
      // Drop this message from live stream; it's in ring/SQLite
      return;
    }

    this._send(event);
  }

  _startBackpressureTimers() {
    this.backpressureStallTimer = setTimeout(() => {
      if (this.destroyed) return;
      const pausedMs = Date.now() - (this.backpressurePausedAt || 0);

      if (pausedMs >= BACKPRESSURE_KILL_MS) {
        logger.warn({ sessionId: this.id }, 'Backpressure 60s: closing WS (session stays RUNNING)');
        // Clear heartbeat before close to prevent spurious DISCONNECTED transition
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;

        if (this.ws) {
          this.ws.close(1011, 'buffer_overflow');
        }
        // Session stays RUNNING; client reconnects via gap recovery
      } else if (pausedMs >= BACKPRESSURE_WARN_MS) {
        this._send(this._buildEnvelope({
          type: 'bridge_warning',
          payload: { subtype: 'client_slow', pausedMs },
        }));

        // Check again at kill threshold
        this.backpressureStallTimer = setTimeout(() => {
          this._startBackpressureTimers();
        }, BACKPRESSURE_KILL_MS - pausedMs);
      }
    }, BACKPRESSURE_WARN_MS);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DB write batching

  _queueDbWrite(row) {
    if (this.persistenceDegraded) return;

    this.pendingDbWrites = this.pendingDbWrites || [];
    this.pendingDbWrites.push(row);

    if (this.pendingDbWrites.length >= DB_FLUSH_MAX_EVENTS) {
      this._flushDbBatch();
    } else if (!this.dbFlushTimeout) {
      this.dbFlushTimeout = setTimeout(() => {
        this.dbFlushTimeout = null;
        this._flushDbBatch();
      }, DB_FLUSH_INTERVAL_MS);
    }
  }

  _flushDbBatch() {
    clearTimeout(this.dbFlushTimeout);
    this.dbFlushTimeout = null;

    const writes = this.pendingDbWrites;
    if (!writes || writes.length === 0) return;
    this.pendingDbWrites = [];

    try {
      db.insertTranscriptBatch(writes);
    } catch (err) {
      logger.error({ err, sessionId: this.id }, 'DB write failed; entering persistence degraded');
      this.persistenceDegraded = true;
      this._send(this._buildEnvelope({
        type: 'bridge_warning',
        payload: { subtype: 'persistence_degraded' },
      }));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Timers

  _resetHeartbeatTimer() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.destroyed) return;
      logger.warn({ sessionId: this.id }, 'Heartbeat timeout — disconnecting');
      if (this.ws) this.ws.terminate();
      this.onDisconnect(false);
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _resetOrphanTimer() {
    clearTimeout(this.orphanTimer);
    this.orphanTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (this.state === 'DISCONNECTED') {
        logger.warn({ sessionId: this.id }, 'Orphan timeout — ending session');
        this.endSession('orphan');
      }
    }, ORPHAN_TIMEOUT_MS);
  }

  onPing(lastAck) {
    if (this.destroyed) return;
    this.lastAck = Math.max(this.lastAck, lastAck || 0);
    this._resetHeartbeatTimer();
    this._send(this._buildEnvelope({ type: 'pong', payload: { seq: this.seq } }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // State sync

  _sendStateSync() {
    this._send(this._buildEnvelope({
      type: 'state_sync',
      payload: {
        state: this.state,
        sessionId: this.id,
        seq: this.seq,
        lastAck: this.lastAck,
        pendingApproval: this.pendingApproval ? {
          requestId: this.pendingApproval.requestId,
          data: this.pendingApproval.data,
          expiresAt: this.pendingApproval.expiresAt,
        } : null,
        parseDegraded: this.parseDegraded,
        persistenceDegraded: this.persistenceDegraded,
      },
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Stop

  stop() {
    if (this.destroyed) return;

    // Auto-deny if AWAITING_APPROVAL
    if (this.state === 'AWAITING_APPROVAL' && this.pendingApproval) {
      this._emitControlResponse(this.pendingApproval.requestId, 'deny');
    }

    this.endSession('stop');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Teardown

  endSession(reason) {
    if (this.destroyed) return;
    this.destroyed = true;

    logger.info({ sessionId: this.id, reason }, 'Ending session');

    // 1. Exactly-once deny if approval pending
    if (this.state === 'AWAITING_APPROVAL' && this.pendingApproval &&
        this.lastRespondedRequestId !== this.pendingApproval.requestId) {
      this._emitControlResponse(this.pendingApproval.requestId, 'deny');
    }

    // 2. Clear all timers
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.orphanTimer);
    clearTimeout(this.backpressureStallTimer);
    clearTimeout(this.dbFlushTimeout);
    clearTimeout(this.disconnectedApprovalTimer);
    clearInterval(this.drainInterval);

    // 3. Final DB flush + session end record
    this._flushDbBatch();
    try {
      db.updateSessionEnd(this.id, reason);
      db.insertAuditLog(this.id, this.rootMessageId, 'session_end', { reason });
    } catch {}

    // 4. Schedule WAL checkpoint (non-blocking, rate-limited)
    setImmediate(() => {
      try { require('./wal').maybeCheckpointWal(); } catch {}
    });

    // 5. Kill caffeinate (SIGKILL — ignores SIGTERM under load)
    if (this.caffeinateProc) {
      try { this.caffeinateProc.kill('SIGKILL'); } catch {}
      this.caffeinateProc = null;
    }

    // 6. Kill claude process (node-pty: .kill(); child_process would use process.kill(-pid))
    if (this.proc) {
      try {
        if (typeof this.proc.kill === 'function') {
          this.proc.kill('SIGTERM');
        } else {
          process.kill(-this.proc.pid, 'SIGTERM');
        }
      } catch {}
      const procRef = this.proc;
      setTimeout(() => {
        try {
          if (typeof procRef.kill === 'function') procRef.kill('SIGKILL');
          else process.kill(-procRef.pid, 'SIGKILL');
        } catch {}
      }, 5000).unref();
      this.proc = null;
    }

    // 7. Emit exit
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._send(this._buildEnvelope({ type: 'exit', payload: { reason } }));
    }

    // 8. State + SessionManager cleanup
    this.state = 'IDLE';
    sessionManager.remove(this.id);
    sessionManager.releaseController(this.id);

    // 9. Null large buffers
    this.ring = [];
    this.outputBuffer = null;
    this.pendingDbWrites = null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message helpers

  _buildEnvelope(msg) {
    return {
      v: PROTOCOL_VERSION,
      type: msg.type,
      seq: msg.seq || null,
      sessionId: this.id,
      rootMessageId: this.rootMessageId,
      messageId: crypto.randomUUID(),
      ts: Date.now(),
      payload: msg.payload || null,
      controllerEpoch: null,
    };
  }

  _send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.debug({ err, sessionId: this.id }, 'WS send failed');
    }
  }

  // Handle client_error telemetry
  handleClientError(rootMessageId, error, context, uiBuildVersion) {
    if (this.destroyed) return;
    if (this.clientErrorCount >= CLIENT_ERRORS_MAX) return; // rate limit

    this.clientErrorCount++;

    try {
      db.insertClientError(this.id, rootMessageId, error, context, uiBuildVersion);
      logger.warn({
        sessionId: this.id,
        rootMessageId,
        error,
        uiBuildVersion,
      }, 'Client error reported');
    } catch {}
  }
}

module.exports = Session;
