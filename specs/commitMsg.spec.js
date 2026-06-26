import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { commitMsg } from '../lib/util.js';

describe('commitMsg', () => {
  it('formats timestamp from a given date', () => {
    const d = new Date('2024-03-15T10:05:30');
    assert.equal(commitMsg(d), 'memo-web: sync 2024-03-15 10:05:30');
  });

  it('pads single-digit month/day/hour/min/sec', () => {
    const d = new Date('2024-01-05T01:02:03');
    assert.equal(commitMsg(d), 'memo-web: sync 2024-01-05 01:02:03');
  });
});
