import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatDate } from '../lib/util.js';

describe('formatDate', () => {
  it('formats an ISO date string', () => {
    const result = formatDate('2024-03-15');
    assert.notEqual(result, '2024-03-15');
    assert.ok(result.length > 0);
  });

  it('returns first 10 chars for invalid dates', () => {
    assert.equal(formatDate('not-a-date'), 'not-a-date');
  });

  it('handles empty string input', () => {
    assert.equal(formatDate(''), '');
  });

  it('handles null-like values gracefully', () => {
    assert.equal(formatDate(undefined), '');
    assert.equal(formatDate(null), '');
  });
});
