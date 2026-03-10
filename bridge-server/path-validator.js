'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

let RE2;
try {
  RE2 = require('re2');
} catch {
  RE2 = null; // fall back to native RegExp with timeout guard
}

const REDOS_TIMEOUT_MS = 50;

/**
 * Safe regex execution with timeout fallback.
 * Uses RE2 if available, otherwise executes with a Date.now() deadline.
 */
function safeMatch(pattern, str) {
  if (RE2) {
    const re = new RE2(pattern);
    return re.exec(str);
  }

  // Timeout-guarded fallback
  const re = new RegExp(pattern);
  const start = Date.now();
  try {
    const result = re.exec(str);
    if (Date.now() - start > REDOS_TIMEOUT_MS) return null; // treat as no match
    return result;
  } catch {
    return null;
  }
}

/**
 * Validate and resolve a path against allowed roots.
 *
 * Algorithm (symlink-safe tail computation):
 * 1. Lexically resolve candidate relative to workingDir
 * 2. Walk ancestors upward until we find one that exists (realpathSync succeeds)
 * 3. Compute tail as path.relative(ancestor_lexical, candidate_lexical)
 * 4. Join resolved ancestor + tail → fullResolved
 * 5. Check fullResolved starts with an allowed root (path-boundary-safe)
 *
 * @param {string} rawPath - The path from the tool call (may be relative)
 * @param {string} workingDir - Already-realpathSync'd working directory
 * @param {string[]} resolvedRoots - Already-realpathSync'd allowed roots
 * @returns {{ safe: boolean, fullResolved?: string, error?: string }}
 */
function validatePath(rawPath, workingDir, resolvedRoots) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { safe: false, error: 'invalid_path' };
  }

  const candidateLexical = path.resolve(workingDir, rawPath);

  let current = candidateLexical;
  let iterations = 0;
  const MAX_ITERATIONS = 64;

  while (iterations++ < MAX_ITERATIONS) {
    try {
      const resolvedAncestor = fs.realpathSync(current);

      // Compute non-existent tail safely
      const relativeTail = path.relative(current, candidateLexical);
      const fullResolved = relativeTail
        ? path.join(resolvedAncestor, relativeTail)
        : resolvedAncestor;

      // Check against allowed roots (path-component boundary)
      const allowed = resolvedRoots.some(root =>
        fullResolved === root ||
        fullResolved.startsWith(root + path.sep)
      );

      return { safe: allowed, fullResolved };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        return { safe: false, error: e.message };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { safe: false, error: 'no_existing_ancestor' };
      }
      current = parent;
    }
  }

  return { safe: false, error: 'too_many_ancestors' };
}

/**
 * Resolve ALLOWED_ROOTS at startup, handling symlinks.
 * @param {string[]} roots - Raw root paths from config
 * @returns {string[]} - Resolved real paths
 */
function resolveAllowedRoots(roots) {
  return roots.map(r => {
    try {
      return fs.realpathSync(r);
    } catch {
      return path.resolve(r); // lexical fallback if root doesn't exist yet
    }
  });
}

/**
 * Validate a path for add_project: must be an existing directory, under allowed roots, and a git repo.
 * No ancestor walk — the exact path must exist.
 * @param {string} rawPath - User-supplied path (absolute or relative to cwd)
 * @param {string[]} resolvedRoots - Already-realpathSync'd allowed roots
 * @returns {{ safe: boolean, resolvedPath?: string, error?: 'PATH_NOT_FOUND'|'NOT_WITHIN_ALLOWED_ROOTS'|'NOT_A_GIT_REPO' }}
 */
function validateProjectPath(rawPath, resolvedRoots) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { safe: false, error: 'PATH_NOT_FOUND' };
  }
  const normalized = path.normalize(rawPath);
  const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      return { safe: false, error: 'PATH_NOT_FOUND' };
    }
    return { safe: false, error: 'PATH_NOT_FOUND' };
  }
  if (!stat.isDirectory()) {
    return { safe: false, error: 'PATH_NOT_FOUND' };
  }
  let resolvedPath;
  try {
    resolvedPath = fs.realpathSync(absolute);
  } catch (e) {
    return { safe: false, error: 'PATH_NOT_FOUND' };
  }
  const allowed = resolvedRoots.some(root =>
    resolvedPath === root || resolvedPath.startsWith(root + path.sep)
  );
  if (!allowed) {
    return { safe: false, error: 'NOT_WITHIN_ALLOWED_ROOTS' };
  }
  const gitResult = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: resolvedPath,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (gitResult.status !== 0 || (gitResult.stdout || '').trim() !== 'true') {
    return { safe: false, error: 'NOT_A_GIT_REPO' };
  }
  return { safe: true, resolvedPath };
}

module.exports = { validatePath, validateProjectPath, resolveAllowedRoots, safeMatch };
