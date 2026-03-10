'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-db-test-'));
process.env.REMOTEDEV_DB_DIR = tmpDir;

const db = require('../db');

before(() => {
  db.openDb();
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

describe('db.insertSession / updateSessionEnd', () => {
  it('inserts and retrieves session', () => {
    const id = crypto.randomUUID();
    assert.doesNotThrow(() => db.insertSession(id, 'test', '/tmp'));
    assert.doesNotThrow(() => db.updateSessionState(id, 'RUNNING'));
    assert.doesNotThrow(() => db.updateSessionEnd(id, 'stop'));
  });
});

describe('db.insertTranscriptBatch / getTranscriptTail', () => {
  it('batches and retrieves transcript rows', () => {
    const sessionId = crypto.randomUUID();
    db.insertSession(sessionId, 'transcript-test', '/tmp');

    const rows = [];
    for (let i = 1; i <= 10; i++) {
      rows.push({
        sessionId,
        seq: i,
        rootMessageId: null,
        type: 'output',
        data: JSON.stringify({ text: `line ${i}` }),
        ts: Date.now(),
      });
    }
    assert.doesNotThrow(() => db.insertTranscriptBatch(rows));

    const tail = db.getTranscriptTail(sessionId);
    assert.equal(tail.length, 10);
    assert.equal(tail[0].seq, 1);
  });

  it('limits by maxRows', () => {
    const sessionId = crypto.randomUUID();
    db.insertSession(sessionId, 'limit-test', '/tmp');

    const rows = [];
    for (let i = 1; i <= 50; i++) {
      rows.push({
        sessionId, seq: i, rootMessageId: null,
        type: 'output', data: `{"seq":${i}}`, ts: Date.now(),
      });
    }
    db.insertTranscriptBatch(rows);

    const tail = db.getTranscriptTail(sessionId, { maxRows: 10 });
    assert.ok(tail.length <= 10);
  });
});

describe('db.insertAuditLog', () => {
  it('inserts audit log entries', () => {
    const sessionId = crypto.randomUUID();
    db.insertSession(sessionId, 'audit-test', '/tmp');
    assert.doesNotThrow(() => {
      db.insertAuditLog(sessionId, null, 'test_event', { key: 'value' });
    });
  });
});

describe('db.insertClientError / countClientErrors', () => {
  it('inserts and counts client errors', () => {
    const sessionId = crypto.randomUUID();
    db.insertSession(sessionId, 'client-error-test', '/tmp');

    db.insertClientError(sessionId, null, 'ZodError: invalid input', 'state_sync', '1.0.0');
    db.insertClientError(sessionId, null, 'TypeError: cannot read property', 'render', '1.0.0');

    const count = db.countClientErrors(sessionId);
    assert.equal(count, 2);
  });
});
