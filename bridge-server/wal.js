'use strict';

const logger = require('./logger');
const sessionManager = require('./session-manager');

const WAL_CHECKPOINT_MIN_INTERVAL_MS = 5 * 60 * 1000; // at most once per 5 min

let lastWalCheckpoint = 0;

/**
 * Schedule a PASSIVE WAL checkpoint (non-blocking, rate-limited).
 * Called via setImmediate after endSession to avoid blocking teardown.
 *
 * PASSIVE mode:
 * - Moves WAL frames to the database without requiring an exclusive lock
 * - Never throws if readers are active
 * - Bounded WAL growth over time
 */
function maybeCheckpointWal() {
  if (sessionManager.activeCount() > 0) return; // defer if sessions still active

  const now = Date.now();
  if (now - lastWalCheckpoint < WAL_CHECKPOINT_MIN_INTERVAL_MS) return;

  lastWalCheckpoint = now;

  try {
    const db = require('./db').getDb();
    if (!db) return;
    db.pragma('wal_checkpoint(PASSIVE)');
    logger.info('WAL checkpoint (PASSIVE) complete');
  } catch (err) {
    logger.warn({ err }, 'WAL checkpoint failed');
  }
}

module.exports = { maybeCheckpointWal };
