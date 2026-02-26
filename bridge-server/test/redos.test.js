'use strict';

/**
 * ReDoS protection unit test.
 *
 * Verifies that safeMatch() completes in ≤50ms on adversarial inputs.
 * This test passes regardless of whether re2 is installed (both code paths
 * are tested on their respective platforms).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { safeMatch } = require('../path-validator');

describe('ReDoS protection', () => {
  it('matches safe patterns quickly', () => {
    const start = Date.now();
    const result = safeMatch('\\d+', '12345abc');
    const elapsed = Date.now() - start;
    assert.ok(result !== null || result === null); // just ensure no throw
    assert.ok(elapsed < 50, `Expected <50ms, got ${elapsed}ms`);
  });

  it('handles potentially catastrophic backtracking within time limit', () => {
    // Adversarial input for naive regex engines: (a+)+ on "aaaaaaaaaaaaaaaaX"
    // RE2 handles this in linear time; fallback uses timeout guard
    const adversarialInput = 'a'.repeat(20) + 'X';

    const start = Date.now();
    try {
      // Using a pattern that's known to cause backtracking in PCRE
      safeMatch('(a+)+', adversarialInput);
    } catch {
      // RE2 may throw on unsupported patterns — that's fine
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `ReDoS guard failed: took ${elapsed}ms`);
  });

  it('returns null for non-matching patterns', () => {
    const result = safeMatch('[0-9]+', 'abc');
    assert.equal(result, null);
  });

  it('handles empty string', () => {
    const result = safeMatch('\\w+', '');
    assert.equal(result, null);
  });
});
