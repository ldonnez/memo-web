import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { smartEnter } from '../lib/editor.js';

describe('smartEnter', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('replaces [x] with [ ] in the new line prefix', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 14 }),
      getLine: () => '- [x] done task',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    const result = smartEnter(cm, {
      formatTable: () => assert.fail('should not be called'),
      onEditorInput: () => {},
    });
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '\n- [ ] ');
    assert.deepEqual(calls[0].start, { line: 0, ch: 14 });
  });

  it('preserves [ ] (open todo) in the new line prefix', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 14 }),
      getLine: () => '- [ ] open task',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, {
      formatTable: () => assert.fail('should not be called'),
      onEditorInput: () => {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '\n- [ ] ');
  });

  it('preserves plain bullet list prefix (no checkbox)', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 7 }),
      getLine: () => '- plain item',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, {
      formatTable: () => assert.fail('should not be called'),
      onEditorInput: () => {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '\n- ');
  });

  it('returns Pass when cursor is before the list marker', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: () => '- [x] done task',
      replaceRange: () => assert.fail('should not be called'),
    };
    assert.equal(
      smartEnter(cm, {
        formatTable: () => assert.fail('should not be called'),
        onEditorInput: () => assert.fail('should not be called'),
      }),
      globalThis.CodeMirror.Pass,
    );
  });

  it('removes the line when the rest after prefix is empty', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 6 }),
      getLine: () => '- [x] ',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, {
      formatTable: () => assert.fail('should not be called'),
      onEditorInput: () => {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '');
    assert.deepEqual(calls[0].start, { line: 0, ch: 0 });
    assert.deepEqual(calls[0].end, { line: 0, ch: 6 });
  });
});
