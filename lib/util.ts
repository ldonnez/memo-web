import type { HLJSApi } from 'highlight.js'
import type { CachedRecord, Dir, Note } from './types.ts'

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

export function markNoteClean(note: Note, notes: Note[], decryptedText?: string): CleanResult {
  const text = decryptedText ?? ''
  const updated: Note = { ...note, dirty: false, decrypted: text, originalText: text }
  return {
    currentFile: updated,
    notes: notes.map(n => (n.path === note.path ? updated : n)),
    originalContent: text,
    isDirty: false,
  }
}

export interface RevertResult extends CleanResult {
  currentContent: string
}

export function revertNote(note: Note, notes: Note[]): RevertResult {
  const text = note.originalText || ''
  const updated: Note = { ...note, dirty: false, decrypted: text }
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

export function formatNoteItem(note: Note, activePath: string | undefined): string {
  const active = activePath === note.path
  const name = note.name.replace(/\.md\.gpg$/, '').replace(/\.gpg$/, '')
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
