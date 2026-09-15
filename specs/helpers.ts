import { EditorView } from '@codemirror/view'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { Config, Note } from '../lib/types.ts'

export interface EditorPos {
  line: number
  ch: number
}

export type EditorAction =
  { type: 'replace'; replacement: string; start: EditorPos; end?: EditorPos } | { type: 'cursor'; pos: EditorPos }

class TestView {
  state: EditorState
  onDispatch: ((tr: Transaction) => void) | undefined
  constructor(doc: string, selection?: { from: number; to?: number }, onDispatch?: (tr: Transaction) => void) {
    let state = EditorState.create({ doc, extensions: [] })
    if (selection)
      state = state.update({ selection: { anchor: selection.from, head: selection.to ?? selection.from } }).state
    this.state = state
    this.onDispatch = onDispatch
  }
  dispatch(spec: TransactionSpec): void {
    const tr = this.state.update(spec)
    this.onDispatch?.(tr)
    this.state = tr.state
  }
  focus(): void {}
}

function recordDispatch(tr: Transaction, actions: EditorAction[]): void {
  if (tr.docChanged) {
    const pre = tr.startState
    tr.changes.iterChanges((from, to, _fromB, _toB, text) => {
      const startLine = pre.doc.lineAt(from)
      const endLine = pre.doc.lineAt(to)
      actions.push({
        type: 'replace',
        replacement: text.toString(),
        start: { line: startLine.number - 1, ch: from - startLine.from },
        end: { line: endLine.number - 1, ch: to - endLine.from },
      })
    })
  } else {
    const sel = tr.selection
    if (sel) {
      const anchor = sel.main.anchor
      const line = tr.startState.doc.lineAt(anchor)
      actions.push({ type: 'cursor', pos: { line: line.number - 1, ch: anchor - line.from } })
    }
  }
}

export function makeView(doc: string, selection?: { from: number; to?: number }): EditorView {
  return new TestView(doc, selection) as unknown as EditorView
}

export function makeRecordingView(
  doc: string,
  selection: { from: number; to?: number },
  actions: EditorAction[],
): EditorView {
  return new TestView(doc, selection, tr => recordDispatch(tr, actions)) as unknown as EditorView
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ghToken: 'ghp_test',
    ghOwner: 'owner',
    ghRepo: 'notes',
    ghBranch: 'main',
    ghPath: '',
    fileExt: '.md.gpg',
    cryptoMode: 'key',
    publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    privateKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    keyPassphrase: '',
    cryptoPassword: '',
    ghTimeoutMs: 10000,
    ...overrides,
  }
}

export function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    name: 'note.md',
    path: 'note.md',
    sha: 'abc123',
    size: 10,
    date: '2024-01-01',
    dirty: false,
    content: null,
    ...overrides,
  }
}
