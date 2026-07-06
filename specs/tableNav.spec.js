import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getPipePositions, getCellContentStart } from '../lib/format.js';

describe('getPipePositions', () => {
  it('finds pipe positions in a table row', () => {
    assert.deepEqual(getPipePositions('| a | b |'), [0, 4, 8]);
  });

  it('handles row without pipes', () => {
    assert.deepEqual(getPipePositions('hello'), []);
  });

  it('handles row with leading and trailing pipes', () => {
    assert.deepEqual(getPipePositions('| a |'), [0, 4]);
  });
});

describe('getCellContentStart', () => {
  it('returns first non-space after pipe', () => {
    assert.equal(getCellContentStart('| a |', 0), 2);
  });

  it('returns pipeIndex+1 when no content after pipe', () => {
    assert.equal(getCellContentStart('|', 0), 1);
  });

  it('returns pipeIndex+1 for empty cell between pipes', () => {
    assert.equal(getCellContentStart('|   |', 0), 1);
  });

  it('skips multiple spaces after pipe', () => {
    assert.equal(getCellContentStart('|   x', 0), 4);
  });
});
