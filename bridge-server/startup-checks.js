'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

const CERT_WARN_DAYS = [14, 7, 3];
const CERT_REFUSE_HOURS = 24;
const DISK_WARN_MB = 500;
const CLAUDE_MIN_VERSION = process.env.CLAUDE_MIN_VERSION || '0.0.0';

/**
 * Check TLS certificate expiry.
 * Warns at 14/7/3 days; refuses to start if <24h.
 */
function checkCertExpiry(certPath) {
  if (!certPath || !fs.existsSync(certPath)) return;

  try {
    const output = execSync(
      `openssl x509 -enddate -noout -in "${certPath}"`,
      { encoding: 'utf8', timeout: 5000 }
    );
    // e.g. "notAfter=Mar 15 12:00:00 2025 GMT"
    const match = output.match(/notAfter=(.+)/);
    if (!match) return;

    const expiryDate = new Date(match[1]);
    const now = new Date();
    const hoursRemaining = (expiryDate - now) / (1000 * 60 * 60);
    const daysRemaining = hoursRemaining / 24;

    if (hoursRemaining <= 0) {
      logger.fatal({ certPath, expiryDate }, 'TLS certificate has EXPIRED — refusing to start');
      process.exit(1);
    }

    if (hoursRemaining < CERT_REFUSE_HOURS) {
      logger.fatal({ certPath, expiryDate, hoursRemaining: Math.floor(hoursRemaining) },
        'TLS certificate expires in <24h — refusing to start');
      process.exit(1);
    }

    for (const days of CERT_WARN_DAYS) {
      if (daysRemaining < days) {
        logger.warn({ certPath, daysRemaining: Math.floor(daysRemaining) },
          `TLS certificate expires in <${days} days`);
        break;
      }
    }

    logger.info({ certPath, daysRemaining: Math.floor(daysRemaining) }, 'TLS cert OK');
  } catch (err) {
    logger.warn({ err, certPath }, 'Could not check cert expiry');
  }
}

/**
 * Check claude CLI version.
 * Logs version; exits if below minimum.
 */
function checkClaudeVersion() {
  try {
    const output = execSync('claude --version', { encoding: 'utf8', timeout: 10000 }).trim();
    logger.info({ version: output, minVersion: CLAUDE_MIN_VERSION }, 'claude CLI version');

    if (CLAUDE_MIN_VERSION !== '0.0.0') {
      const [minMaj, minMin, minPatch] = CLAUDE_MIN_VERSION.split('.').map(Number);
      const versionMatch = output.match(/(\d+)\.(\d+)\.(\d+)/);
      if (versionMatch) {
        const [, maj, min, patch] = versionMatch.map(Number);
        if (
          maj < minMaj ||
          (maj === minMaj && min < minMin) ||
          (maj === minMaj && min === minMin && patch < minPatch)
        ) {
          logger.fatal({ version: output, minVersion: CLAUDE_MIN_VERSION },
            'claude CLI version below minimum — refusing to start');
          process.exit(1);
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Could not check claude version');
  }
}

/**
 * Check available disk space.
 * Warns if <500MB.
 */
function checkDiskSpace(dir) {
  try {
    const output = execSync(`df -m "${dir}" | tail -1`, { encoding: 'utf8', timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    const availMb = parseInt(parts[3], 10);

    if (!isNaN(availMb) && availMb < DISK_WARN_MB) {
      logger.warn({ availMb, dir }, `Disk space low: ${availMb}MB available`);
    } else {
      logger.info({ availMb, dir }, 'Disk space OK');
    }
  } catch (err) {
    logger.debug({ err }, 'Could not check disk space');
  }
}

/**
 * Run all startup checks.
 */
function runStartupChecks({ certPath, dbDir }) {
  logger.info('Running startup checks');
  checkClaudeVersion();
  if (certPath) checkCertExpiry(certPath);
  checkDiskSpace(dbDir || process.env.HOME || '/tmp');
  logger.info('Startup checks complete');
}

module.exports = { runStartupChecks, checkCertExpiry, checkClaudeVersion, checkDiskSpace };
