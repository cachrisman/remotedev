'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const { validateProjectPath } = require('../path-validator');

let allowedRoot;
let gitRepoDir;

function runGit(cwd, args) {
  spawnSync('git', args, { cwd, encoding: 'utf8' });
}

before(() => {
  allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-allowed-'));
  gitRepoDir = path.join(allowedRoot, 'my-repo');
  fs.mkdirSync(gitRepoDir, { recursive: true });
  runGit(gitRepoDir, ['init']);
});

after(() => {
  try { fs.rmSync(allowedRoot, { recursive: true }); } catch {}
});

describe('validateProjectPath', () => {
  const resolvedRoots = [fs.realpathSync(allowedRoot)];

  it('returns PATH_NOT_FOUND for non-existent path', () => {
    const result = validateProjectPath(path.join(allowedRoot, 'does-not-exist'), resolvedRoots);
    assert.equal(result.safe, false);
    assert.equal(result.error, 'PATH_NOT_FOUND');
  });

  it('returns PATH_NOT_FOUND when path is a file not a directory', () => {
    const filePath = path.join(allowedRoot, 'file.txt');
    fs.writeFileSync(filePath, 'x');
    try {
      const result = validateProjectPath(filePath, resolvedRoots);
      assert.equal(result.safe, false);
      assert.equal(result.error, 'PATH_NOT_FOUND');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('returns NOT_WITHIN_ALLOWED_ROOTS for path outside allowed root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      const result = validateProjectPath(outside, resolvedRoots);
      assert.equal(result.safe, false);
      assert.equal(result.error, 'NOT_WITHIN_ALLOWED_ROOTS');
    } finally {
      try { fs.rmSync(outside, { recursive: true }); } catch {}
    }
  });

  it('returns NOT_A_GIT_REPO for directory that is not a git repo', () => {
    const notGit = path.join(allowedRoot, 'not-git');
    fs.mkdirSync(notGit, { recursive: true });
    const result = validateProjectPath(notGit, resolvedRoots);
    assert.equal(result.safe, false);
    assert.equal(result.error, 'NOT_A_GIT_REPO');
  });

  it('returns safe and resolvedPath for valid git repo under allowed root', () => {
    const result = validateProjectPath(gitRepoDir, resolvedRoots);
    assert.equal(result.safe, true);
    assert.ok(result.resolvedPath);
    assert.ok(result.resolvedPath.includes('my-repo'));
  });
});
