'use strict';

/**
 * Session FSM unit tests — exercises the internal state machine, backpressure
 * timers, parse-degraded logic, approval TTL, and endSession idempotency.
 *
 * Strategy: stub out all I/O dependencies (db, sessionManager, node-pty,
 * child_process) via require.cache before loading session.js, then create
 * Session instances with fake WebSocket / process objects.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// Dependency stubs (must be installed before requiring session.js)

// Use a real temp SQLite DB so db.js works without mocking.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-fsm-test-'));
process.env.REMOTEDEV_DB_DIR = tmpDir;

// Ensure db is opened before session.js requires it.
const db = require('../db');
db.openDb();

// Stub node-pty so tests never try to spawn a real PTY.
require.cache[require.resolve('node-pty')] = {
  id: require.resolve('node-pty'),
  filename: require.resolve('node-pty'),
  loaded: true,
  exports: {
    spawn: () => { throw new Error('PTY spawn stubbed in tests'); },
  },
};

// Now load Session (after stubs are in place).
const Session = require('../session');

afterEach(() => {
  // Clean up temp dir after all tests
});

// Final cleanup
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

/** Create a minimal fake WebSocket with a sent-messages log. */
function makeMockWs(overrides = {}) {
  const sent = [];
  return {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send(data) { sent.push(JSON.parse(data)); },
    close(code, reason) { this._closedWith = { code, reason }; this.readyState = 3; },
    terminate() { this.readyState = 3; },
    _sent: sent,
    ...overrides,
  };
}

/** Create a Session wired up with a mock WS, ready for logic tests. */
function makeSession(overrides = {}) {
  const id = crypto.randomUUID();
  const session = new Session(id, 'test', '/tmp');
  const ws = makeMockWs(overrides.ws);
  session.attachWs(ws);
  // Give it a rootMessageId so db writes don't fail on NOT NULL constraint.
  session.rootMessageId = crypto.randomUUID();
  return { session, ws, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests

describe('Session.endSession()', () => {
  it('is idempotent — second call is a no-op', () => {
    const { session } = makeSession();
    session.endSession('test');
    assert.equal(session.destroyed, true);
    // Must not throw, must not change destroyed state
    assert.doesNotThrow(() => session.endSession('second-call'));
    assert.equal(session.destroyed, true);
  });

  it('sets destroyed=true and removes from sessionManager', () => {
    const { session, id } = makeSession();
    const sessionManager = require('../session-manager');
    sessionManager.setController(id);
    assert.equal(session.destroyed, false);
    session.endSession('test');
    assert.equal(session.destroyed, true);
  });

  it('sends exit message to open WS', () => {
    const { session, ws } = makeSession();
    session.endSession('test-reason');
    const exits = ws._sent.filter(m => m.type === 'exit');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].payload.reason, 'test-reason');
  });

  it('does not throw when ws is null', () => {
    const { session } = makeSession();
    session.ws = null;
    assert.doesNotThrow(() => session.endSession('no-ws'));
  });
});

describe('Parse degraded mode', () => {
  it('enters parse_degraded after 5 consecutive parse errors', () => {
    const { session, ws } = makeSession();
    assert.equal(session.parseDegraded, false);

    for (let i = 0; i < 5; i++) {
      session._onNdjsonLine('this is not valid json @@@@');
    }

    assert.equal(session.parseDegraded, true);
    assert.equal(session.consecutiveParseErrors, 5);

    const warnings = ws._sent.filter(
      m => m.type === 'bridge_warning' && m.payload?.subtype === 'parse_degraded'
    );
    assert.equal(warnings.length, 1, 'Expected exactly one parse_degraded warning');
  });

  it('resets consecutiveParseErrors on a valid JSON line', () => {
    const { session } = makeSession();
    for (let i = 0; i < 4; i++) {
      session._onNdjsonLine('not json');
    }
    assert.equal(session.consecutiveParseErrors, 4);

    // Valid JSON line resets the counter
    session._onNdjsonLine(JSON.stringify({ type: 'text', text: 'hello' }));
    assert.equal(session.consecutiveParseErrors, 0);
    assert.equal(session.parseDegraded, false);
  });

  it('reaches parse_fatal after 20 raw non-JSON lines post-degraded', () => {
    const { session } = makeSession();

    // Enter degraded mode (5 errors)
    for (let i = 0; i < 5; i++) {
      session._onNdjsonLine('bad json #' + i);
    }
    assert.equal(session.parseDegraded, true);
    assert.equal(session.destroyed, false);

    // Feed 20 more raw lines to hit PARSE_FATAL_THRESHOLD
    for (let i = 0; i < 20; i++) {
      session._onNdjsonLine('raw line ' + i);
    }

    assert.equal(session.destroyed, true, 'Session should be destroyed after parse_fatal');
  });

  it('does not emit parse_degraded warning twice', () => {
    const { session, ws } = makeSession();

    // First 5 bad lines trigger the warning and enter degraded mode
    for (let i = 0; i < 10; i++) {
      session._onNdjsonLine('still bad json');
    }

    const warnings = ws._sent.filter(
      m => m.type === 'bridge_warning' && m.payload?.subtype === 'parse_degraded'
    );
    assert.equal(warnings.length, 1, 'Warning must fire exactly once');
  });
});

describe('Backpressure timers', () => {
  it('emits client_slow warning after 30s stall', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const { session, ws } = makeSession();
    // Manually set backpressurePausedAt to "now" (faked epoch 0)
    session.backpressurePausedAt = Date.now();
    session._startBackpressureTimers();

    // Advance time to just past the WARN threshold (30 000 ms)
    t.mock.timers.tick(30_001);

    const warnings = ws._sent.filter(
      m => m.type === 'bridge_warning' && m.payload?.subtype === 'client_slow'
    );
    assert.equal(warnings.length, 1, 'Expected exactly one client_slow warning');
    // Session must still be alive (not killed yet)
    assert.equal(session.destroyed, false);

    session.endSession('cleanup');
  });

  it('closes WS with 1011 after 60s stall, session stays RUNNING', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const { session, ws } = makeSession();
    session.state = 'RUNNING';
    session.backpressurePausedAt = Date.now();
    session._startBackpressureTimers();

    // Advance past the KILL threshold (60 000 ms). The first tick at 30s fires
    // the WARN timer which then reschedules; tick the remaining 30s.
    t.mock.timers.tick(60_001);

    assert.equal(ws._closedWith?.code, 1011, 'WS should be closed with code 1011');
    // Session must NOT be destroyed — gap recovery keeps it alive
    assert.equal(session.destroyed, false, 'Session should stay alive after backpressure close');
    assert.equal(session.state, 'RUNNING', 'Session state should remain RUNNING');

    // Null out ws so endSession cleanup doesn't try to send on closed socket
    session.ws = null;
    session.endSession('cleanup');
  });
});

describe('Approval TTL during DISCONNECTED', () => {
  /** Add a minimal mock proc so _emitControlResponse doesn't early-return. */
  function attachMockProc(session) {
    const written = [];
    session.proc = {
      _written: written,
      stdin: { writable: true, write(data) { written.push(data); } },
    };
    session._isPty = false;
    return written;
  }

  it('auto-denies pending approval when TTL expires while disconnected', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const { session } = makeSession();
    const requestId = crypto.randomUUID();
    attachMockProc(session);

    // Put session into AWAITING_APPROVAL
    session.state = 'AWAITING_APPROVAL';
    session.pendingApproval = {
      requestId,
      data: { type: 'tool_use', id: requestId, name: 'Bash', input: { command: 'rm -rf /' } },
      expiresAt: Date.now() + 60_000, // 60s TTL
    };

    // Simulate WS disconnect
    session.onDisconnect(false);
    assert.equal(session.state, 'DISCONNECTED');
    assert.ok(session.pendingApproval, 'Approval must be preserved on disconnect');

    // Advance time past the TTL
    t.mock.timers.tick(60_001);

    // The disconnectedApprovalTimer should have fired and denied the approval.
    // _emitControlResponse clears pendingApproval after writing to stdin.
    assert.equal(session.pendingApproval, null, 'Approval should be cleared after TTL expiry');
  });

  it('does not fire TTL deny if already expired at disconnect time', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const { session } = makeSession();
    const requestId = crypto.randomUUID();
    attachMockProc(session);

    session.state = 'AWAITING_APPROVAL';
    session.pendingApproval = {
      requestId,
      data: { type: 'tool_use', id: requestId, name: 'Bash', input: {} },
      expiresAt: Date.now() - 1, // already expired
    };

    // onDisconnect should immediately deny (not schedule a timer)
    session.onDisconnect(false);

    // No timer needed — pendingApproval is cleared immediately
    assert.equal(session.pendingApproval, null, 'Approval should be immediately denied when already expired');
  });
});
