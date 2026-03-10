'use strict';

const db = require('./db');
const gitHelper = require('./git');
const logger = require('./logger');
const sessionManager = require('./session-manager');

const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours
const CHECK_INTERVAL_MS = 5 * 60 * 1000;     // 5 minutes

/**
 * Run checkpoint for a chat: make repo safe then set PAUSED.
 * Only call when session.state is IDLE and chat is ACTIVE.
 */
function runCheckpoint(sessionId) {
  const row = db.getSessionRow(sessionId);
  if (!row || !row.project_path) return;
  const workingDir = row.project_path;
  const status = gitHelper.getRepoStatus(workingDir);
  if (!status.isGitRepo) {
    db.updateSessionChatFields(sessionId, { chat_status: 'PAUSED', paused_at: Date.now() });
    db.insertAuditLog(sessionId, null, 'checkpoint_skip', { reason: 'not_git_repo' });
    return;
  }
  const safe = !status.hasStaged && !status.hasUnstaged && status.untrackedNotIgnoredFiles.length === 0;
  let checkpointType = 'none';
  let checkpointRef = null;
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const message = `checkpoint(chat:${sessionId}) ${iso}`;

  if (!safe) {
    const risky = gitHelper.isRiskyForCheckpoint(workingDir);
    if (risky) {
      const ok = gitHelper.stashAll(workingDir, message, true);
      if (ok) {
        const list = gitHelper.git(workingDir, ['stash', 'list', '--format=%gd', '-n', '1']);
        checkpointRef = list.stdout ? list.stdout.trim() : null;
        checkpointType = 'stash';
      }
    } else {
      const ok = gitHelper.commitAll(workingDir, message);
      if (ok) {
        const rev = gitHelper.git(workingDir, ['rev-parse', 'HEAD']);
        checkpointRef = rev.stdout ? rev.stdout.trim() : null;
        checkpointType = 'commit';
      } else {
        const stashOk = gitHelper.stashAll(workingDir, message, true);
        if (stashOk) {
          const list = gitHelper.git(workingDir, ['stash', 'list', '--format=%gd', '-n', '1']);
          checkpointRef = list.stdout ? list.stdout.trim() : null;
          checkpointType = 'stash';
        }
      }
    }
  }

  db.updateSessionChatFields(sessionId, {
    chat_status: 'PAUSED',
    paused_at: now,
    checkpoint_type: checkpointType,
    checkpoint_ref: checkpointRef,
    checkpoint_at: now,
  });
  db.insertAuditLog(sessionId, null, checkpointType === 'commit' ? 'checkpoint_commit' : checkpointType === 'stash' ? 'checkpoint_stash' : 'checkpoint_skip', {
    checkpointType,
    checkpointRef,
  });
  logger.info({ sessionId, checkpointType, checkpointRef }, 'Idle checkpoint completed');
}

/**
 * Start the idle-check interval. Call once from index.js after DB is open.
 */
function startIdleCheckInterval() {
  setInterval(() => {
    const now = Date.now();
    const cutoff = now - IDLE_TIMEOUT_MS;
    for (const session of sessionManager.allSessions()) {
      if (session.destroyed) continue;
      if (session.state !== 'IDLE') continue; // only checkpoint when execution state is IDLE
      const row = db.getSessionRow(session.id);
      if (!row || row.chat_status !== 'ACTIVE') continue;
      const lastActivity = row.last_activity_at;
      if (!lastActivity || lastActivity > cutoff) continue;
      runCheckpoint(session.id);
    }
  }, CHECK_INTERVAL_MS).unref();
  logger.info({ intervalMs: CHECK_INTERVAL_MS, idleTimeoutMs: IDLE_TIMEOUT_MS }, 'Idle checkpoint interval started');
}

module.exports = { runCheckpoint, startIdleCheckInterval };
