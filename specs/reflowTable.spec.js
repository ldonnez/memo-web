import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { reflowTable } from '../lib/format.js';

describe('reflowTable', () => {
  it('aligns columns by widest content (incl. separator)', () => {
    const lines = ['| a | bbb |', '|---|---|', '| c | d |'];
    const rowLines = [0, 1, 2];
    const rowParts = [
      [' a ', ' bbb '],
      ['---', '---'],
      [' c ', ' d '],
    ];
    reflowTable(lines, rowLines, rowParts, 2);
    assert.equal(lines[0], '| a   | bbb |');
    assert.equal(lines[1], '| --- | --- |');
    assert.equal(lines[2], '| c   | d   |');
  });

  it('handles table without separator row', () => {
    const lines = ['| x | y |', '| z | w |'];
    const rowLines = [0, 1];
    const rowParts = [
      [' x ', ' y '],
      [' z ', ' w '],
    ];
    reflowTable(lines, rowLines, rowParts, 2);
    assert.equal(lines[0], '| x | y |');
    assert.equal(lines[1], '| z | w |');
  });

  it('preserves separator alignment colons', () => {
    const lines = ['| a | b |', '|:--|--:|', '| c | d |'];
    const rowLines = [0, 1, 2];
    const rowParts = [
      [' a ', ' b '],
      [':--', '--:'],
      [' c ', ' d '],
    ];
    reflowTable(lines, rowLines, rowParts, 2);
    assert.equal(lines[0], '| a   | b   |');
    assert.equal(lines[1], '|:--- | ---:|');
    assert.equal(lines[2], '| c   | d   |');
  });

  it('handles single-column table', () => {
    const lines = ['| a |', '|---|', '| b |'];
    const rowLines = [0, 1, 2];
    const rowParts = [[' a '], ['---'], [' b ']];
    reflowTable(lines, rowLines, rowParts, 1);
    assert.equal(lines[0], '| a   |');
    assert.equal(lines[1], '| --- |');
    assert.equal(lines[2], '| b   |');
  });

  it('pads short content to match widest row', () => {
    const lines = ['| long |', '|---|', '| a |'];
    const rowLines = [0, 1, 2];
    const rowParts = [[' long '], ['---'], [' a ']];
    reflowTable(lines, rowLines, rowParts, 1);
    assert.equal(lines[0], '| long |');
    assert.equal(lines[1], '| ---- |');
    assert.equal(lines[2], '| a    |');
  });

  it('handles empty cells', () => {
    const lines = ['| a | b |', '|---|---|', '|  | d |'];
    const rowLines = [0, 1, 2];
    const rowParts = [
      [' a ', ' b '],
      ['---', '---'],
      [' ', ' d '],
    ];
    reflowTable(lines, rowLines, rowParts, 2);
    assert.equal(lines[0], '| a   | b   |');
    assert.equal(lines[1], '| --- | --- |');
    assert.equal(lines[2], '|     | d   |');
  });

  it('handles unequal column counts across rows', () => {
    const lines = ['| a | b | c |', '|---|---|---|', '| x | y |'];
    const rowLines = [0, 1, 2];
    const rowParts = [
      [' a ', ' b ', ' c '],
      ['---', '---', '---'],
      [' x ', ' y '],
    ];
    reflowTable(lines, rowLines, rowParts, 3);
    assert.equal(lines[0], '| a   | b   | c   |');
    assert.equal(lines[1], '| --- | --- | --- |');
    assert.equal(lines[2], '| x   | y   |     |');
  });

  it('handles very wide content', () => {
    const N = 50;
    const lines = ['| short |', '|---|', '| ' + 'x'.repeat(N) + ' |'];
    const rowLines = [0, 1, 2];
    const rowParts = [[' short '], ['---'], [' ' + 'x'.repeat(N) + ' ']];
    reflowTable(lines, rowLines, rowParts, 1);
    const pad = N - 'short'.length + 1;
    assert.equal(lines[0], '| short' + Array(pad + 1).join(' ') + '|');
    assert.equal(lines[1], '| ' + '-'.repeat(N) + ' |');
    assert.equal(lines[2], '| ' + 'x'.repeat(N) + ' |');
  });

  it('treats separator-only rows as dashes even with colons', () => {
    const lines = ['| left | right |', '|:----|----:|', '| a | b |'];
    const rowLines = [0, 1, 2];
    const rowParts = [
      [' left ', ' right '],
      [':----', '----:'],
      [' a ', ' b '],
    ];
    reflowTable(lines, rowLines, rowParts, 2);
    assert.equal(lines[0], '| left  | right |');
    assert.equal(lines[1], '|:----- | -----:|');
    assert.equal(lines[2], '| a     | b     |');
  });
});
