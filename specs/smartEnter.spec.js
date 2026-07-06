import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  smartEnter,
  toggleTaskByIndex,
  formatTable,
  moveInTable,
  handleTab,
  handleShiftTab,
  toggleTaskOnLine,
  insertMarkdown,
  insertTimestamp,
} from '../lib/editor.js';

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
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
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
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
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
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '\n- ');
  });

  it('returns Pass when cursor is before the list marker', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: () => '- [x] done task',
      replaceRange: () => assert.fail('should not be called'),
    };
    assert.equal(smartEnter(cm, { formatTable: () => {}, onEditorInput: () => {} }), globalThis.CodeMirror.Pass);
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
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '');
    assert.deepEqual(calls[0].start, { line: 0, ch: 0 });
    assert.deepEqual(calls[0].end, { line: 0, ch: 6 });
  });

  it('calls formatTable when on a pipe-delimited table row', () => {
    let called = false;
    const cm = {
      getCursor: () => ({ line: 0, ch: 10 }),
      getLine: () => '| a | b |',
      replaceRange: () => assert.fail('should not be called'),
    };
    smartEnter(cm, {
      formatTable: (c, line, cb) => {
        called = true;
        assert.equal(c, cm);
        assert.equal(line, 1);
      },
      onEditorInput: () => {},
    });
    assert.equal(called, true);
  });

  it('increments numbered list prefix', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 4 }),
      getLine: () => '1. item',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls[0].replacement, '\n2. ');
  });

  it('calls onEditorInput after inserting a new line', () => {
    let called = false;
    const cm = {
      getCursor: () => ({ line: 0, ch: 14 }),
      getLine: () => '- [x] done task',
      replaceRange: () => {},
    };
    smartEnter(cm, {
      formatTable: () => assert.fail('should not be called'),
      onEditorInput: () => {
        called = true;
      },
    });
    assert.equal(called, true);
  });

  it('works with * bullet marker', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 14 }),
      getLine: () => '* [x] done task',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls[0].replacement, '\n* [ ] ');
  });

  it('works with + bullet marker', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 14 }),
      getLine: () => '+ [x] done task',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls[0].replacement, '\n+ [ ] ');
  });

  it('preserves indentation for nested lists', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 18 }),
      getLine: () => '  - [x] nested task',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls[0].replacement, '\n  - [ ] ');
  });

  it('handles cursor at end of line', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 14 }),
      getLine: () => '- [x] abcdef',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    smartEnter(cm, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} });
    assert.equal(calls[0].replacement, '\n- [ ] ');
  });

  it('returns Pass when line has no list prefix', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 5 }),
      getLine: () => 'plain text',
      replaceRange: () => assert.fail('should not be called'),
    };
    assert.equal(smartEnter(cm, { formatTable: () => {}, onEditorInput: () => {} }), globalThis.CodeMirror.Pass);
  });
});

describe('toggleTaskByIndex', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('toggles [ ] to [x] at the given index', () => {
    const calls = [];
    const cm = {
      getValue: () => '- [ ] first\n- [x] second\n- [ ] third',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    toggleTaskByIndex(0, cm, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '- [x] first');
  });

  it('toggles [x] to [ ] at the given index', () => {
    const calls = [];
    const cm = {
      getValue: () => '- [ ] first\n- [x] second',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    toggleTaskByIndex(1, cm, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '- [ ] second');
  });

  it('does nothing when idx is out of range', () => {
    const cm = {
      getValue: () => '- [ ] first',
      replaceRange: () => assert.fail('should not be called'),
    };
    toggleTaskByIndex(5, cm, () => {});
  });

  it('calls onEditorInput after toggling', () => {
    let called = false;
    const cm = {
      getValue: () => '- [ ] hello',
      replaceRange: () => {},
    };
    toggleTaskByIndex(0, cm, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('does nothing when content is empty', () => {
    const cm = {
      getValue: () => '',
      replaceRange: () => assert.fail('should not be called'),
    };
    toggleTaskByIndex(0, cm, () => {});
  });

  it('does nothing when no task markers exist', () => {
    const cm = {
      getValue: () => '- plain\n* bullet\n1. numbered',
      replaceRange: () => assert.fail('should not be called'),
    };
    toggleTaskByIndex(0, cm, () => {});
  });

  it('toggles the second task in mixed content', () => {
    const calls = [];
    const cm = {
      getValue: () => 'some text\n- [ ] first\n- [x] second\n\nmore text',
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
    };
    toggleTaskByIndex(1, cm, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '- [ ] second');
  });
});

describe('formatTable', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('inserts a new empty row below the table', () => {
    let setValueCalled = false;
    const cm = {
      getValue: () => '| a | b |\n| c | d |',
      setValue(val) {
        setValueCalled = true;
        const lines = val.split('\n');
        assert.equal(lines.length, 3);
        assert.match(lines[2], /^\| .+ \| .+ \|$/);
      },
      setCursor: () => {},
      replaceRange: () => {},
    };
    formatTable(cm, 1, () => {});
    assert.equal(setValueCalled, true);
  });

  it('inserts plain newline when table has fewer than 2 columns', () => {
    const calls = [];
    const cm = {
      getValue: () => '| single |',
      setValue: () => assert.fail('should not be called'),
      setCursor(pos) {
        calls.push({ type: 'setCursor', pos });
      },
      replaceRange(replacement, start, end) {
        calls.push({ type: 'replaceRange', replacement, start, end });
      },
    };
    formatTable(cm, 0, () => {});
    assert.equal(calls.length, 2);
    assert.equal(calls[0].replacement, '\n');
  });

  it('inserts row after the last table line, not at cursor line', () => {
    let setValueCalled = false;
    const cm = {
      getValue: () => '| h1 | h2 |\n| --- | --- |\n| d1 | d2 |',
      setValue(val) {
        setValueCalled = true;
        const lines = val.split('\n');
        assert.equal(lines.length, 4);
      },
      setCursor(pos) {
        assert.deepEqual(pos, { line: 3, ch: 1 });
      },
      replaceRange: () => {},
    };
    formatTable(cm, 0, () => {});
    assert.equal(setValueCalled, true);
  });

  it('calls onEditorInput after inserting row', () => {
    let called = false;
    const cm = {
      getValue: () => '| a | b |',
      setValue: () => {},
      setCursor: () => {},
      replaceRange: () => {},
    };
    formatTable(cm, 0, () => {
      called = true;
    });
    assert.equal(called, true);
  });
});

describe('moveInTable', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('moves to the next cell on a table row', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 3 }),
      getLine: () => '| a | b | c |',
      setCursor(pos) {
        calls.push(pos);
      },
    };
    const result = moveInTable(cm, false);
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert(calls[0].ch > 3);
  });

  it('moves to the previous cell on shift', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 8 }),
      getLine: () => '| a | b | c |',
      setCursor(pos) {
        calls.push(pos);
      },
    };
    const result = moveInTable(cm, true);
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert(calls[0].ch < 8);
  });

  it('returns false when not on a table row', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: () => '- not a table',
      setCursor: () => assert.fail('should not be called'),
    };
    assert.equal(moveInTable(cm, false), false);
  });

  it('returns false when cursor is at the first cell and moving left', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 1 }),
      getLine: () => '| a | b |',
      setCursor: () => assert.fail('should not be called'),
    };
    assert.equal(moveInTable(cm, true), false);
  });

  it('returns false when at the last cell and moving right', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 10 }),
      getLine: () => '| a | b |',
      setCursor: () => assert.fail('should not be called'),
    };
    assert.equal(moveInTable(cm, false), false);
  });

  it('returns false for a single-cell table row', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 5 }),
      getLine: () => '| only |',
      setCursor: () => assert.fail('should not be called'),
    };
    assert.equal(moveInTable(cm, false), false);
  });

  it('tabs through each cell of an empty 4-column row without skipping', () => {
    const line = '|   |   |   |   |';
    const calls = [];
    function tabFrom(ch) {
      const cm = {
        getCursor: () => ({ line: 0, ch }),
        getLine: () => line,
        setCursor(pos) {
          calls.push(pos);
        },
      };
      return moveInTable(cm, false);
    }
    // Tab from cell 0 → cell 1 (not cell 2)
    assert.equal(tabFrom(1), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ch, 5);
    // Tab from cell 1 → cell 2
    assert.equal(tabFrom(5), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].ch, 9);
    // Tab from cell 2 → cell 3
    assert.equal(tabFrom(9), true);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].ch, 13);
    // Tab from cell 3 → false (last cell)
    assert.equal(tabFrom(13), false);
  });
});

describe('handleTab / handleShiftTab', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('handleTab calls moveInTable then falls back to insertSoftTab', () => {
    let softTabCalled = false;
    const cm = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: () => '- list item',
      setCursor: () => assert.fail('should not be called'),
      execCommand(cmd) {
        if (cmd === 'insertSoftTab') softTabCalled = true;
      },
    };
    handleTab(cm);
    assert.equal(softTabCalled, true);
  });

  it('handleTab moves in table when on a table row', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 3 }),
      getLine: () => '| a | b |',
      setCursor(pos) {
        calls.push(pos);
      },
      execCommand: () => assert.fail('should not be called'),
    };
    handleTab(cm);
    assert.equal(calls.length, 1);
  });

  it('handleShiftTab returns Pass when not in table', () => {
    const cm = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: () => '- list item',
      setCursor: () => assert.fail('should not be called'),
    };
    assert.equal(handleShiftTab(cm), globalThis.CodeMirror.Pass);
  });
});

describe('toggleTaskOnLine', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('toggles [ ] to [x] on the current line', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 3 }),
      getLine: () => '- [ ] todo',
      focus: () => {},
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
      setCursor: () => assert.fail('should not be called'),
    };
    toggleTaskOnLine(cm, { name: 'file.md' }, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '- [x] todo');
  });

  it('toggles [x] to [ ] on the current line', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 3 }),
      getLine: () => '- [x] done',
      focus: () => {},
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
      setCursor: () => assert.fail('should not be called'),
    };
    toggleTaskOnLine(cm, { name: 'file.md' }, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '- [ ] done');
  });

  it('inserts - [ ] when line has no task marker', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 5 }),
      getLine: () => 'plain text',
      focus: () => {},
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
      setCursor(pos) {
        calls.push({ type: 'setCursor', pos });
      },
    };
    toggleTaskOnLine(cm, { name: 'file.md' }, () => {});
    assert.equal(calls.length, 2);
    assert.equal(calls[0].replacement, '- [ ] ');
  });

  it('does nothing when currentFile is null', () => {
    const cm = {
      getCursor: () => assert.fail('should not be called'),
    };
    toggleTaskOnLine(cm, null, () => {});
  });

  it('calls onEditorInput after toggling', () => {
    let called = false;
    const cm = {
      getCursor: () => ({ line: 0, ch: 3 }),
      getLine: () => '- [ ] todo',
      focus: () => {},
      replaceRange: () => {},
    };
    toggleTaskOnLine(cm, { name: 'file.md' }, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('works with * bullet marker', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 3 }),
      getLine: () => '* [ ] task',
      focus: () => {},
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
      setCursor: () => assert.fail('should not be called'),
    };
    toggleTaskOnLine(cm, { name: 'file.md' }, () => {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replacement, '* [x] task');
  });

  it('preserves leading whitespace when inserting new task', () => {
    const calls = [];
    const cm = {
      getCursor: () => ({ line: 0, ch: 8 }),
      getLine: () => '  plain text',
      focus: () => {},
      replaceRange(replacement, start, end) {
        calls.push({ replacement, start, end });
      },
      setCursor(pos) {
        calls.push({ type: 'setCursor', pos });
      },
    };
    toggleTaskOnLine(cm, { name: 'file.md' }, () => {});
    assert.equal(calls[0].replacement, '- [ ] ');
  });
});

describe('insertMarkdown', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('wraps selection with markdown syntax', () => {
    const cm = {
      getSelection: () => 'selected text',
      getCursor: () => {},
      replaceSelection(val) {
        assert.equal(val, '**selected text**');
      },
      focus: () => {},
    };
    insertMarkdown('**', '**', cm, () => {});
  });

  it('inserts prefix at cursor when nothing selected', () => {
    let setCursorCalled = false;
    const cm = {
      getSelection: () => '',
      getCursor: type => ({ line: 0, ch: 5 }),
      replaceSelection(val) {
        assert.equal(val, '# ');
      },
      setCursor(pos) {
        setCursorCalled = true;
        assert.deepEqual(pos, { line: 0, ch: 7 });
      },
      focus: () => {},
    };
    insertMarkdown('# ', '', cm, () => {});
    assert.equal(setCursorCalled, true);
  });

  it('calls onEditorInput after inserting', () => {
    let called = false;
    const cm = {
      getSelection: () => '',
      getCursor: () => ({}),
      replaceSelection: () => {},
      setCursor: () => {},
      focus: () => {},
    };
    insertMarkdown('**', '**', cm, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('wraps with bold syntax', () => {
    const cm = {
      getSelection: () => 'word',
      getCursor: () => {},
      replaceSelection(val) {
        assert.equal(val, '**word**');
      },
      focus: () => {},
    };
    insertMarkdown('**', '**', cm, () => {});
  });

  it('wraps with italic syntax', () => {
    const cm = {
      getSelection: () => 'word',
      getCursor: () => {},
      replaceSelection(val) {
        assert.equal(val, '*word*');
      },
      focus: () => {},
    };
    insertMarkdown('*', '*', cm, () => {});
  });

  it('inserts heading prefix', () => {
    const cm = {
      getSelection: () => '',
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceSelection(val) {
        assert.equal(val, '### ');
      },
      setCursor(pos) {
        assert.deepEqual(pos, { line: 0, ch: 4 });
      },
      focus: () => {},
    };
    insertMarkdown('### ', '', cm, () => {});
  });

  it('wraps with link syntax', () => {
    const cm = {
      getSelection: () => 'text',
      getCursor: () => {},
      replaceSelection(val) {
        assert.equal(val, '[text](url)');
      },
      focus: () => {},
    };
    insertMarkdown('[', '](url)', cm, () => {});
  });

  it('wraps with code block syntax', () => {
    const cm = {
      getSelection: () => 'code',
      getCursor: () => {},
      replaceSelection(val) {
        assert.equal(val, '```\ncode\n```');
      },
      focus: () => {},
    };
    insertMarkdown('```\n', '\n```', cm, () => {});
  });
});

describe('insertTimestamp', () => {
  before(() => {
    globalThis.CodeMirror = { Pass: Symbol('pass') };
  });

  it('inserts YYYY-MM-DD format via insertMarkdown', () => {
    let calledWith = null;
    const cm = {
      getSelection: () => '',
      getCursor: () => ({}),
      replaceSelection(val) {
        calledWith = val;
      },
      setCursor: () => {},
      focus: () => {},
    };
    insertTimestamp(cm, () => {});
    assert.match(calledWith, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('calls onEditorInput after inserting', () => {
    let called = false;
    const cm = {
      getSelection: () => '',
      getCursor: () => ({}),
      replaceSelection: () => {},
      setCursor: () => {},
      focus: () => {},
    };
    insertTimestamp(cm, () => {
      called = true;
    });
    assert.equal(called, true);
  });
});
