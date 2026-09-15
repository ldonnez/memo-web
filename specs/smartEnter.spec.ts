import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
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
  PASS,
} from '../lib/editor.ts'
import { makeView, makeRecordingView, makeNote, type EditorAction } from './helpers.ts'

function replaceAt(
  actions: EditorAction[],
  i: number,
): {
  replacement: string
  start: { line: number; ch: number }
  end?: { line: number; ch: number }
} {
  const a = actions[i]!
  assert.equal(a.type, 'replace')
  return a as Extract<EditorAction, { type: 'replace' }>
}

function cursorAt(actions: EditorAction[], i: number): { line: number; ch: number } {
  const a = actions[i]!
  assert.equal(a.type, 'cursor')
  return (a as Extract<EditorAction, { type: 'cursor' }>).pos
}

describe('smartEnter', () => {
  it('replaces [x] with [ ] in the new line prefix', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [x] done task', { from: 14 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(actions.length, 1)
    const a = replaceAt(actions, 0)
    assert.equal(a.replacement, '\n- [ ] ')
    assert.deepEqual(a.start, { line: 0, ch: 14 })
  })

  it('preserves [ ] (open todo) in the new line prefix', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [ ] open task', { from: 14 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '\n- [ ] ')
  })

  it('preserves plain bullet list prefix (no checkbox)', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- plain item', { from: 7 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '\n- ')
  })

  it('returns Pass when cursor is before the list marker', () => {
    const view = makeView('- [x] done task', { from: 0 })
    assert.equal(smartEnter(view, { formatTable: () => {}, onEditorInput: () => {} }), PASS)
    assert.equal(view.state.doc.toString(), '- [x] done task')
  })

  it('removes the line when the rest after prefix is empty', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [x] ', { from: 6 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(actions.length, 1)
    const a = replaceAt(actions, 0)
    assert.equal(a.replacement, '')
    assert.deepEqual(a.start, { line: 0, ch: 0 })
    assert.deepEqual(a.end, { line: 0, ch: 6 })
  })

  it('calls formatTable when on a pipe-delimited table row', () => {
    let called = false
    const view = makeView('| a | b |', { from: 9 })
    smartEnter(view, {
      formatTable: (c, line) => {
        called = true
        assert.equal(c, view)
        assert.equal(line, 1)
      },
      onEditorInput: () => {},
    })
    assert.equal(called, true)
  })

  it('increments numbered list prefix', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('1. item', { from: 4 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(replaceAt(actions, 0).replacement, '\n2. ')
  })

  it('calls onEditorInput after inserting a new line', () => {
    let called = false
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [x] done task', { from: 14 }, actions)
    smartEnter(view, {
      formatTable: () => assert.fail('should not be called'),
      onEditorInput: () => {
        called = true
      },
    })
    assert.equal(called, true)
  })

  it('works with * bullet marker', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('* [x] done task', { from: 14 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(replaceAt(actions, 0).replacement, '\n* [ ] ')
  })

  it('works with + bullet marker', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('+ [x] done task', { from: 14 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(replaceAt(actions, 0).replacement, '\n+ [ ] ')
  })

  it('preserves indentation for nested lists', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('  - [x] nested task', { from: 18 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(replaceAt(actions, 0).replacement, '\n  - [ ] ')
  })

  it('handles cursor at end of line', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [x] abcdef', { from: 12 }, actions)
    smartEnter(view, { formatTable: () => assert.fail('should not be called'), onEditorInput: () => {} })
    assert.equal(replaceAt(actions, 0).replacement, '\n- [ ] ')
  })

  it('returns Pass when line has no list prefix', () => {
    const view = makeView('plain text', { from: 5 })
    assert.equal(smartEnter(view, { formatTable: () => {}, onEditorInput: () => {} }), PASS)
  })
})

describe('toggleTaskByIndex', () => {
  it('toggles [ ] to [x] at the given index', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [ ] first\n- [x] second\n- [ ] third', { from: 0 }, actions)
    toggleTaskByIndex(0, view, () => {})
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '- [x] first')
  })

  it('toggles [x] to [ ] at the given index', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [ ] first\n- [x] second', { from: 0 }, actions)
    toggleTaskByIndex(1, view, () => {})
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '- [ ] second')
  })

  it('does nothing when idx is out of range', () => {
    const view = makeView('- [ ] first', { from: 0 })
    toggleTaskByIndex(5, view, () => {})
    assert.equal(view.state.doc.toString(), '- [ ] first')
  })

  it('calls onEditorInput after toggling', () => {
    let called = false
    const view = makeView('- [ ] hello', { from: 0 })
    toggleTaskByIndex(0, view, () => {
      called = true
    })
    assert.equal(called, true)
  })

  it('does nothing when content is empty', () => {
    const view = makeView('', { from: 0 })
    toggleTaskByIndex(0, view, () => assert.fail('should not be called'))
    assert.equal(view.state.doc.toString(), '')
  })

  it('does nothing when no task markers exist', () => {
    const view = makeView('- plain\n* bullet\n1. numbered', { from: 0 })
    toggleTaskByIndex(0, view, () => assert.fail('should not be called'))
    assert.equal(view.state.doc.toString(), '- plain\n* bullet\n1. numbered')
  })

  it('toggles the second task in mixed content', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('some text\n- [ ] first\n- [x] second\n\nmore text', { from: 0 }, actions)
    toggleTaskByIndex(1, view, () => {})
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '- [ ] second')
  })
})

describe('formatTable', () => {
  it('inserts a new empty row below the table', () => {
    const view = makeView('| a | b |\n| c | d |', { from: 4 })
    formatTable(view, 1, () => {})
    assert.equal(view.state.doc.lines, 3)
    assert.match(view.state.doc.line(3).text, /^\| .+ \| .+ \|$/)
  })

  it('inserts plain newline when table has fewer than 2 columns', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('| single |', { from: 0 }, actions)
    formatTable(view, 0, () => {})
    assert.equal(actions.length, 2)
    assert.equal(replaceAt(actions, 0).replacement, '\n')
    assert.deepEqual(cursorAt(actions, 1), { line: 1, ch: 0 })
  })

  it('inserts row after the last table line, not at cursor line', () => {
    const view = makeView('| h1 | h2 |\n| --- | --- |\n| d1 | d2 |', { from: 0 })
    formatTable(view, 0, () => {})
    assert.equal(view.state.doc.lines, 4)
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    assert.equal(line.number - 1, 3)
    assert.equal(head - line.from, 1)
  })

  it('calls onEditorInput after inserting row', () => {
    let called = false
    const view = makeView('| a | b |', { from: 0 })
    formatTable(view, 0, () => {
      called = true
    })
    assert.equal(called, true)
  })
})

describe('moveInTable', () => {
  it('moves to the next cell on a table row', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('| a | b | c |', { from: 3 }, actions)
    const result = moveInTable(view, false)
    assert.equal(result, true)
    assert.equal(actions.length, 1)
    assert.ok(cursorAt(actions, 0).ch > 3)
  })

  it('moves to the previous cell on shift', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('| a | b | c |', { from: 8 }, actions)
    const result = moveInTable(view, true)
    assert.equal(result, true)
    assert.equal(actions.length, 1)
    assert.ok(cursorAt(actions, 0).ch < 8)
  })

  it('returns false when not on a table row', () => {
    const view = makeView('- not a table', { from: 0 })
    assert.equal(moveInTable(view, false), false)
  })

  it('returns false when cursor is at the first cell and moving left', () => {
    const view = makeView('| a | b |', { from: 1 })
    assert.equal(moveInTable(view, true), false)
  })

  it('returns false when at the last cell and moving right', () => {
    const view = makeView('| a | b |', { from: 9 })
    assert.equal(moveInTable(view, false), false)
  })

  it('returns false for a single-cell table row', () => {
    const view = makeView('| only |', { from: 5 })
    assert.equal(moveInTable(view, false), false)
  })

  it('tabs through each cell of an empty 4-column row without skipping', () => {
    const line = '|   |   |   |   |'
    const runs: Array<{ from: number; expect: number | null }> = [
      { from: 1, expect: 5 },
      { from: 5, expect: 9 },
      { from: 9, expect: 13 },
      { from: 13, expect: null },
    ]
    for (const run of runs) {
      const actions: EditorAction[] = []
      const view = makeRecordingView(line, { from: run.from }, actions)
      const result = moveInTable(view, false)
      if (run.expect === null) {
        assert.equal(result, false)
      } else {
        assert.equal(result, true)
        assert.equal(cursorAt(actions, 0).ch, run.expect)
      }
    }
  })
})

describe('handleTab / handleShiftTab', () => {
  it('handleTab calls moveInTable then falls back to insertSoftTab', () => {
    const view = makeView('- list item', { from: 0 })
    handleTab(view)
    assert.equal(view.state.doc.toString(), '  - list item')
  })

  it('handleTab moves in table when on a table row', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('| a | b |', { from: 3 }, actions)
    handleTab(view)
    assert.equal(actions.length, 1)
    assert.equal(actions[0]!.type, 'cursor')
  })

  it('handleShiftTab returns Pass when not in table', () => {
    const view = makeView('- list item', { from: 0 })
    assert.equal(handleShiftTab(view), PASS)
  })
})

describe('toggleTaskOnLine', () => {
  it('toggles [ ] to [x] on the current line', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [ ] todo', { from: 3 }, actions)
    toggleTaskOnLine(view, makeNote({ name: 'file.md' }), () => {})
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '- [x] todo')
  })

  it('toggles [x] to [ ] on the current line', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('- [x] done', { from: 3 }, actions)
    toggleTaskOnLine(view, makeNote({ name: 'file.md' }), () => {})
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '- [ ] done')
  })

  it('inserts - [ ] when line has no task marker', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('plain text', { from: 5 }, actions)
    toggleTaskOnLine(view, makeNote({ name: 'file.md' }), () => {})
    assert.equal(actions.length, 2)
    assert.equal(replaceAt(actions, 0).replacement, '- [ ] ')
    assert.deepEqual(cursorAt(actions, 1), { line: 0, ch: 6 })
  })

  it('does nothing when currentFile is null', () => {
    const view = makeView('- [ ] todo', { from: 3 })
    toggleTaskOnLine(view, null, () => assert.fail('should not be called'))
    assert.equal(view.state.doc.toString(), '- [ ] todo')
  })

  it('calls onEditorInput after toggling', () => {
    let called = false
    const view = makeView('- [ ] todo', { from: 3 })
    toggleTaskOnLine(view, makeNote({ name: 'file.md' }), () => {
      called = true
    })
    assert.equal(called, true)
  })

  it('works with * bullet marker', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('* [ ] task', { from: 3 }, actions)
    toggleTaskOnLine(view, makeNote({ name: 'file.md' }), () => {})
    assert.equal(actions.length, 1)
    assert.equal(replaceAt(actions, 0).replacement, '* [x] task')
  })

  it('preserves leading whitespace when inserting new task', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('  plain text', { from: 8 }, actions)
    toggleTaskOnLine(view, makeNote({ name: 'file.md' }), () => {})
    assert.equal(replaceAt(actions, 0).replacement, '- [ ] ')
  })
})

describe('insertMarkdown', () => {
  it('wraps selection with markdown syntax', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('selected text', { from: 0, to: 13 }, actions)
    insertMarkdown('**', '**', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '**selected text**')
  })

  it('inserts prefix at cursor when nothing selected', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('abcde', { from: 5 }, actions)
    insertMarkdown('# ', '', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '# ')
    assert.deepEqual(cursorAt(actions, 1), { line: 0, ch: 7 })
  })

  it('calls onEditorInput after inserting', () => {
    let called = false
    const view = makeView('', { from: 0 })
    insertMarkdown('**', '**', view, () => {
      called = true
    })
    assert.equal(called, true)
  })

  it('wraps with bold syntax', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('word', { from: 0, to: 4 }, actions)
    insertMarkdown('**', '**', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '**word**')
  })

  it('wraps with italic syntax', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('word', { from: 0, to: 4 }, actions)
    insertMarkdown('*', '*', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '*word*')
  })

  it('inserts heading prefix', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('', { from: 0 }, actions)
    insertMarkdown('### ', '', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '### ')
    assert.deepEqual(cursorAt(actions, 1), { line: 0, ch: 4 })
  })

  it('wraps with link syntax', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('text', { from: 0, to: 4 }, actions)
    insertMarkdown('[', '](url)', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '[text](url)')
  })

  it('wraps with code block syntax', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('code', { from: 0, to: 4 }, actions)
    insertMarkdown('```\n', '\n```', view, () => {})
    assert.equal(replaceAt(actions, 0).replacement, '```\ncode\n```')
  })
})

describe('insertTimestamp', () => {
  it('inserts YYYY-MM-DD format via insertMarkdown', () => {
    const actions: EditorAction[] = []
    const view = makeRecordingView('', { from: 0 }, actions)
    insertTimestamp(view, () => {})
    assert.match(replaceAt(actions, 0).replacement, /^\d{4}-\d{2}-\d{2}$/)
  })

  it('calls onEditorInput after inserting', () => {
    let called = false
    const view = makeView('', { from: 0 })
    insertTimestamp(view, () => {
      called = true
    })
    assert.equal(called, true)
  })
})

describe('toggleTaskByIndex fallback', () => {
  it('falls back to the textarea when view is null', () => {
    let textarea: HTMLTextAreaElement | null = null
    const single = globalThis.document
    try {
      globalThis.document = {
        getElementById(id: string) {
          if (id === 'editorContent') {
            textarea = { value: '- [ ] via textarea', dispatchEvent() {} } as unknown as HTMLTextAreaElement
            return textarea
          }
          return null
        },
      } as unknown as Document
      toggleTaskByIndex(0, null, () => {})
      assert.equal(textarea!.value, '- [x] via textarea')
    } finally {
      if (single) globalThis.document = single
    }
  })
})
