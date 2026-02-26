'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { validatePath, resolveAllowedRoots } = require('../path-validator');

describe('validatePath', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-test-'));
  const resolvedRoots = [tmpDir];

  it('accepts path within allowed root', () => {
    const result = validatePath('subdir/file.js', tmpDir, resolvedRoots);
    assert.equal(result.safe, true);
    assert.ok(result.fullResolved.startsWith(tmpDir));
  });

  it('rejects path outside allowed root', () => {
    const result = validatePath('/etc/passwd', tmpDir, resolvedRoots);
    assert.equal(result.safe, false);
  });

  it('rejects path traversal via ..', () => {
    const result = validatePath('../../etc/passwd', tmpDir, resolvedRoots);
    assert.equal(result.safe, false);
  });

  it('handles non-existent path (ancestor validation)', () => {
    const result = validatePath('does-not-exist/file.txt', tmpDir, resolvedRoots);
    assert.equal(result.safe, true);
    assert.ok(result.fullResolved.includes('does-not-exist'));
  });

  it('handles symlink that resolves to longer path', () => {
    // Create a symlink inside tmpDir pointing to a subdirectory also inside tmpDir
    const target = path.join(tmpDir, 'actual-dir');
    const link = path.join(tmpDir, 'link-dir');
    fs.mkdirSync(target, { recursive: true });
    try {
      fs.symlinkSync(target, link);
    } catch {
      // Symlink may already exist
    }

    const result = validatePath('link-dir/file.txt', tmpDir, resolvedRoots);
    assert.equal(result.safe, true);
  });

  it('rejects invalid path argument', () => {
    const result = validatePath(null, tmpDir, resolvedRoots);
    assert.equal(result.safe, false);
  });

  it('rejects path that escapes via symlink to outside root', () => {
    // Create a symlink pointing outside tmpDir
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const evilLink = path.join(tmpDir, 'evil-link');
    try {
      fs.symlinkSync(outsideDir, evilLink);
    } catch {}

    const evilRoots = [tmpDir]; // outsideDir NOT in roots
    const result = validatePath('evil-link/file.txt', tmpDir, evilRoots);
    assert.equal(result.safe, false);
  });

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

describe('resolveAllowedRoots', () => {
  it('resolves existing directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-root-'));
    const roots = resolveAllowedRoots([tmpDir]);
    assert.equal(roots.length, 1);
    assert.ok(roots[0].startsWith('/'));
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('falls back lexically for non-existent roots', () => {
    const roots = resolveAllowedRoots(['/nonexistent/path']);
    assert.equal(roots[0], '/nonexistent/path');
  });
});
