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
  /**
   * Merge base: the decrypted text of the last content known to exist on the
   * remote. `baseSha` is the blob SHA that `baseText` was decrypted from, so a
   * single string compare answers "has the remote moved past what we synced?".
   * `null` means the base is unknown (never opened on this device, or written
   * by a build from before the base was tracked) — the pull decision then has
   * nothing to merge against and must not silently overwrite local work.
   */
  baseText?: string | null
  baseSha?: string | null
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
