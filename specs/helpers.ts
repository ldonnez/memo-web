import type { CmAdapter, CmMark, CmPos, Config, Note } from '../lib/types.ts'

export function makeCm(overrides: Partial<CmAdapter> = {}): CmAdapter {
  const noopMark = (): CmMark => ({ clear: () => {} })
  return {
    view: null,
    getValue: () => '',
    setValue: () => {},
    clearHistory: () => {},
    getSelection: () => '',
    replaceSelection: () => {},
    getCursor: () => ({ line: 0, ch: 0 }),
    setCursor: () => {},
    getLine: () => '',
    replaceRange: () => {},
    setSelection: () => {},
    posFromIndex: i => i,
    indexFromPos: () => 0,
    focus: () => {},
    scrollIntoView: () => {},
    scrollTo: () => {},
    getScrollInfo: () => ({ top: 0, left: 0, height: 100, width: 100 }),
    setOption: () => {},
    refresh: () => {},
    execCommand: () => {},
    markText: noopMark,
    getAllMarks: () => [],
    ...overrides,
  }
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

export type { CmPos }
