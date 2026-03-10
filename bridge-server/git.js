'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const GATING_FILE_LIST_CAP = 200;
const RISKY_FILE_COUNT_THRESHOLD = 200;
const SENSITIVE_PATTERNS = [
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa$/i,
  /id_ed25519$/i,
  /credentials/i,
  /secret/i,
];

/**
 * Run git in workingDir. No shell. Returns { stdout, stderr, status }.
 */
function git(workingDir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: workingDir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return {
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    status: result.status,
  };
}

/**
 * Get repo status for safe-state and UI. Returns:
 * { hasStaged, hasUnstaged, untrackedNotIgnoredFiles, isGitRepo, currentBranch }
 */
function getRepoStatus(workingDir) {
  const isInside = git(workingDir, ['rev-parse', '--is-inside-work-tree']);
  const isGitRepo = isInside.status === 0 && isInside.stdout === 'true';

  let currentBranch = '';
  if (isGitRepo) {
    const branch = git(workingDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    currentBranch = branch.stdout || 'HEAD';
  }

  const unstaged = git(workingDir, ['diff', '--name-only']);
  const staged = git(workingDir, ['diff', '--cached', '--name-only']);
  const untracked = git(workingDir, ['ls-files', '--others', '--exclude-standard']);

  const unstagedList = unstaged.status === 0 ? unstaged.stdout ? unstaged.stdout.split('\n').filter(Boolean) : [] : [];
  const stagedList = staged.status === 0 ? staged.stdout ? staged.stdout.split('\n').filter(Boolean) : [] : [];
  const untrackedList = untracked.status === 0 ? untracked.stdout ? untracked.stdout.split('\n').filter(Boolean) : [] : [];

  return {
    isGitRepo,
    currentBranch,
    hasUnstaged: unstagedList.length > 0,
    hasStaged: stagedList.length > 0,
    unstagedFiles: unstagedList,
    stagedFiles: stagedList,
    untrackedNotIgnoredFiles: untrackedList,
  };
}

/**
 * Safe state (v1): no unstaged tracked changes, no staged changes, no untracked-but-not-ignored files.
 * Returns { safe: true } or { safe: false, ...getRepoStatus(), counts }.
 * For gating_required payload, cap file lists to GATING_FILE_LIST_CAP and set truncated.
 */
function assertSafeOrReturnDetails(workingDir, options = {}) {
  const cap = options.capFileLists ?? GATING_FILE_LIST_CAP;
  const status = getRepoStatus(workingDir);

  if (!status.isGitRepo) {
    return { safe: false, ...status, stagedCount: 0, unstagedCount: 0, untrackedCount: 0 };
  }

  const stagedCount = status.stagedFiles.length;
  const unstagedCount = status.unstagedFiles.length;
  const untrackedCount = status.untrackedNotIgnoredFiles.length;
  const safe = stagedCount === 0 && unstagedCount === 0 && untrackedCount === 0;

  const result = {
    safe,
    ...status,
    stagedCount,
    unstagedCount,
    untrackedCount,
  };

  if (options.capFileLists !== false) {
    result.stagedFiles = status.stagedFiles.slice(0, cap);
    result.unstagedFiles = status.unstagedFiles.slice(0, cap);
    result.untrackedNotIgnoredFiles = status.untrackedNotIgnoredFiles.slice(0, cap);
    result.truncated =
      status.stagedFiles.length > cap ||
      status.unstagedFiles.length > cap ||
      status.untrackedNotIgnoredFiles.length > cap;
  }

  return result;
}

/**
 * Stage all and commit.
 */
function commitAll(workingDir, message) {
  git(workingDir, ['add', '-A']);
  const commit = git(workingDir, ['commit', '-m', message]);
  return commit.status === 0;
}

/**
 * Stash with untracked. git stash push -u -m "message"
 */
function stashAll(workingDir, message, includeUntracked = true) {
  const args = ['stash', 'push', '-m', message];
  if (includeUntracked) args.push('-u');
  const result = git(workingDir, args);
  return result.status === 0;
}

/**
 * Resolve path to absolute within repo; ensure it is under repo root.
 */
function resolvePathInRepo(workingDir, filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(workingDir, filePath);
  const normalized = path.normalize(absolute);
  const repoRoot = path.resolve(workingDir);
  const relative = path.relative(repoRoot, normalized);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return path.join(repoRoot, relative);
}

/**
 * Discard: reset --hard then delete only untracked-not-ignored paths. All deletions restricted to repo root.
 */
function discardAll(workingDir) {
  git(workingDir, ['reset', '--hard']);
  const status = getRepoStatus(workingDir);
  const repoRoot = path.resolve(workingDir);
  for (const filePath of status.untrackedNotIgnoredFiles) {
    const resolved = resolvePathInRepo(workingDir, filePath);
    if (!resolved) continue;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
    } catch (err) {
      // Ignore missing (already removed) or permission errors
    }
  }
}

/**
 * Check if changes are "risky" for auto-commit: sensitive patterns or too many files.
 */
function isRiskyForCheckpoint(workingDir) {
  const status = getRepoStatus(workingDir);
  const allPaths = [
    ...status.stagedFiles,
    ...status.unstagedFiles,
    ...status.untrackedNotIgnoredFiles,
  ];
  if (allPaths.length > RISKY_FILE_COUNT_THRESHOLD) return true;
  for (const p of allPaths) {
    const base = path.basename(p);
    for (const re of SENSITIVE_PATTERNS) {
      if (re.test(base) || re.test(p)) return true;
    }
  }
  return false;
}

module.exports = {
  getRepoStatus,
  assertSafeOrReturnDetails,
  commitAll,
  stashAll,
  discardAll,
  isRiskyForCheckpoint,
  git,
  GATING_FILE_LIST_CAP,
};
