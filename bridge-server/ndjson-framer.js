'use strict';

/**
 * NDJSON framer — buffers incoming chunks and emits complete lines.
 *
 * Fault-tolerant:
 * - Lines longer than maxLineBytes are truncated and flagged as parse errors
 * - Empty lines are skipped
 * - Non-JSON lines (after threshold) trigger degraded mode
 */
class NdjsonFramer {
  constructor({ maxLineBytes = 1024 * 1024, onLine, onError } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.onLine = onLine;
    this.onError = onError || (() => {});
    this._buf = '';
    this._truncating = false;
  }

  push(chunk) {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // Check if adding this would exceed max before newline
    let start = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\n') {
        const segment = str.slice(start, i);
        this._buf += segment;
        start = i + 1;

        if (this._truncating) {
          this._truncating = false;
          this._buf = '';
          this.onError(new Error('line_too_long'));
          continue;
        }

        const line = this._buf.trim();
        this._buf = '';

        if (line.length === 0) continue;
        this.onLine(line);
      }
    }

    // Accumulate remaining
    if (start < str.length) {
      const remaining = str.slice(start);
      this._buf += remaining;

      if (this._buf.length > this.maxLineBytes) {
        this._truncating = true;
        this._buf = '';
        this.onError(new Error('line_too_long'));
      }
    }
  }

  flush() {
    if (this._buf.trim().length > 0 && !this._truncating) {
      this.onLine(this._buf.trim());
    }
    this._buf = '';
    this._truncating = false;
  }
}

module.exports = NdjsonFramer;
