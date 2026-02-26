'use strict';

const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { WebSocket } = require('ws');

const logger = require('./logger');
const db = require('./db');
const NdjsonFramer = require('./ndjson-framer');
const sessionManager = require('./session-manager');
const { validatePath } = require('./path-validator');

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

class Session {
  constructor(id, name, workingDir) {
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

    db.insertSession(id, name, workingDir);
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

    this.proc = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--allowedTools', 'all',
      instruction,
    ], {
      cwd: this.resolvedWorkingDir || this.workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    this.state = 'RUNNING';
    db.updateSessionState(this.id, 'RUNNING');
    db.insertAuditLog(this.id, this.rootMessageId, 'session_start', {
      instruction: instruction.slice(0, 500),
    });

    logger.info({
      sessionId: this.id,
      pid: this.proc.pid,
      rootMessageId: this.rootMessageId,
    }, 'Claude process spawned');

    this.proc.stdout.on('data', (chunk) => {
      if (this.destroyed) return;
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

  // ──────────────────────────────────────────────────────────────────────────
  // NDJSON line handling

  _onNdjsonLine(line) {
    if (this.destroyed) return;

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

    // Send to subprocess stdin
    if (this.proc && !this.proc.killed && this.proc.stdin.writable) {
      try {
        this.proc.stdin.write(JSON.stringify({
          type: 'control_response',
          requestId,
          decision,
        }) + '\n');
      } catch {}
    }

    this.pendingApproval = null;
    this.state = this.proc && !this.proc.killed ? 'RUNNING' : 'IDLE';
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

    // 6. Kill process group
    if (this.proc && !this.proc.killed) {
      try { process.kill(-this.proc.pid, 'SIGTERM'); } catch {}
      const procRef = this.proc;
      setTimeout(() => {
        try {
          if (!procRef.killed) process.kill(-procRef.pid, 'SIGKILL');
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
