'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('./logger');

const DB_DIR = process.env.REMOTEDEV_DB_DIR ||
  path.join(process.env.HOME || '/tmp', '.local', 'share', 'remotedev');
const DB_PATH = path.join(DB_DIR, 'remotedev.db');

// Retention: 30 days
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

let db;

function openDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  try { fs.chmodSync(DB_DIR, 0o700); } catch {}

  db = new Database(DB_PATH);
  try { fs.chmodSync(DB_PATH, 0o600); } catch {}

  // WAL mode for concurrent read/write
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate();
  pruneRetention();

  logger.info({ dbPath: DB_PATH }, 'SQLite opened');
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      working_dir TEXT,
      state TEXT NOT NULL DEFAULT 'IDLE',
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS transcript (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER,
      root_message_id TEXT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS transcript_session_seq
      ON transcript(session_id, seq);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      root_message_id TEXT,
      event TEXT NOT NULL,
      detail TEXT,
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS audit_log_session
      ON audit_log(session_id, ts);

    CREATE TABLE IF NOT EXISTS client_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      root_message_id TEXT,
      error TEXT NOT NULL,
      context TEXT,
      ui_build_version TEXT,
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS client_errors_session
      ON client_errors(session_id, ts);
  `);
}

function pruneRetention() {
  const cutoff = Date.now() - RETENTION_MS;
  const oldSessions = db.prepare(
    `SELECT id FROM sessions WHERE created_at < ?`
  ).all(cutoff).map(r => r.id);

  if (oldSessions.length === 0) return;

  const placeholders = oldSessions.map(() => '?').join(',');
  const deleteTranscript = db.prepare(
    `DELETE FROM transcript WHERE session_id IN (${placeholders})`
  );
  const deleteAuditLog = db.prepare(
    `DELETE FROM audit_log WHERE session_id IN (${placeholders})`
  );
  const deleteClientErrors = db.prepare(
    `DELETE FROM client_errors WHERE session_id IN (${placeholders})`
  );
  const deleteSessions = db.prepare(
    `DELETE FROM sessions WHERE id IN (${placeholders})`
  );

  const runAll = db.transaction((ids) => {
    deleteTranscript.run(...ids);
    deleteAuditLog.run(...ids);
    deleteClientErrors.run(...ids);
    deleteSessions.run(...ids);
  });
  runAll(oldSessions);

  logger.info({ count: oldSessions.length }, 'Pruned old sessions');

  // Reclaim disk space after pruning
  try {
    db.pragma('optimize');
    db.exec('VACUUM');
    logger.info('VACUUM complete after retention pruning');
  } catch (err) {
    logger.warn({ err }, 'VACUUM failed');
  }
}

function insertSession(id, name, workingDir) {
  db.prepare(
    `INSERT INTO sessions (id, name, working_dir, state, created_at)
     VALUES (?, ?, ?, 'IDLE', ?)`
  ).run(id, name, workingDir, Date.now());
}

function updateSessionState(id, state) {
  db.prepare(
    `UPDATE sessions SET state = ? WHERE id = ?`
  ).run(state, id);
}

function updateSessionEnd(id, reason) {
  db.prepare(
    `UPDATE sessions SET state = 'IDLE', ended_at = ?, end_reason = ? WHERE id = ?`
  ).run(Date.now(), reason, id);
}

function insertTranscriptBatch(rows) {
  const insert = db.prepare(
    `INSERT INTO transcript (session_id, seq, root_message_id, type, data, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const runBatch = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(r.sessionId, r.seq, r.rootMessageId, r.type, r.data, r.ts);
    }
  });
  runBatch(rows);
}

function getTranscriptTail(sessionId, { maxRows = 200, maxBytes = 2 * 1024 * 1024 } = {}) {
  const rows = db.prepare(
    `SELECT seq, root_message_id, type, data, ts FROM transcript
     WHERE session_id = ?
     ORDER BY seq DESC
     LIMIT ?`
  ).all(sessionId, maxRows);

  rows.reverse();

  // Trim to maxBytes
  let total = 0;
  const result = [];
  for (const row of rows) {
    const size = row.data.length;
    if (total + size > maxBytes) break;
    total += size;
    result.push(row);
  }
  return result;
}

function countRawStdoutLines(sessionId) {
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM transcript WHERE session_id = ? AND type = 'raw_stdout'`
  ).get(sessionId)?.cnt || 0;
}

function totalTranscriptBytes(sessionId) {
  return db.prepare(
    `SELECT SUM(LENGTH(data)) as total FROM transcript WHERE session_id = ?`
  ).get(sessionId)?.total || 0;
}

function insertAuditLog(sessionId, rootMessageId, event, detail) {
  db.prepare(
    `INSERT INTO audit_log (session_id, root_message_id, event, detail, ts)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, rootMessageId, event, detail ? JSON.stringify(detail) : null, Date.now());
}

function insertClientError(sessionId, rootMessageId, error, context, uiBuildVersion) {
  db.prepare(
    `INSERT INTO client_errors (session_id, root_message_id, error, context, ui_build_version, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, rootMessageId, error, context, uiBuildVersion, Date.now());
}

function countClientErrors(sessionId) {
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM client_errors WHERE session_id = ?`
  ).get(sessionId)?.cnt || 0;
}

function getDb() {
  return db;
}

module.exports = {
  openDb,
  getDb,
  insertSession,
  updateSessionState,
  updateSessionEnd,
  insertTranscriptBatch,
  getTranscriptTail,
  countRawStdoutLines,
  totalTranscriptBytes,
  insertAuditLog,
  insertClientError,
  countClientErrors,
};
