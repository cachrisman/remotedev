'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const NdjsonFramer = require('../ndjson-framer');

describe('NdjsonFramer', () => {
  it('emits complete lines on newline', () => {
    const lines = [];
    const framer = new NdjsonFramer({ onLine: l => lines.push(l) });
    framer.push('{"a":1}\n{"b":2}\n');
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it('buffers partial lines across pushes', () => {
    const lines = [];
    const framer = new NdjsonFramer({ onLine: l => lines.push(l) });
    framer.push('{"a"');
    assert.equal(lines.length, 0);
    framer.push(':1}\n');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '{"a":1}');
  });

  it('flushes remaining buffer on flush()', () => {
    const lines = [];
    const framer = new NdjsonFramer({ onLine: l => lines.push(l) });
    framer.push('{"last":true}');
    framer.flush();
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '{"last":true}');
  });

  it('skips empty lines', () => {
    const lines = [];
    const framer = new NdjsonFramer({ onLine: l => lines.push(l) });
    framer.push('\n\n{"ok":1}\n\n');
    assert.equal(lines.length, 1);
  });

  it('calls onError on line_too_long and recovers', () => {
    const errors = [];
    const lines = [];
    const framer = new NdjsonFramer({
      maxLineBytes: 10,
      onLine: l => lines.push(l),
      onError: e => errors.push(e),
    });

    framer.push('a'.repeat(15) + '\nnext\n');
    assert.equal(errors.length, 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'next');
  });

  it('handles chunk split in middle of line', () => {
    const lines = [];
    const framer = new NdjsonFramer({ onLine: l => lines.push(l) });
    framer.push('{"type":"text","text":"hell');
    framer.push('o world"}\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('hello world'));
  });
});
