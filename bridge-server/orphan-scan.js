'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const logger = require('./logger');
const sessionManager = require('./session-manager');

const ORPHAN_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const MIN_PROC_AGE_S = 10; // skip processes younger than 10 seconds

/**
 * Scan for orphaned claude processes (spawned by remotedev but not tracked in SessionManager).
 *
 * Uses REMOTEDEV_SESSION_ID environment variable on spawned processes to identify
 * processes that belong to remotedev, avoiding false positives from other claude instances.
 */
function scanOrphans() {
  const activePids = new Set(
    sessionManager.allSessions()
      .filter(s => s.proc && !s.proc.killed)
      .map(s => s.proc.pid)
      .filter(Boolean)
  );

  try {
    // Find PIDs with REMOTEDEV_SESSION_ID in their environment
    const orphanPids = findRemotedevPids(activePids);

    for (const pid of orphanPids) {
      try {
        process.kill(-pid, 'SIGKILL');
        logger.warn({ pid }, 'Orphan claude process killed by scan');
      } catch (err) {
        // Process may have already exited
        logger.debug({ pid, err: err.message }, 'Could not kill orphan (may have exited)');
      }
    }

    if (orphanPids.length > 0) {
      logger.info({ count: orphanPids.length }, 'Orphan scan complete');
    }
  } catch (err) {
    logger.debug({ err }, 'Orphan scan error');
  }
}

/**
 * Find PIDs that have REMOTEDEV_SESSION_ID in their environment but are not
 * tracked in SessionManager.
 */
function findRemotedevPids(activePids) {
  const orphans = [];

  // Try Linux /proc first, fall back to ps-based approach
  if (fs.existsSync('/proc')) {
    return findOrphansViaProc(activePids);
  }

  // macOS: use ps to find candidate claude processes, then check environment
  return findOrphansViaPs(activePids);
}

function findOrphansViaProc(activePids) {
  const orphans = [];

  try {
    const pids = fs.readdirSync('/proc')
      .filter(d => /^\d+$/.test(d))
      .map(Number)
      .filter(pid => !activePids.has(pid));

    for (const pid of pids) {
      try {
        const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
        if (!environ.includes('REMOTEDEV_SESSION_ID=')) continue;

        // Check process age (skip if <10s old)
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Field 22 is starttime in clock ticks
        const fields = stat.split(' ');
        const startTimeTicks = parseInt(fields[21] || '0', 10);
        const clkTck = 100; // typically 100 on Linux
        const uptimeS = parseInt(
          fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0], 10
        );
        const procAgeS = uptimeS - (startTimeTicks / clkTck);
        if (procAgeS < MIN_PROC_AGE_S) continue;

        // Check it's actually a claude process
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmdline.includes('claude')) continue;

        orphans.push(pid);
      } catch {
        // Process may have exited during scan — skip
      }
    }
  } catch {}

  return orphans;
}

function findOrphansViaPs(activePids) {
  const orphans = [];

  try {
    // Get all claude processes with output-format stream-json
    const output = execSync(
      "ps -eo pid,etime,command | grep 'claude.*--output-format stream-json' | grep -v grep",
      { encoding: 'utf8', timeout: 5000 }
    );

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (isNaN(pid) || activePids.has(pid)) continue;

      // Parse elapsed time to check age (skip if <10s)
      const elapsed = parts[1] || '';
      const ageS = parseElapsedSeconds(elapsed);
      if (ageS < MIN_PROC_AGE_S) continue;

      // Verify REMOTEDEV_SESSION_ID via environment (macOS lsof/ps -E)
      try {
        const envOut = execSync(`ps -p ${pid} -E -o command 2>/dev/null || true`,
          { encoding: 'utf8', timeout: 2000 });
        if (!envOut.includes('REMOTEDEV_SESSION_ID=')) continue;
      } catch {
        // If we can't check env, err on the side of caution and skip
        continue;
      }

      orphans.push(pid);
    }
  } catch {
    // pgrep returns non-zero if no matches — not an error
  }

  return orphans;
}

function parseElapsedSeconds(elapsed) {
  // ps etime format: [[DD-]HH:]MM:SS
  if (!elapsed) return 0;
  const parts = elapsed.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function startOrphanScan() {
  scanOrphans(); // run at startup
  const interval = setInterval(scanOrphans, ORPHAN_SCAN_INTERVAL_MS);
  interval.unref();
  return interval;
}

module.exports = { scanOrphans, startOrphanScan };
