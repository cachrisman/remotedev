'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const gitHelper = require('../git');

let tmpDir;

function runGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-git-test-'));
  runGit(tmpDir, ['init']);
  assert.equal(runGit(tmpDir, ['rev-parse', '--is-inside-work-tree']).stdout, 'true');
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

describe('git.getRepoStatus', () => {
  it('returns isGitRepo and currentBranch for clean repo', () => {
    const status = gitHelper.getRepoStatus(tmpDir);
    assert.equal(status.isGitRepo, true);
    assert.ok(typeof status.currentBranch === 'string');
    assert.equal(status.hasStaged, false);
    assert.equal(status.hasUnstaged, false);
    assert.deepEqual(status.untrackedNotIgnoredFiles, []);
  });

  it('reports untracked file', () => {
    const f = path.join(tmpDir, 'untracked.txt');
    fs.writeFileSync(f, 'hello');
    const status = gitHelper.getRepoStatus(tmpDir);
    assert.equal(status.hasUnstaged, false);
    assert.equal(status.untrackedNotIgnoredFiles.length, 1);
    assert.ok(status.untrackedNotIgnoredFiles.includes('untracked.txt') || status.untrackedNotIgnoredFiles.includes(path.basename(f)));
    fs.unlinkSync(f);
  });

  it('reports unstaged change after commit', () => {
    const f = path.join(tmpDir, 'committed.txt');
    fs.writeFileSync(f, 'v1');
    runGit(tmpDir, ['add', 'committed.txt']);
    runGit(tmpDir, ['commit', '-m', 'add file']);
    fs.writeFileSync(f, 'v2');
    const status = gitHelper.getRepoStatus(tmpDir);
    assert.equal(status.hasUnstaged, true);
    assert.ok(status.unstagedFiles.length >= 1);
    runGit(tmpDir, ['checkout', '--', 'committed.txt']);
  });
});

describe('git.assertSafeOrReturnDetails', () => {
  it('returns safe: true for clean repo', () => {
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-git-clean-'));
    try {
      runGit(cleanDir, ['init']);
      const result = gitHelper.assertSafeOrReturnDetails(cleanDir);
      assert.equal(result.safe, true);
    } finally {
      try { fs.rmSync(cleanDir, { recursive: true }); } catch {}
    }
  });

  it('returns safe: false with counts when repo has untracked file', () => {
    const f = path.join(tmpDir, 'gating-untracked.txt');
    fs.writeFileSync(f, 'x');
    try {
      const result = gitHelper.assertSafeOrReturnDetails(tmpDir);
      assert.equal(result.safe, false);
      assert.equal(result.untrackedCount, 1);
      assert.ok(Array.isArray(result.untrackedNotIgnoredFiles));
    } finally {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  it('returns safe: false for non-git directory', () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'remotedev-notgit-'));
    try {
      const result = gitHelper.assertSafeOrReturnDetails(notGit);
      assert.equal(result.safe, false);
      assert.equal(result.isGitRepo, false);
    } finally {
      try { fs.rmSync(notGit, { recursive: true }); } catch {}
    }
  });
});

describe('git.commitAll / stashAll / discardAll', () => {
  it('commitAll stages and commits', () => {
    const f = path.join(tmpDir, 'commitme.txt');
    fs.writeFileSync(f, 'content');
    const ok = gitHelper.commitAll(tmpDir, 'test commit');
    assert.equal(ok, true);
    const after = gitHelper.assertSafeOrReturnDetails(tmpDir);
    assert.equal(after.safe, true);
    runGit(tmpDir, ['reset', '--hard', 'HEAD~1']);
  });

  it('stashAll stashes changes', () => {
    const f = path.join(tmpDir, 'stashme.txt');
    fs.writeFileSync(f, 'stash content');
    const ok = gitHelper.stashAll(tmpDir, 'test stash', true);
    assert.equal(ok, true);
    const after = gitHelper.assertSafeOrReturnDetails(tmpDir);
    assert.equal(after.safe, true);
    runGit(tmpDir, ['stash', 'pop']);
    try { fs.unlinkSync(f); } catch {}
  });

  it('discardAll resets and removes untracked', () => {
    const f = path.join(tmpDir, 'discardme.txt');
    fs.writeFileSync(f, 'discard');
    gitHelper.discardAll(tmpDir);
    const after = gitHelper.getRepoStatus(tmpDir);
    assert.equal(after.untrackedNotIgnoredFiles.length, 0);
    assert.ok(!fs.existsSync(f));
  });
});

describe('git gating flow (integration-style)', () => {
  it('dirty repo yields safe: false with counts; after commitAll repo is safe', () => {
    const f = path.join(tmpDir, 'gating-flow.txt');
    fs.writeFileSync(f, 'dirty');
    const gating = gitHelper.assertSafeOrReturnDetails(tmpDir);
    assert.equal(gating.safe, false);
    assert.ok(gating.unstagedCount >= 0 || gating.untrackedCount >= 1);
    const ok = gitHelper.commitAll(tmpDir, 'gating flow test');
    assert.equal(ok, true);
    const after = gitHelper.assertSafeOrReturnDetails(tmpDir);
    assert.equal(after.safe, true);
    runGit(tmpDir, ['reset', '--hard', 'HEAD~1']);
  });
});

describe('git.isRiskyForCheckpoint', () => {
  it('returns true for .env file', () => {
    const f = path.join(tmpDir, '.env');
    fs.writeFileSync(f, 'SECRET=1');
    try {
      const risky = gitHelper.isRiskyForCheckpoint(tmpDir);
      assert.equal(risky, true);
    } finally {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  it('returns false for normal file in clean repo', () => {
    const risky = gitHelper.isRiskyForCheckpoint(tmpDir);
    assert.equal(risky, false);
  });
});
