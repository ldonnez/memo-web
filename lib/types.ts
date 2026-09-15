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
