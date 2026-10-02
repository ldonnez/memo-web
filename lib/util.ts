import type { HLJSApi } from 'highlight.js'
import type { CachedRecord, Dir, Note } from './types.ts'
import { adoptBase, withBase } from './sync.ts'

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
  message = 'Timed out',
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        if (onTimeout) onTimeout()
        reject(new Error(message))
      }, ms),
    ),
  ])
}

export function escHtml(s: string): string {
  if (typeof document === 'undefined') {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

export function getUrlParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) || ''
}

export function setUrlParams(params: Record<string, string | undefined>): void {
  const p = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(params)) {
    if (v) p.set(k, v)
    else p.delete(k)
  }
  const qs = p.toString()
  const url = window.location.pathname + (qs ? '?' + qs : '')
  window.history.replaceState(null, '', url)
}

export function clearUrlPath(): void {
  const p = new URLSearchParams(window.location.search)
  p.delete('path')
  const qs = p.toString()
  window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''))
}

const LAST_NOTE_KEY = 'memoweb_lastNote'

export function saveLastNotePath(path: string): void {
  try {
    localStorage.setItem(LAST_NOTE_KEY, path)
  } catch {}
}

export function getLastNotePath(): string {
  try {
    return localStorage.getItem(LAST_NOTE_KEY) || ''
  } catch {
    return ''
  }
}

export function clearLastNotePath(): void {
  try {
    localStorage.removeItem(LAST_NOTE_KEY)
  } catch {}
}

export function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function formatDate(s: string | null | undefined): string {
  if (s == null) return ''
  try {
    const d = new Date(s)
    if (isNaN(d.getTime())) return String(s).slice(0, 10)
    return d.toLocaleDateString()
  } catch {
    return String(s).slice(0, 10)
  }
}

export function arrayToBase64(arr: Uint8Array | number[] | ArrayLike<number>): string {
  let binary = ''
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]!)
  }
  return btoa(binary)
}

export function commitMsg(date?: Date): string {
  const d = date || new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `memo-web: sync ${ts}`
}

export function highlightCode(code: string, lang: string, hljs: HLJSApi): string {
  if (hljs && lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value
    } catch {}
  }
  if (hljs && !lang) {
    try {
      return hljs.highlightAuto(code).value
    } catch {}
  }
  return escHtml(code)
}

export interface DirtyResult {
  currentFile: Note | null
  notes: Note[]
  isDirty: boolean
}

export function computeDirtyState(
  notes: Note[],
  currentFile: Note | null,
  currentContent: string,
  originalContent: string,
): DirtyResult {
  const dirty = currentContent !== originalContent
  const updatedFile = currentFile ? { ...currentFile, dirty } : null
  return {
    currentFile: updatedFile,
    notes: currentFile ? notes.map(n => (n.path === currentFile.path ? updatedFile! : n)) : notes,
    isDirty: dirty,
  }
}

export interface CleanResult {
  currentFile: Note
  notes: Note[]
  originalContent: string
  isDirty: false
}

/**
 * Open/decrypt transition. The decrypted text is both the dirty-compare
 * baseline and the merge base, so the editor's "unsaved changes" test and the
 * pull decision compare against the same thing.
 *
 * Without the plaintext (`decryptedText` omitted) the base is honestly unknown:
 * pairing a blob SHA with a stale text would produce a bogus three-way merge
 * later, so it degrades to "no base" → the ⚠️ button instead of a wrong answer.
 * app.ts always passes the text.
 */
export function markNoteClean(note: Note, notes: Note[], decryptedText?: string): CleanResult {
  const text = decryptedText ?? ''
  const sha = note.sha ?? null
  const base: Note =
    decryptedText === undefined
      ? withBase({ ...note, dirty: false, decrypted: text, originalText: text }, null, sha)
      : adoptBase({ ...note, dirty: false, decrypted: text }, text, sha)
  return {
    currentFile: base,
    notes: notes.map(n => (n.path === note.path ? base : n)),
    originalContent: text,
    isDirty: false,
  }
}

export interface RevertResult extends CleanResult {
  currentContent: string
}

/**
 * Discarding local edits puts the working copy back on the last synced content
 * — which is what the merge base *is*, so the base is (re)established here. This
 * also heals notes whose base was never recorded (a cache written before the
 * base was tracked) as long as they carry an `originalText`.
 */
export function revertNote(note: Note, notes: Note[]): RevertResult {
  const text = note.originalText || ''
  const updated: Note = adoptBase({ ...note, dirty: false, decrypted: text }, text, note.sha ?? null)
  return {
    currentFile: updated,
    notes: notes.map(n => (n.path === note.path ? updated : n)),
    originalContent: text,
    currentContent: text,
    isDirty: false,
  }
}

export function cleanNoteInList(notes: Note[], filePath: string): Note[] {
  return notes.map(n => (n.path === filePath ? { ...n, dirty: false } : n))
}

export interface SaveCleanResult {
  currentFile: Note
  notes: Note[]
  originalContent: string
  isDirty: false
}

/**
 * State transition for a successful save. Marks the note clean and propagates
 * the NEW blob SHA returned by GitHub into BOTH the open note and the sidebar
 * list. Propagating only into currentFile (the old app.ts behavior) left the
 * note object in state.notes — and therefore the IndexedDB cache — holding a
 * stale SHA, so a later reload restored the stale SHA and the next save got a
 * false 409 conflict against the user's own previous save.
 *
 * The pushed text also becomes the new merge base: what we just committed *is*
 * the last content known to be on the remote, so the next connect is a no-op
 * and a concurrent remote change is measured against what we pushed.
 */
export function saveNoteClean(
  note: Note,
  notes: Note[],
  b64Content: string,
  newSha: string,
  decryptedText?: string,
): SaveCleanResult {
  const text = decryptedText ?? ''
  const written: Note = { ...note, dirty: false, decrypted: text, content: b64Content, sha: newSha }
  const updated: Note = decryptedText === undefined ? withBase(written, null, newSha) : adoptBase(written, text, newSha)
  return {
    currentFile: updated,
    notes: notes.map(n => (n.path === note.path ? updated : n)),
    originalContent: text,
    isDirty: false,
  }
}

/**
 * Reconcile an open note's blob SHA with the remote when the content matches
 * but the SHA is stale (e.g. the app cached its own prior save under the old
 * SHA). Returns null when the SHA already matches, otherwise a state update
 * that also fixes the sidebar list copy.
 */
export function reconcileSha(
  note: Note,
  notes: Note[],
  remoteSha: string,
): { currentFile: Note; notes: Note[] } | null {
  if (note.sha === remoteSha) return null
  const updated: Note = { ...note, sha: remoteSha }
  return { currentFile: updated, notes: notes.map(n => (n.path === note.path ? updated : n)) }
}

export interface RemoteRefreshResult {
  currentFile: Note
  notes: Note[]
  currentContent: string
  originalContent: string
  isDirty: false
}

/**
 * Fast-forward: the remote copy replaced the working copy, so it is also the new
 * merge base. A subsequent connect therefore compares against this SHA and
 * reports "up to date" instead of re-applying.
 */
export function applyRemoteContent(
  note: Note,
  notes: Note[],
  content: string,
  decrypted: string,
  sha: string,
): RemoteRefreshResult {
  const updated: Note = adoptBase({ ...note, content, decrypted, dirty: false, sha }, decrypted, sha)
  return {
    currentFile: updated,
    notes: notes.map(n => (n.path === note.path ? updated : n)),
    currentContent: decrypted,
    originalContent: decrypted,
    isDirty: false,
  }
}

export interface PendingRefresh {
  path: string
  content: string
  sha: string
}

/** Serialize the persisted "remote changed while dirty" warning (null → nothing to store). */
export function serializePendingRefresh(pr: PendingRefresh | null): string | null {
  return pr ? JSON.stringify(pr) : null
}

/** Parse a persisted warning; returns null when missing, malformed, or incomplete. */
export function parsePendingRefresh(raw: string | null): PendingRefresh | null {
  if (!raw) return null
  try {
    const pr = JSON.parse(raw) as Partial<PendingRefresh>
    if (typeof pr.path !== 'string' || typeof pr.content !== 'string' || typeof pr.sha !== 'string') {
      return null
    }
    return { path: pr.path, content: pr.content, sha: pr.sha }
  } catch {
    return null
  }
}

function cacheKeyForPath(path: string | undefined): string {
  return path ? `memoweb_cache:${path}` : 'memoweb_cache:'
}

const DB_NAME = 'MemoWebCache'
const DB_VERSION = 1
const STORE_NAME = 'cache'

function openCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function cacheNotesToLocalStorage(notes: Note[], dirs: Dir[], currentBrowsePath: string): Promise<void> {
  try {
    const db = await openCacheDB()
    const key = cacheKeyForPath(currentBrowsePath)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ notes, dirs, currentBrowsePath, timestamp: Date.now() }, key)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    })
  } catch (e) {
    console.warn('Failed to cache notes:', e)
  }
}

export function pickBestCachedRecord(records: Array<CachedRecord | null> | null | undefined): CachedRecord | null {
  let best: CachedRecord | null = null
  let bestTs = -1
  for (const record of records || []) {
    if (record && record.notes && record.notes.length && (record.timestamp || 0) > bestTs) {
      best = record
      bestTs = record.timestamp || 0
    }
  }
  return best
}

export async function listCachedNotePaths(): Promise<string[]> {
  try {
    const db = await openCacheDB()
    const result = await new Promise<(string | number)[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAllKeys()
      tx.oncomplete = () => db.close()
      req.onsuccess = () => resolve((req.result || []) as (string | number)[])
      req.onerror = () => {
        db.close()
        reject(req.error)
      }
    })
    return result.filter((k): k is string => typeof k === 'string' && k.startsWith('memoweb_cache:'))
  } catch (e) {
    console.warn('Failed to list cached notes:', e)
    return []
  }
}

export async function loadCachedNotes(path: string): Promise<CachedRecord | null> {
  try {
    const db = await openCacheDB()
    const key = cacheKeyForPath(path)
    const result = await new Promise<CachedRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      tx.oncomplete = () => db.close()
      req.onsuccess = () => resolve((req.result as CachedRecord | null) || null)
      req.onerror = () => {
        db.close()
        reject(req.error)
      }
    })
    return result
  } catch (e) {
    console.warn('Failed to load cached notes:', e)
    return null
  }
}

export async function computeCachedTotals(): Promise<{ totalNotes: number; totalDirs: number }> {
  try {
    const keys = await listCachedNotePaths()
    let totalNotes = 0
    let totalDirs = 0
    for (const key of keys) {
      const record = await loadCachedNotes(key.replace(/^memoweb_cache:/, ''))
      if (record) {
        totalNotes += record.notes?.length || 0
        totalDirs += record.dirs?.length || 0
      }
    }
    return { totalNotes, totalDirs }
  } catch (e) {
    console.warn('Failed to compute cached totals:', e)
    return { totalNotes: 0, totalDirs: 0 }
  }
}

/** The suffix a new note is written with: the armored blob, nothing else. */
export const DEFAULT_NOTE_EXT = '.asc'
/** What earlier versions wrote: still listed, opened and saved — never written. */
export const LEGACY_NOTE_EXTS = ['.md.asc', '.md.gpg']
/** Both armored tails, since gpg writes either one. */
const ARMORED_NOTE_EXTS = ['.asc', '.gpg']

/**
 * Every suffix a note file may have: the configured one, then both armored tails
 * and the legacy `.md.asc` / `.md.gpg`. All of them stay recognisable forever,
 * because a repo full of legacy notes must keep working while new ones are
 * written as `.asc` — filtering on a single suffix would hide the entire
 * existing repo.
 *
 * A bare `.asc` / `.gpg` is also what `gpg --export -a KEYID` writes, so such a
 * file is a note *candidate* and can only be told apart once it is opened: that
 * is the one thing `isNoteName` cannot do from a listing, which carries no
 * content. `isArmoredKey()` in `lib/crypto.ts` rejects the key blocks there.
 */
export function noteExtensions(fileExt?: string): string[] {
  const exts = [fileExt, ...ARMORED_NOTE_EXTS, ...LEGACY_NOTE_EXTS]
  return [...new Set(exts.map(e => (e || '').trim()).filter(Boolean))]
}

/** Whether a directory entry is an encrypted note we can list. */
export function isNoteName(name: string, fileExt?: string): boolean {
  return noteExtensions(fileExt).some(ext => name.endsWith(ext))
}

/**
 * The name to show in the sidebar: the file name minus its suffix. Longer
 * suffixes are stripped first, so `note.md.asc` becomes `note` and not `note.md`.
 */
export function noteDisplayName(name: string, fileExt?: string): string {
  const tails = [...noteExtensions(fileExt)].sort((a, b) => b.length - a.length)
  for (const tail of tails) {
    if (name.length > tail.length && name.endsWith(tail)) return name.slice(0, -tail.length)
  }
  return name
}

/**
 * The name a new note is *called* — what the sidebar shows and what a typed name
 * is reduced to before it seeds the body. Every suffix goes: the app appends the
 * configured one to the file name anyway, so `test.asc` must not seed
 * `# test.asc`, and `.md` only ever marked the old `.md.asc` naming, so `test.md`
 * is the note `test` too.
 */
export function noteNameFromInput(input: string, fileExt?: string): string {
  const trimmed = input.trim()
  return noteDisplayName(trimmed.replace(/\.md$/i, ''), fileExt) || trimmed
}

/**
 * The file a new note is written to: the typed name with the configured suffix
 * appended once. `test.md` keeps its `.md` (`test.md.asc`) — the user asked for
 * that name — while `test.asc` must not become `test.asc.asc`.
 */
export function noteFileName(input: string, ext: string): string {
  const trimmed = input.trim()
  return trimmed.endsWith(ext) ? trimmed : `${trimmed}${ext}`
}

export function formatNoteItem(note: Note, activePath: string | undefined, fileExt?: string): string {
  const active = activePath === note.path
  const name = noteDisplayName(note.name, fileExt)
  const cached = !!note.content
  return `<div class="note-item ${active ? 'active' : ''}" data-path="${escAttr(note.path)}" data-type="file">
      <span class="name">📄 ${escHtml(name)}${note.dirty ? ' *' : ''}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${note.dirty ? '<span class="status-badge dirty">unsaved</span>' : ''}
        ${cached ? '<span class="offline-dot" title="Available offline"></span>' : ''}
        <span class="date">${note.date ? escHtml(formatDate(note.date)) : ''}</span>
      </div>
    </div>`
}

export interface MatchRange {
  from: number
  to: number
}

export function findMatchRanges(text: string, query: string): MatchRange[] {
  if (!query) return []
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const len = q.length
  const matches: MatchRange[] = []
  let idx = 0
  while ((idx = lower.indexOf(q, idx)) !== -1) {
    matches.push({ from: idx, to: idx + len })
    idx++
  }
  return matches
}

export interface Crumb {
  label: string
  /** The directory to navigate to; null for the crumb that is the current one. */
  dir: string | null
}

export const HOME_CRUMB = 'root'

/**
 * The breadcrumb trail: a `root` crumb for the app's root (the configured
 * `ghPath`, or the repo root) followed by the folders below it. Every ancestor is
 * a link, the current one is not.
 *
 * The root crumb is what makes the root one click away from any depth — without
 * it the only way up is the sidebar's ".." link, one folder at a time, and at the
 * root of a configured `ghPath` the trail starts mid-path with nothing above it.
 * A word rather than a home icon, so the trail stays a list of folder names.
 */
export function breadcrumbCrumbs(currentBrowsePath: string, rootPath = ''): Crumb[] {
  const root = rootPath || ''
  const current = currentBrowsePath || ''
  const rootParts = root.split('/').filter(Boolean)
  const parts = current.split('/').filter(Boolean)
  // A path cached under a different root setting is shown in full rather than
  // sliced as if it lived below the current root.
  const insideRoot = current === root || (root !== '' && current.startsWith(root + '/'))
  const crumbs: Crumb[] = [{ label: HOME_CRUMB, dir: current === root ? null : root }]
  const below = insideRoot ? parts.slice(rootParts.length) : parts
  let accumulated = insideRoot ? root : ''
  for (let i = 0; i < below.length; i++) {
    const part = below[i]!
    accumulated = accumulated ? `${accumulated}/${part}` : part
    crumbs.push({ label: part, dir: i === below.length - 1 ? null : accumulated })
  }
  return crumbs
}
