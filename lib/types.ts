export interface Config {
  ghToken?: string
  ghOwner?: string
  ghRepo?: string
  ghBranch?: string
  ghPath?: string
  fileExt?: string
  cryptoMode?: 'key' | 'password'
  publicKey?: string
  privateKey?: string
  keyPassphrase?: string
  cryptoPassword?: string
  ghTimeoutMs?: number
}

export interface Dir {
  name: string
  path: string
}

export interface DirWithType extends Dir {
  sha: string
  size: number
  last_modified: string
  type: 'dir'
}

export interface Note {
  name: string
  path: string
  sha: string | null
  size: number
  date: string
  dirty: boolean
  content: string | null
  decrypted?: string | null
  originalText?: string
}

export interface GhFileEntry {
  name: string
  path: string
  sha: string
  size: number
  type: 'file' | 'dir'
  last_modified?: string
  content?: string
}

export interface GhFileData {
  sha: string
  content: string
}

export interface CachedRecord {
  notes: Note[]
  dirs: Dir[]
  currentBrowsePath: string
  timestamp: number
}

export type CmPos = number | { line: number; ch: number }

export interface CmMark {
  clear: () => void
}

export interface CmAdapter {
  view: unknown
  getValue: () => string
  setValue: (val: string) => void
  clearHistory: () => void
  getSelection: () => string
  replaceSelection: (text: string) => void
  getCursor: (type?: 'from' | 'to' | 'head') => { line: number; ch: number }
  setCursor: (pos: CmPos, ch?: number, opts?: { scroll?: boolean }) => void
  getLine: (n: number) => string
  replaceRange: (text: string, from: CmPos, to?: CmPos) => void
  setSelection: (from: CmPos, to: CmPos) => void
  posFromIndex: (i: number) => number
  indexFromPos: (pos: CmPos) => number
  focus: () => void
  scrollIntoView: (pos: CmPos, margin?: number) => void
  scrollTo: (left: number, top: number) => void
  getScrollInfo: () => { top: number; left: number; height: number; width: number }
  setOption: (name: string, value: string) => void
  refresh: () => void
  execCommand: (cmd: string) => void
  markText: (from: CmPos, to: CmPos, opts?: { className?: string }) => CmMark
  getAllMarks: () => CmMark[]
}
