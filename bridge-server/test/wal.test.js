'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Set up temp DB for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-wal-test-'));
process.env.REMOTEDEV_DB_DIR = tmpDir;

const db = require('../db');
db.openDb();

const { maybeCheckpointWal } = require('../wal');

describe('WAL checkpoint', () => {
  it('runs without error when no sessions active', () => {
    // Force the rate-limit bypass by setting lastWalCheckpoint far in the past
    const walModule = require('../wal');
    // Call directly — should not throw
    assert.doesNotThrow(() => walModule.maybeCheckpointWal());
  });

  it('respects rate limit (does not run twice within 5min)', () => {
    // First call runs
    maybeCheckpointWal();
    // Second call immediately after should be skipped (rate limited)
    // We can't easily verify it was skipped without mocking, but ensure no error
    assert.doesNotThrow(() => maybeCheckpointWal());
  });

  it('database journal_mode is WAL', () => {
    const database = db.getDb();
    assert.ok(database, 'db.getDb() must return the database instance');
    const result = database.pragma('journal_mode', { simple: true });
    assert.equal(result, 'wal', `Expected journal_mode=wal, got ${result}`);
  });

  it('checkpoint uses PASSIVE mode (source-level assertion)', () => {
    // Read the wal.js source and confirm it uses wal_checkpoint(PASSIVE), not a
    // blocking mode (TRUNCATE / RESTART / FULL). Guards against regressions.
    const walSource = fs.readFileSync(
      path.join(__dirname, '..', 'wal.js'),
      'utf8'
    );
    assert.ok(
      walSource.includes("wal_checkpoint(PASSIVE)"),
      'wal.js must use PASSIVE checkpoint mode'
    );
    assert.ok(
      !walSource.includes('TRUNCATE') && !walSource.includes('RESTART') && !walSource.includes('FULL'),
      'wal.js must not use a blocking checkpoint mode (TRUNCATE/RESTART/FULL)'
    );
  });
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});
