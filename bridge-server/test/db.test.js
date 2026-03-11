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

describe('db projects and chat fields', () => {
  it('insertProject and listProjects', () => {
    const projectPath = path.join(tmpDir, 'proj-' + crypto.randomUUID().slice(0, 8));
    db.insertProject(projectPath);
    const list = db.listProjects();
    assert.ok(Array.isArray(list));
    assert.ok(list.some(p => p.project_path === projectPath));
  });

  it('updateProjectLastUsed does not throw', () => {
    const projectPath = path.join(tmpDir, 'proj-lastused');
    db.insertProject(projectPath);
    assert.doesNotThrow(() => db.updateProjectLastUsed(projectPath));
  });

  it('insertSession with chat opts and listChatsByProject', () => {
    const projectPath = path.join(tmpDir, 'chat-proj');
    const sessionId = crypto.randomUUID();
    db.insertProject(projectPath);
    db.insertSession(sessionId, 'chat-test', projectPath, {
      projectPath,
      chatStatus: 'ACTIVE',
      primaryBranch: 'main',
      currentBranch: 'main',
    });
    const chats = db.listChatsByProject(projectPath);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].id, sessionId);
    assert.equal(chats[0].chat_status, 'ACTIVE');
    assert.equal(chats[0].current_branch, 'main');
  });

  it('getSessionRow returns chat columns', () => {
    const projectPath = path.join(tmpDir, 'getrow-proj');
    const sessionId = crypto.randomUUID();
    db.insertSession(sessionId, 'row-test', projectPath, {
      projectPath,
      primaryBranch: 'feature/x',
      currentBranch: 'feature/x',
    });
    const row = db.getSessionRow(sessionId);
    assert.ok(row);
    assert.equal(row.project_path, projectPath);
    assert.equal(row.primary_branch, 'feature/x');
    assert.equal(row.current_branch, 'feature/x');
  });

  it('isBranchLeasedByOther returns true when another chat has branch', () => {
    const projectPath = path.join(tmpDir, 'lease-proj');
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    db.insertProject(projectPath);
    db.insertSession(id1, 'c1', projectPath, { projectPath, chatStatus: 'ACTIVE', currentBranch: 'branch-a' });
    db.insertSession(id2, 'c2', projectPath, { projectPath, chatStatus: 'PAUSED', currentBranch: 'branch-b' });
    assert.equal(db.isBranchLeasedByOther(projectPath, 'branch-a', id2), true);
    assert.equal(db.isBranchLeasedByOther(projectPath, 'branch-a', id1), false);
    assert.equal(db.isBranchLeasedByOther(projectPath, 'branch-b', id1), false);
  });
});
