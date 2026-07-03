import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { findMatchRanges } from '../lib/util.js';

describe('findMatchRanges', () => {
  it('finds matches in a simple string', () => {
    assert.deepEqual(findMatchRanges('hello world', 'world'), [{ from: 6, to: 11 }]);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(findMatchRanges('Hello World', 'world'), [{ from: 6, to: 11 }]);
    assert.deepEqual(findMatchRanges('hello world', 'WORLD'), [{ from: 6, to: 11 }]);
    assert.deepEqual(findMatchRanges('HELLO WORLD', 'hello'), [{ from: 0, to: 5 }]);
  });

  it('finds multiple non-overlapping matches', () => {
    const result = findMatchRanges('the cat and the dog', 'the');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { from: 0, to: 3 });
    assert.deepEqual(result[1], { from: 12, to: 15 });
  });

  it('finds overlapping matches', () => {
    const result = findMatchRanges('aaaa', 'aa');
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { from: 0, to: 2 });
    assert.deepEqual(result[1], { from: 1, to: 3 });
    assert.deepEqual(result[2], { from: 2, to: 4 });
  });

  it('returns empty array when there are no matches', () => {
    assert.deepEqual(findMatchRanges('hello world', 'xyz'), []);
  });

  it('returns empty array for empty query', () => {
    assert.deepEqual(findMatchRanges('hello world', ''), []);
  });

  it('returns empty array for empty text', () => {
    assert.deepEqual(findMatchRanges('', 'hello'), []);
  });

  it('returns empty array when both are empty', () => {
    assert.deepEqual(findMatchRanges('', ''), []);
  });

  it('matches at the start of the string', () => {
    assert.deepEqual(findMatchRanges('hello world', 'hello'), [{ from: 0, to: 5 }]);
  });

  it('matches at the end of the string', () => {
    assert.deepEqual(findMatchRanges('hello world', 'world'), [{ from: 6, to: 11 }]);
  });

  it('matches the entire string', () => {
    assert.deepEqual(findMatchRanges('hello', 'hello'), [{ from: 0, to: 5 }]);
  });

  it('handles unicode characters', () => {
    const result = findMatchRanges('café au café', 'café');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { from: 0, to: 4 });
    assert.deepEqual(result[1], { from: 8, to: 12 });
  });

  it('handles unicode case folding', () => {
    const result = findMatchRanges('ÉLÉGANCE', 'élégance');
    assert.equal(result.length, 1);
    assert.equal(result[0].from, 0);
    assert.equal(result[0].to, 8);
  });

  it('handles repeated single character', () => {
    const result = findMatchRanges('aaabaaa', 'aa');
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { from: 0, to: 2 });
    assert.deepEqual(result[1], { from: 1, to: 3 });
    assert.deepEqual(result[2], { from: 4, to: 6 });
    assert.deepEqual(result[3], { from: 5, to: 7 });
  });

  it('handles newlines', () => {
    assert.deepEqual(findMatchRanges('line1\nline2\nline3', 'line'), [
      { from: 0, to: 4 },
      { from: 6, to: 10 },
      { from: 12, to: 16 },
    ]);
  });

  it('matches within longer words', () => {
    const result = findMatchRanges('finding inscription', 'in');
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { from: 1, to: 3 });
    assert.deepEqual(result[1], { from: 4, to: 6 });
    assert.deepEqual(result[2], { from: 8, to: 10 });
  });

  it('does not modify the original text', () => {
    const text = 'Hello World';
    findMatchRanges(text, 'hello');
    assert.equal(text, 'Hello World');
  });
});
