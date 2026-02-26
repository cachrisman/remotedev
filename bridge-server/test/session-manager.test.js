'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Use a fresh SessionManager instance per test by resetting module cache
function getSessionManager() {
  // Delete cached module to get fresh instance
  delete require.cache[require.resolve('../session-manager')];
  return require('../session-manager');
}

class MockSession {
  constructor(id) {
    this.id = id;
    this.state = 'IDLE';
    this.proc = null;
  }
}

describe('SessionManager', () => {
  it('creates and retrieves sessions', () => {
    const sm = getSessionManager();
    const id = crypto.randomUUID();
    const session = sm.create(MockSession, id, 'test', '/tmp');
    assert.equal(session.id, id);
    assert.equal(sm.get(id), session);
  });

  it('removes sessions', () => {
    const sm = getSessionManager();
    const id = crypto.randomUUID();
    sm.create(MockSession, id, 'test', '/tmp');
    sm.remove(id);
    assert.equal(sm.get(id), null);
  });

  it('mints unique epochs', () => {
    const sm = getSessionManager();
    const e1 = sm.mintEpoch();
    const e2 = sm.mintEpoch();
    assert.ok(e1);
    assert.ok(e2);
    assert.notEqual(e1, e2);
  });

  it('validates epoch correctly', () => {
    const sm = getSessionManager();
    const epoch = sm.mintEpoch();
    assert.equal(sm.validateEpoch(epoch), true);
    assert.equal(sm.validateEpoch('wrong'), false);
    assert.equal(sm.validateEpoch(null), false);
  });

  it('tracks active count excluding IDLE sessions', () => {
    const sm = getSessionManager();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const s1 = sm.create(MockSession, id1, 'a', '/tmp');
    const s2 = sm.create(MockSession, id2, 'b', '/tmp');
    s1.state = 'RUNNING';
    assert.equal(sm.activeCount(), 1);
    s2.state = 'AWAITING_APPROVAL';
    assert.equal(sm.activeCount(), 2);
    sm.remove(id1);
    assert.equal(sm.activeCount(), 1);
  });

  it('manages controller session lifecycle', () => {
    const sm = getSessionManager();
    assert.equal(sm.hasActiveController(), false);
    sm.setController('session-1');
    assert.equal(sm.hasActiveController(), true);
    sm.releaseController('session-1');
    assert.equal(sm.hasActiveController(), false);
  });

  it('does not release controller if ID does not match', () => {
    const sm = getSessionManager();
    sm.setController('session-1');
    sm.releaseController('session-2'); // wrong ID
    assert.equal(sm.hasActiveController(), true);
  });
});
