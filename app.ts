import { encryptContent, decryptContent } from './lib/crypto.ts'
import {
  smartEnter,
  handleTab,
  handleShiftTab,
  toggleTaskOnLine,
  toggleTaskByIndex,
  formatTable,
  insertMarkdown,
  insertTimestamp,
  PASS,
} from './lib/editor.ts'
import {
  createEditor,
  setTheme,
  clearHistory,
  replaceDoc,
  setCursor,
  setSelection,
  addMark,
  clearAllMarks,
  offsetToDocPos,
  type CmMark,
} from './lib/cm.ts'
import {
  escHtml,
  getUrlParam,
  setUrlParams,
  clearUrlPath,
  escAttr,
  arrayToBase64,
  commitMsg,
  highlightCode,
  formatNoteItem,
  computeDirtyState,
  markNoteClean,
  saveNoteClean,
  reconcileSha,
  revertNote,
  applyRemoteContent,
  serializePendingRefresh,
  parsePendingRefresh,
  cacheNotesToLocalStorage,
  loadCachedNotes,
  computeCachedTotals,
  listCachedNotePaths,
  pickBestCachedRecord,
  findMatchRanges,
  withTimeout,
  saveLastNotePath,
  getLastNotePath,
  clearLastNotePath,
} from './lib/util.ts'
import type { PendingRefresh } from './lib/util.ts'
import {
  baseOf,
  localWorkingText,
  planPull,
  decidePull,
  carryBases,
  mergeDirListing,
  applyLocalStatus,
  isModified,
  adoptBase,
} from './lib/sync.ts'
import {
  contentCache,
  draftCache,
  restoreDrafts,
  saveDraft,
  removeDraft,
  removeCachedContent,
  pruneContentCache,
} from './lib/draft.ts'
import {
  parseEntries,
  buildStatusText,
  verifyRepo,
  ghGetFile,
  ghListDir,
  ghPutFile,
  ghDeleteFile,
  fetchAllNotesContent,
  walkAllDirsAndPrefetch,
} from './lib/github.ts'
import hljs from './lib/hljs.ts'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { registerSW } from 'virtual:pwa-register'
import { EditorView, type KeyBinding } from '@codemirror/view'
import type { CachedRecord, Config, Dir, Note } from './lib/types.ts'

registerSW({ immediate: true, onRegisteredSW: () => {} })

interface AppState {
  config: Config
  notes: Note[]
  dirs: Dir[]
  currentBrowsePath: string
  currentFile: Note | null
  currentContent: string
  originalContent: string
  isDirty: boolean
  showPreview: boolean
  connected: boolean
  totalNotes: number
  totalDirs: number
}

// ============= STATE =============
let cm: EditorView | null = null
let taskIdx = 0
let pendingRemoteRefresh: { path: string; content: string; sha: string } | null = null
const PENDING_REFRESH_KEY = 'memoweb_pending_refresh'

function byId(id: string): HTMLElement | null {
  return document.getElementById(id)
}

// Typed, existence-asserting lookup (the HTML is static; these IDs always exist)
function byEl<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function closestOf<T extends Element>(target: EventTarget | null, selector: string): T | null {
  return target instanceof Element ? target.closest<T>(selector) : null
}

async function loadFromCache(path: string, extraState: Partial<AppState> = {}) {
  let cached = await loadCachedNotes(path || '')
  if (!cached || !cached.notes || !cached.notes.length) {
    const candidates = await listCachedNotePaths()
    const records: Array<CachedRecord | null> = []
    for (const key of candidates) {
      records.push(await loadCachedNotes(key.replace(/^memoweb_cache:/, '')))
    }
    cached = pickBestCachedRecord(records)
  }
  if (!cached || !cached.notes || !cached.notes.length) return false
  // The record carries each note's merge base, so the offline view knows exactly
  // what the remote looked like when it was cached. `dirty` is re-derived from
  // that base: a note that was merely opened (draft written on navigation, text
  // identical to the base) is not modified and must not be badged as such.
  const notes = applyLocalStatus(cached.notes, p => draftCache.get(p))
  for (const n of notes) {
    if (n.content) contentCache.set(n.path, n.content)
  }
  const totals = await computeCachedTotals()
  state = {
    ...state,
    notes,
    dirs: cached.dirs || [],
    currentBrowsePath: cached.currentBrowsePath || '',
    totalNotes: totals.totalNotes || state.totalNotes,
    totalDirs: totals.totalDirs || state.totalDirs,
    ...extraState,
  }
  setConnectionStatus(`Offline · ${buildStatusText(state.totalNotes, state.totalDirs)}`, false)
  renderNoteList()
  return true
}

function getContent() {
  return cm ? cm.state.doc.toString() : byEl<HTMLTextAreaElement>('editorContent')?.value || ''
}
function setContent(val: string) {
  if (cm) {
    replaceDoc(cm, val)
    clearHistory(cm)
  } else {
    byEl<HTMLTextAreaElement>('editorContent').value = val
  }
}

let state: AppState = {
  config: {},
  notes: [],
  dirs: [],
  currentBrowsePath: '',
  currentFile: null,
  currentContent: '',
  originalContent: '',
  isDirty: false,
  showPreview: false,
  connected: false,
  totalNotes: 0,
  totalDirs: 0,
}

// ============= CONFIG =============
function loadConfig() {
  try {
    const saved = localStorage.getItem('memoweb_config')
    if (saved) state = { ...state, config: JSON.parse(saved) }
  } catch {}
  const owner = getUrlParam('owner')
  const repo = getUrlParam('repo')
  const branch = getUrlParam('branch')
  if (owner || repo || branch) {
    state = {
      ...state,
      config: {
        ...state.config,
        ...(owner && { ghOwner: owner }),
        ...(repo && { ghRepo: repo }),
        ...(branch && { ghBranch: branch }),
      },
    }
  }
  applyConfigToUI()
}
function applyConfigToUI() {
  const c = state.config
  byEl<HTMLInputElement>('ghToken').value = c.ghToken || ''
  byEl<HTMLInputElement>('ghOwner').value = c.ghOwner || ''
  byEl<HTMLInputElement>('ghRepo').value = c.ghRepo || ''
  byEl<HTMLInputElement>('ghBranch').value = c.ghBranch || 'main'
  byEl<HTMLInputElement>('ghPath').value = c.ghPath || ''
  byEl<HTMLInputElement>('fileExt').value = c.fileExt || '.md.gpg'
  byEl<HTMLInputElement>('cryptoMode').value = c.cryptoMode || 'key'
  byEl<HTMLInputElement>('publicKey').value = c.publicKey || ''
  byEl<HTMLInputElement>('privateKey').value = c.privateKey || ''
  byEl<HTMLInputElement>('keyPassphrase').value = c.keyPassphrase || ''
  byEl<HTMLInputElement>('cryptoPassword').value = c.cryptoPassword || ''
  onCryptoModeChange()
}
function saveConfigToState() {
  state = {
    ...state,
    config: {
      ...state.config,
      ghToken: byEl<HTMLInputElement>('ghToken').value.trim(),
      ghOwner: byEl<HTMLInputElement>('ghOwner').value.trim(),
      ghRepo: byEl<HTMLInputElement>('ghRepo').value.trim(),
      ghBranch: byEl<HTMLInputElement>('ghBranch').value.trim() || 'main',
      ghPath: byEl<HTMLInputElement>('ghPath').value.trim(),
      fileExt: byEl<HTMLInputElement>('fileExt').value.trim() || '.md.gpg',
      cryptoMode: byEl<HTMLSelectElement>('cryptoMode').value as 'key' | 'password',
      publicKey: byEl<HTMLInputElement>('publicKey').value.trim(),
      privateKey: byEl<HTMLInputElement>('privateKey').value.trim(),
      keyPassphrase: byEl<HTMLInputElement>('keyPassphrase').value,
      cryptoPassword: byEl<HTMLInputElement>('cryptoPassword').value,
    },
  }
}

function onCryptoModeChange() {
  const mode = byEl<HTMLInputElement>('cryptoMode').value
  byEl<HTMLElement>('keyMode').style.display = mode === 'key' ? 'block' : 'none'
  byEl<HTMLElement>('passwordMode').style.display = mode === 'password' ? 'block' : 'none'
}

// ============= SETTINGS MODAL =============
function openSettings() {
  byEl<HTMLElement>('settingsModal').classList.add('open')
}
function closeSettings() {
  byEl<HTMLElement>('settingsModal').classList.remove('open')
}
function switchTab(tabId: string) {
  document.querySelectorAll<HTMLElement>('.tab').forEach(t => t.classList.toggle('active', t.dataset['tab'] === tabId))
  document.querySelectorAll<HTMLElement>('.tab-content').forEach(t => t.classList.toggle('active', t.id === tabId))
}

async function saveSettings() {
  saveConfigToState()
  try {
    localStorage.setItem('memoweb_config', JSON.stringify(state.config))
  } catch (e) {
    console.warn('localStorage write failed:', e)
  }
  closeSettings()
  await connect()
}

// ============= CONNECT & LIST =============
const CONNECT_TIMEOUT_MS = 15000

async function connect(background = false) {
  const c = state.config
  if (!c.ghToken || !c.ghOwner || !c.ghRepo) {
    setConnectionStatus('Configure settings first', false)
    return
  }

  if (!background) {
    setConnectionStatus('Connecting...', false)
    state = { ...state, notes: [], dirs: [] }
    renderNoteList()
  }

  const startPath = state.currentBrowsePath
  const controller = new AbortController()
  try {
    await withTimeout(doConnect(c, controller.signal), CONNECT_TIMEOUT_MS, () => controller.abort())
  } catch (e) {
    controller.abort()
    console.error('Connection error:', e)
    if (state.currentBrowsePath !== startPath) return
    const fallbackPath = c.ghPath || state.currentBrowsePath
    // A restored subdir note must win over the configured root fallback.
    if (state.currentFile && fallbackPath !== state.currentBrowsePath) return
    if (!(await loadFromCache(fallbackPath))) {
      setConnectionStatus(`Error: ${errMsg(e)}`, false)
      toast(errMsg(e), 'error')
    }
  }
}

async function doConnect(c: Config, signal: AbortSignal) {
  const path = c.ghPath || ''
  const ext = c.fileExt || '.md.gpg'
  const startPath = state.currentBrowsePath
  console.log('Connecting to', `${c.ghOwner}/${c.ghRepo}`, 'path:', path, 'branch:', c.ghBranch)

  // Verify repo exists and is accessible
  const repoData = await verifyRepo(state.config)
  if (signal.aborted) return
  console.log('Repo found:', repoData.full_name, 'default branch:', repoData.default_branch)
  byEl<HTMLElement>('sidebarTitle').textContent = repoData.name

  // Use the repo's default branch if user didn't specify one
  if (!c.ghBranch || c.ghBranch === 'main') {
    const branch = repoData.default_branch || 'main'
    if (state.config.ghBranch !== branch) {
      state = { ...state, config: { ...state.config, ghBranch: branch } }
    }
  }

  const entries = path ? await ghListDir(state.config, path) : await ghListDir(state.config, '')
  if (signal.aborted) return
  if (state.currentBrowsePath !== startPath) return

  // A reconnect must never yank the user out of the directory holding an open
  // note (e.g. a subdir restored by init's openNoteByPath). Keep the restored
  // navigation, but still pull the latest remote content into the open editor.
  if (state.currentFile && state.currentBrowsePath !== path) {
    await refreshOpenNoteContent()
    return
  }

  if (!Array.isArray(entries)) {
    console.warn('Unexpected response from GitHub API, expected array, got:', entries)
    setConnectionStatus('Connected', true)
    renderNoteList()
    byEl<HTMLButtonElement>('newNoteBtn').disabled = false
    return
  }

  const { dirs, notes: listed } = parseEntries(entries, ext)
  // The listing replaces every note object, so carry the merge base (and the
  // pre-prefetch blob of a drafted note) over from the previous notes. The base
  // is deliberately NOT advanced here: only a decrypted observation may move
  // it, and a stale base is exactly what the pull decision needs to detect that
  // the remote moved on.
  const notes = applyLocalStatus(carryBases(listed, state.notes), p => draftCache.get(p))
  // Capture the pre-parse notes (the cached baseline) BEFORE fetchAllNotesContent,
  // so a drafted note's blob survives the connect's own content prefetch and
  // cache write.
  const baselineByPath = new Map(state.notes.map(n => [n.path, n]))
  state = { ...state, dirs, notes, currentBrowsePath: path, totalNotes: notes.length, totalDirs: dirs.length }
  pruneContentCache(notes, path)
  const fetched = await fetchAllNotesContent(state.config, state.notes)
  state = {
    ...state,
    notes: fetched.map(n => (draftCache.has(n.path) ? (baselineByPath.get(n.path) ?? n) : n)),
  }
  if (signal.aborted) return
  if (state.currentBrowsePath !== path) return

  setConnectionStatus(`Connected · ${buildStatusText(state.totalNotes, state.totalDirs)}`, true)
  renderNoteList()
  await cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
  byEl<HTMLButtonElement>('newNoteBtn').disabled = false

  const currentFile = state.currentFile
  if (currentFile) {
    const stillExists = state.notes.find(n => n.path === currentFile.path)
    if (!stillExists) {
      closeEditor()
    } else {
      await refreshOpenNoteContent()
    }
  }

  // The walk rebuilds every note from a fresh listing and carries the merge base
  // out of the record it is about to overwrite, so it must run AFTER the open note
  // has been refreshed: otherwise it reads the pre-pull record and writes the
  // stale base back over the one the pull just advanced.
  setTimeout(
    () =>
      walkAllDirsAndPrefetch(state.config, path, ext)
        .then(({ totalNotes, totalDirs }) => {
          state = { ...state, totalNotes, totalDirs }
          setConnectionStatus(`Connected · ${buildStatusText(totalNotes, totalDirs)}`, true)
        })
        .catch(e => console.warn('background sync:', e.message)),
    0,
  )
}

/**
 * The app's `git pull` for the open note: re-fetch it and reconcile against the
 * merge base instead of asking "is there a draft?".
 *
 * A note with no local divergence fast-forwards silently — including a note that
 * was merely opened and left alone, whose draft is byte-identical to the base.
 * Only genuine divergence (local edits on both sides) raises the ⚠️ button, and
 * that path never pays for a decryption.
 */
async function refreshOpenNoteContent(opts: { announce?: boolean } = {}) {
  const openFile = state.currentFile
  if (!openFile) return
  try {
    const data = await ghGetFile(state.config, openFile.path)
    if (!data || state.currentFile?.path !== openFile.path) return
    const base = baseOf(openFile)
    const working = localWorkingText({
      draft: draftCache.get(openFile.path),
      openText: getContent(),
      isOpenDirty: state.isDirty,
    })
    const plan = planPull({ base, remoteSha: data.sha, working })

    if (plan === 'up-to-date') {
      if (pendingRemoteRefresh?.path === openFile.path || persistedRefreshFor(openFile.path)) {
        clearRemoteRefresh()
      }
      // The remote blob is the one the base was taken from, but the note can
      // still carry a stale SHA (e.g. the cache persisted the app's own prior
      // save under the old one). Reconcile it so the next save does not 409
      // against the user's own previous save.
      const reconciled = reconcileSha(openFile, state.notes, data.sha)
      if (reconciled) {
        state = { ...state, ...reconciled }
        // The repair is what the next save compares against (a stale SHA here is
        // what makes a save 409 against the user's own earlier push), so the
        // record is written before the next pull or walk can observe it.
        await cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
      }
      return
    }

    if (plan === 'conflict') {
      setPendingRemoteRefresh({ path: openFile.path, content: data.content, sha: data.sha })
      return
    }

    const binary = Uint8Array.from(atob(data.content), c => c.charCodeAt(0))
    const decrypted = await decryptContent(state.config, binary)
    if (state.currentFile?.path !== openFile.path) return
    // 'decrypt' means the base is unknown, so the plaintext may still turn out to
    // match the working copy — someone else already carries the same edit.
    const action = plan === 'decrypt' ? decidePull({ base: base.text, working, remote: decrypted }) : 'fast-forward'
    if (action === 'conflict') {
      setPendingRemoteRefresh({ path: openFile.path, content: data.content, sha: data.sha })
      return
    }
    if (action === 'up-to-date') {
      // The working copy is already on the remote, so the draft is redundant
      // rather than conflicting: adopt the remote as the base, drop the draft and
      // leave the editor alone (decrypted === the text the user has).
      removeDraft(openFile.path)
      await adoptRemoteContent(openFile, data.content, decrypted, data.sha)
      return
    }
    // A keystroke (or a navigation draft) may have landed while the blob was in
    // flight — never yank the editor, flag it instead. Compare the CONTENT, not
    // the draft's existence: a draft equal to the base is not a divergence.
    const workingNow = localWorkingText({
      draft: draftCache.get(openFile.path),
      openText: getContent(),
      isOpenDirty: state.isDirty,
    })
    if (isModified(base, workingNow)) {
      setPendingRemoteRefresh({ path: openFile.path, content: data.content, sha: data.sha })
      return
    }
    // Awaited: the caller is often doConnect(), which schedules the background
    // walk straight after this returns. A fire-and-forget write would let the
    // walk read the pre-pull record and write the stale base back over it.
    await adoptRemoteContent(openFile, data.content, decrypted, data.sha)
    if (opts.announce) toast('Updated to the latest remote version', 'info')
  } catch (e) {
    console.warn('Failed to refresh open note:', e instanceof Error ? e.message : e)
  }
}

/**
 * Take the remote copy of the open note: content, editor text and merge base all
 * move to it, and the record is re-persisted. The persist matters — the merge
 * base lives in the IndexedDB record, and the background directory walk
 * re-reads that record and writes it back, so an advance that is not written
 * here is silently reverted (and the note re-pulls on the next load).
 */
function adoptRemoteContent(openFile: Note, content: string, decrypted: string, sha: string) {
  const result = applyRemoteContent(openFile, state.notes, content, decrypted, sha)
  state = { ...state, ...result }
  contentCache.set(openFile.path, content)
  // Taking the remote resolves whatever divergence the ⚠️ button was reporting
  // for this note (e.g. the user undid their side of it, so the next pull can
  // fast-forward instead of asking). Leaving the button up would send them here
  // again for a conflict that no longer exists.
  if (pendingRemoteRefresh?.path === openFile.path || persistedRefreshFor(openFile.path)) {
    clearRemoteRefresh()
  }
  setContent(result.currentContent)
  updatePreview()
  renderNoteList()
  // The note is clean against its new base, so the editor chrome must agree: the
  // 'up-to-date' path reaches here from a dirty editor whose edit the remote
  // already had, and a still-enabled Save would push the same text again.
  byEl<HTMLElement>('editorDirty').style.visibility = 'hidden'
  byEl<HTMLElement>('discardBtn').style.visibility = 'hidden'
  byEl<HTMLButtonElement>('saveBtn').disabled = true
  return cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
}

function persistedRefreshFor(path: string): PendingRefresh | null {
  try {
    const pr = parsePendingRefresh(localStorage.getItem(PENDING_REFRESH_KEY))
    return pr && pr.path === path ? pr : null
  } catch {
    return null
  }
}

function syncRemoteRefreshBtn() {
  const btn = byId('remoteRefreshBtn')
  if (!btn) return
  const openPath = state.currentFile?.path
  // Derive from BOTH memory and the persisted payload: even if something wiped
  // pendingRemoteRefresh during a reopen, the stored warning still shows.
  const show = !!openPath && (pendingRemoteRefresh?.path === openPath || persistedRefreshFor(openPath) !== null)
  btn.style.visibility = show ? 'visible' : 'hidden'
}

function setPendingRemoteRefresh(pr: PendingRefresh) {
  pendingRemoteRefresh = pr
  const raw = serializePendingRefresh(pr)
  if (raw !== null) {
    try {
      localStorage.setItem(PENDING_REFRESH_KEY, raw)
    } catch {}
  }
  syncRemoteRefreshBtn()
}

/** Restore a persisted "remote changed while dirty" warning after a reload. */
function restorePendingRemoteRefresh() {
  let pr: PendingRefresh | null
  try {
    pr = parsePendingRefresh(localStorage.getItem(PENDING_REFRESH_KEY))
  } catch {
    pr = null
  }
  if (!pr) return
  if (!draftCache.has(pr.path)) {
    clearRemoteRefresh()
    return
  }
  pendingRemoteRefresh = pr
}

function clearRemoteRefresh() {
  pendingRemoteRefresh = null
  try {
    localStorage.removeItem(PENDING_REFRESH_KEY)
  } catch {}
  syncRemoteRefreshBtn()
}

/** Discard local edits and load the latest remote version of the open note. */
async function applyPendingRemoteRefresh() {
  const openFile = state.currentFile
  if (!openFile) return
  const remote =
    pendingRemoteRefresh?.path === openFile.path ? pendingRemoteRefresh : persistedRefreshFor(openFile.path)
  if (!remote) return
  // This is the destructive end of a divergence: it drops the local draft and
  // loads the remote copy. A user who just lost a save race lands here from the
  // ⚠️ button without necessarily knowing their text is about to be replaced, so
  // ask while the draft is still intact. Compare against the base, not the
  // draft's existence — a draft equal to the base holds nothing worth keeping.
  const draft = draftCache.get(openFile.path)
  if (draft !== undefined && isModified(baseOf(openFile), draft)) {
    const ok = confirm(
      `Load the remote version of "${openFile.name}"?\n\nYour unsaved changes to this note will be discarded. Copy them first if you want to keep them.`,
    )
    if (!ok) return
  }
  clearRemoteRefresh()
  try {
    const binary = Uint8Array.from(atob(remote.content), c => c.charCodeAt(0))
    const decrypted = await decryptContent(state.config, binary)
    if (state.currentFile?.path !== openFile.path) return
    removeDraft(openFile.path)
    contentCache.set(openFile.path, remote.content)
    const result = applyRemoteContent(openFile, state.notes, remote.content, decrypted, remote.sha)
    state = { ...state, ...result }
    setContent(result.currentContent)
    updatePreview()
    // The base moved to the remote: persist it, or the background walk restores
    // the old one and the next load starts the divergence dance again.
    await cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
    byEl<HTMLElement>('editorDirty').style.visibility = 'hidden'
    byEl<HTMLButtonElement>('discardBtn').style.visibility = 'hidden'
    byEl<HTMLElement>('editorStatus').textContent = ''
    byEl<HTMLButtonElement>('saveBtn').disabled = true
    renderNoteList()
    toast('Loaded latest version from remote', 'info')
  } catch (e) {
    toast(`Failed to load remote version: ${errMsg(e)}`, 'error')
  }
}

/**
 * Explicit `git pull`: refresh the listing, then reconcile the open note through
 * the same merge-base decision the background connect uses. Local work is never
 * thrown away — a note with genuine divergence keeps its draft and gets the ⚠️
 * button instead.
 */
async function pullChanges() {
  const c = state.config
  if (!c.ghToken) {
    toast('Configure settings first', 'error')
    return
  }

  const currentPath = state.currentBrowsePath
  const ext = c.fileExt || '.md.gpg'
  const token = state.currentBrowsePath + '|' + (state.currentFile?.path || '')

  setConnectionStatus('Syncing...', state.connected)

  try {
    const entries = await ghListDir(state.config, currentPath || '')
    if (Array.isArray(entries)) {
      const { dirs, notes: listed } = parseEntries(entries, ext)
      const merged = applyLocalStatus(carryBases(listed, state.notes), p => draftCache.get(p))
      pruneContentCache(merged, currentPath)
      state = { ...state, dirs, notes: merged }
      renderNoteList()
    }
    if (state.currentBrowsePath + '|' + (state.currentFile?.path || '') !== token) return

    const openFile = state.currentFile
    let conflicts = 0
    if (openFile) {
      const stillExists = state.notes.find(n => n.path === openFile.path)
      if (stillExists) {
        // Same merge-base decision as refreshOpenNoteContent, with an explicit
        // announce — the user asked for this sync.
        await refreshOpenNoteContent({ announce: true })
        if (state.currentFile && persistedRefreshFor(state.currentFile.path)) conflicts++
      } else {
        closeEditor()
        toast('Current note was deleted on remote', 'info')
      }
    }

    // Drafts for notes that are not open are left alone: they are local work,
    // and the remote copy is only merged into them when they are opened. Count
    // the ones that genuinely diverge from their base — a draft equal to the base
    // (a note that was merely opened) is not something the user has to act on, and
    // drafts in other directories are none of this directory's business.
    for (const n of state.notes) {
      if (n.path === state.currentFile?.path) continue
      const d = draftCache.get(n.path)
      if (d !== undefined && isModified(baseOf(n), d)) conflicts++
    }

    state = { ...state, notes: await fetchAllNotesContent(state.config, state.notes) }
    if (state.currentBrowsePath + '|' + (state.currentFile?.path || '') !== token) return

    setConnectionStatus(`Synced · ${buildStatusText(state.totalNotes, state.totalDirs)}`, true)
    renderNoteList()
    await cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
    const basePath = c.ghPath || ''
    setTimeout(
      () =>
        walkAllDirsAndPrefetch(state.config, basePath, ext)
          .then(({ totalNotes, totalDirs }) => {
            state = { ...state, totalNotes, totalDirs }
            setConnectionStatus(`Connected · ${buildStatusText(totalNotes, totalDirs)}`, true)
          })
          .catch(e => console.warn('background sync:', e.message)),
      0,
    )
    toast(
      conflicts
        ? `Synced with remote · ${conflicts} note${conflicts === 1 ? '' : 's'} kept local edits`
        : 'Synced with remote',
      conflicts ? 'warning' : 'info',
    )
  } catch (e) {
    setConnectionStatus('Sync failed', state.connected)
    toast(`Sync failed: ${errMsg(e)}`, 'error')
  }
}

function setConnectionStatus(text: string, connected: boolean) {
  state = { ...state, connected }
  const el = byEl<HTMLElement>('connectionStatus')
  const icon = connected ? '🟢' : text.startsWith('Error') ? '🔴' : text.includes('Connect') ? '🟡' : '⚪'
  el.innerHTML = `<span>${icon}</span><span class="label"> ${escHtml(text)}</span>`
  el.style.color = connected ? 'var(--green)' : text.startsWith('Error') ? 'var(--red)' : 'var(--text-muted)'
  const ps = byEl<HTMLElement>('placeholderStatus')
  if (ps) ps.textContent = text
}

function renderBreadcrumb() {
  const el = byEl<HTMLElement>('breadcrumb')
  const current = state.currentBrowsePath
  const parts = current ? current.split('/').filter(Boolean) : []
  if (parts.length === 0) {
    el.textContent = current ? '/' : ''
    return
  }
  let html = ''
  let accumulated = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    accumulated = accumulated ? accumulated + '/' + part : part
    const label = escHtml(part)
    if (i === parts.length - 1) {
      html += `<span style="color:var(--text);font-weight:500;">${label}</span>`
    } else {
      html += `<a href="#" data-dir="${escAttr(accumulated)}" style="color:var(--accent)">${label}</a><span style="color:var(--text-muted);margin:0 4px;">/</span>`
    }
  }
  el.innerHTML = html
}

// ============= RENDER NOTE LIST =============
function renderNoteList() {
  const list = byEl<HTMLElement>('noteList')
  renderBreadcrumb()
  syncRemoteRefreshBtn()

  if (state.dirs.length === 0 && state.notes.length === 0) {
    const msg = state.connected ? 'Empty directory' : 'Configure your repo in settings to get started'
    list.innerHTML = `<div class="empty-state"><div class="icon">📁</div><p>${msg}</p></div>`
    return
  }
  const items = []

  // Parent directory link (when not at root)
  if (state.currentBrowsePath) {
    const parent = state.currentBrowsePath.split('/').slice(0, -1).join('/') || ''
    items.push(`<div class="note-item" data-path="${escAttr(parent)}" data-type="dir">
      <span class="name" style="color:var(--text-muted)">🔙 ..</span>
      <span style="font-size:11px;color:var(--text-muted)">parent</span>
    </div>`)
  }

  // Directories first
  state.dirs.forEach(d => {
    items.push(`<div class="note-item" data-path="${escAttr(d.path)}" data-type="dir">
      <span class="name" style="color:var(--accent)">📁 ${escHtml(d.name)}</span>
      <span style="font-size:11px;color:var(--text-muted)">folder</span>
    </div>`)
  })

  // Then files
  state.notes.forEach(n => {
    items.push(formatNoteItem(n, state.currentFile?.path))
  })

  list.innerHTML = items.join('')
}

function formatDoc() {
  if (!cm || !state.currentFile) return
  const editor = cm
  import('prettier')
    .then(prettier => Promise.all([prettier, import('prettier/plugins/markdown')]))
    .then(([prettier, { default: markdown }]) =>
      prettier.format(editor.state.doc.toString(), { parser: 'markdown', plugins: [markdown] }),
    )
    .then(formatted => {
      const cursor = offsetToDocPos(editor, editor.state.selection.main.head)
      const scrollInfo = editor.scrollDOM
      replaceDoc(editor, formatted)
      clearHistory(editor)
      setCursor(editor, cursor, false)
      editor.scrollDOM.scrollLeft = scrollInfo.scrollLeft
      editor.scrollDOM.scrollTop = scrollInfo.scrollTop
      onEditorInput()
    })
}

async function openNoteByPath(path: string) {
  let note = state.notes.find(n => n.path === path)
  if (note) {
    selectNote(path)
    return
  }
  const parts = path.split('/')
  if (parts.length > 1) {
    const dir = parts.slice(0, -1).join('/')
    try {
      // No prefetch: advance the target note's content would clobber the
      // dirty-compare baseline refreshOpenNoteContent relies on.
      await navigateToDir(dir, { prefetch: false })
      note = state.notes.find(n => n.path === path)
      if (note) selectNote(path)
    } catch (e) {
      toast(`Could not open note: ${errMsg(e)}`, 'error')
    }
  }
}

async function navigateToDir(dirPath: string, opts: { prefetch?: boolean } = {}) {
  const { prefetch = true } = opts
  const dirtyFile = state.currentFile
  if (dirtyFile && state.isDirty) {
    saveDraft(dirtyFile.path, state.currentContent)
    closeEditor()
  }

  setConnectionStatus('Loading...', state.connected)
  const c = state.config
  const startPath = state.currentBrowsePath

  try {
    const entries = await ghListDir(state.config, dirPath || '')
    if (state.currentBrowsePath !== startPath) return
    if (!Array.isArray(entries)) {
      setConnectionStatus('Connected', true)
      return
    }

    const ext = c.fileExt || '.md.gpg'
    const { dirs, notes: listed } = parseEntries(entries, ext)
    // The merge base (and the pre-edit blob of a drafted note) live in the TARGET
    // directory's own cache record, not in the notes we are navigating away from —
    // carrying from `state.notes` would match nothing and silently drop both.
    const cached = await loadCachedNotes(dirPath || '')
    const merged = applyLocalStatus(
      mergeDirListing(listed, cached?.notes ?? [], p => draftCache.has(p)),
      p => draftCache.get(p),
    )
    state = { ...state, dirs, notes: merged, currentBrowsePath: dirPath, currentFile: null, isDirty: false }
    closeEditor()
    pruneContentCache(merged, dirPath)

    if (prefetch) {
      state = { ...state, notes: await fetchAllNotesContent(state.config, state.notes) }
      if (state.currentBrowsePath !== dirPath) return
    }

    setConnectionStatus(`Connected · ${buildStatusText(state.totalNotes, state.totalDirs)}`, true)
    renderNoteList()
    await cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
  } catch (e) {
    if (state.currentBrowsePath !== startPath) return
    console.error('Directory navigation error:', e)
    state = { ...state, currentFile: null, isDirty: false }
    closeEditor()
    if (!(await loadFromCache(dirPath || ''))) {
      setConnectionStatus(`Error: ${errMsg(e)}`, false)
      toast(errMsg(e), 'error')
    }
  }
}

// ============= NOTE SELECTION =============
async function selectNote(path: string) {
  const found = state.notes.find(n => n.path === path)
  if (!found) return
  let note: Note = found

  if (state.currentFile && state.isDirty) {
    saveDraft(state.currentFile.path, state.currentContent)
  }

  setUrlParams({ path: note.path })
  saveLastNotePath(note.path)
  state = { ...state, currentFile: note, isDirty: false }
  renderNoteList()

  byEl<HTMLElement>('placeholder').style.display = 'none'
  byEl<HTMLElement>('editor').style.display = 'flex'
  byEl<HTMLElement>('editorFilename').textContent = note.name

  const draft = draftCache.get(note.path)
  if (draft !== undefined) {
    // The draft is the working copy; the merge base stays pinned at the content
    // the user started editing from, so a later pull can tell "left untouched"
    // (fast-forward) from "edited on both sides" (conflict).
    let base = baseOf(note)
    if (base.text === null && note.content) {
      // Base unknown (first open on this device, or a cache written before the
      // base was tracked). The cached blob is the best available stand-in for
      // "what was last on the remote" — and it is the pre-edit one, because the
      // prefetch skips drafted notes. Decrypting it also makes the discard button
      // revert to real content instead of an empty note.
      try {
        const binary = Uint8Array.from(atob(note.content), c => c.charCodeAt(0))
        const decryptedBase = await decryptContent(state.config, binary)
        if (state.currentFile?.path !== note.path) return
        base = { text: decryptedBase, sha: note.sha }
        note = adoptBase(note, decryptedBase, note.sha)
        state = {
          ...state,
          notes: state.notes.map(n => (n.path === note.path ? note : n)),
          currentFile: note,
        }
      } catch (e) {
        console.warn('Could not establish merge base for', note.path, errMsg(e))
      }
    }
    if (!isModified(base, draft)) {
      // A draft byte-identical to the base means the note was opened and left
      // alone — the draft is written on every navigation, so this is the common
      // case, not a real edit. Drop it and load the note cleanly, which is what
      // lets a changed remote fast-forward instead of raising ⚠️.
      removeDraft(note.path)
    } else {
      const baseline = base.text ?? ''
      // The note's own baseline must be re-pointed at the merge base, not left at
      // whatever the listing carried (usually ''). revertNote() reads originalText
      // and then adopts it as the base, so a stale '' would make Discard empty the
      // note and record '' as the last synced content.
      note = { ...note, originalText: baseline }
      setContent(draft)
      state = {
        ...state,
        notes: applyLocalStatus(
          state.notes.map(n => (n.path === note.path ? note : n)),
          p => draftCache.get(p),
        ),
        currentFile: note,
        currentContent: draft,
        originalContent: baseline,
        isDirty: true,
      }
      byEl<HTMLElement>('editorDirty').style.visibility = 'visible'
      byEl<HTMLButtonElement>('discardBtn').style.visibility = 'visible'
      byEl<HTMLElement>('editorStatus').textContent = ''
      byEl<HTMLButtonElement>('saveBtn').disabled = false
      byEl<HTMLButtonElement>('deleteBtn').disabled = false
      updatePreview()
      renderNoteList()
      return
    }
  }

  byEl<HTMLElement>('editorDirty').style.visibility = 'hidden'
  byEl<HTMLElement>('editorStatus').textContent = 'Decrypting...'
  state = { ...state, originalContent: '' }
  setContent('')
  byEl<HTMLButtonElement>('saveBtn').disabled = true
  byEl<HTMLButtonElement>('deleteBtn').disabled = true

  try {
    // Fetch from GitHub if not cached
    if (!note.content) {
      const data = await ghGetFile(state.config, note.path)
      if (!data) throw new Error('File not found')
      if (state.currentFile?.path !== note.path) return
      const updatedNote = { ...note, content: data.content, sha: data.sha }
      state = {
        ...state,
        notes: state.notes.map(n => (n.path === note.path ? updatedNote : n)),
        currentFile: updatedNote,
      }
      note = updatedNote
    }

    const binary = Uint8Array.from(atob(note.content!), c => c.charCodeAt(0))
    const decrypted = await decryptContent(state.config, binary)
    if (state.currentFile?.path !== note.path) return
    const clean = markNoteClean(note, state.notes, decrypted)
    state = {
      ...state,
      ...clean,
      currentContent: decrypted,
    }
    await cacheNotesToLocalStorage(state.notes, state.dirs, state.currentBrowsePath)
    setContent(decrypted)
    byEl<HTMLElement>('editorStatus').textContent = ''
    byEl<HTMLButtonElement>('saveBtn').disabled = true
    byEl<HTMLButtonElement>('deleteBtn').disabled = false

    updatePreview()
  } catch (e) {
    byEl<HTMLElement>('editorStatus').textContent = `❌ ${errMsg(e)}`
    toast(`Failed to decrypt: ${errMsg(e)}`, 'error')
  }
}

function closeEditor() {
  state = { ...state, currentFile: null, isDirty: false }
  clearUrlPath()
  clearLastNotePath()
  byEl<HTMLElement>('placeholder').style.display = 'flex'
  byEl<HTMLElement>('editor').style.display = 'none'
  renderNoteList()
}

// ============= EDITOR =============
document.addEventListener('DOMContentLoaded', () => {
  // Init editor (CodeMirror 6, created in lib/cm.ts); textarea is the fallback
  const ta = byEl<HTMLTextAreaElement>('editorContent')
  const host = byEl<HTMLElement>('editorHost')
  if (host) {
    const bindings: KeyBinding[] = [
      {
        key: 'Tab',
        run: () => {
          if (cm) handleTab(cm)
          return true
        },
      },
      { key: 'Shift-Tab', run: () => (cm && handleShiftTab(cm) === PASS ? false : true) },
      {
        key: 'Ctrl-Enter',
        run: () => {
          if (cm) toggleTaskOnLine(cm, state.currentFile, onEditorInput)
          return true
        },
      },
      {
        key: 'Enter',
        run: () => (cm && smartEnter(cm, { formatTable, onEditorInput }) === PASS ? false : true),
      },
    ]
    const rootStyle = getComputedStyle(document.documentElement)
    cm = createEditor({
      parent: host,
      initialValue: '',
      onChange: onEditorInput,
      themeName: rootStyle.getPropertyValue('--bg').trim() === '#ffffff' ? 'latte' : 'frappe',
      keymapBindings: bindings,
    })
    ta.style.display = 'none'
  } else {
    ta.addEventListener('input', onEditorInput)
  }

  // Refresh editor when shown (fixes layout)
  const observer = new MutationObserver(() => {
    const editor = cm
    if (editor) setTimeout(() => editor.requestMeasure(), 50)
  })
  observer.observe(byEl<HTMLElement>('editor'), { attributes: true, attributeFilter: ['style'] })

  // Event delegation for note/dir list clicks
  byEl<HTMLElement>('noteList').addEventListener('click', e => {
    const item = closestOf<HTMLElement>(e.target, '.note-item')
    if (!item) return
    if (item.dataset['type'] === 'dir') {
      navigateToDir(item.dataset['path'] || '')
    } else if (item.classList.contains('search-injected')) {
      openNoteByPath(item.dataset['path'] || '')
    } else {
      selectNote(item.dataset['path'] || '')
    }
  })
  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (state.currentFile) saveNote()
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault()
      if (state.currentFile) toggleSearch()
    }
    if (e.key === 'Escape') {
      const editorSearch = byEl<HTMLElement>('editorSearch')
      const previewSearch = byEl<HTMLElement>('previewSearch')
      if (editorSearch && editorSearch.style.display !== 'none') {
        toggleSearch()
      } else if (previewSearch && previewSearch.style.display !== 'none') {
        togglePreviewSearch()
      }
    }
  })
})

function onEditorInput() {
  const newContent = getContent()
  const result = computeDirtyState(state.notes, state.currentFile, newContent, state.originalContent)
  state = { ...state, currentContent: newContent, ...result }
  if (state.currentFile) {
    // The draft is the persisted working copy, so it has to track the editor in
    // BOTH directions. Only writing it while dirty leaves the abandoned text of
    // an undone edit behind: it would resurrect on the next open, badge the note
    // unsaved forever, and make every later remote change a ⚠️ conflict. Since
    // `isDirty` compares against the merge base, "not dirty" means the draft
    // would be byte-identical to the base — i.e. no local work worth keeping.
    if (result.isDirty) saveDraft(state.currentFile.path, newContent)
    else removeDraft(state.currentFile.path)
  }
  const filenameEl = byEl<HTMLElement>('editorFilename')
  const dirtyEl = byEl<HTMLElement>('editorDirty')
  const baseName = state.currentFile ? state.currentFile.name : ''
  byEl<HTMLButtonElement>('saveBtn').disabled = !result.isDirty
  if (result.isDirty) {
    byEl<HTMLElement>('editorStatus').textContent = ''
    byEl<HTMLButtonElement>('discardBtn').style.visibility = 'visible'
    filenameEl.textContent = baseName
    dirtyEl.style.visibility = 'visible'
  } else {
    byEl<HTMLElement>('editorStatus').textContent = ''
    byEl<HTMLButtonElement>('discardBtn').style.visibility = 'hidden'
    filenameEl.textContent = baseName
    dirtyEl.style.visibility = 'hidden'
  }
  renderNoteList()
  if (state.showPreview) updatePreview(false)
}

function togglePreview() {
  state = { ...state, showPreview: !state.showPreview }
  const pc = byEl<HTMLElement>('previewContainer')
  pc.style.display = state.showPreview ? 'flex' : 'none'
  byEl<HTMLButtonElement>('previewToggle').disabled = state.showPreview
  byEl<HTMLButtonElement>('previewToggle').innerHTML = '👁️ <span class="label">Preview</span>'
  if (state.showPreview) {
    updatePreview()
  } else {
    byEl<HTMLElement>('previewPane').innerHTML = ''
  }
  const editor = cm
  if (editor) setTimeout(() => editor.requestMeasure(), 50)
}

function updatePreview(resetScroll = true) {
  const preview = byEl<HTMLElement>('previewPane')
  const text = getContent()
  preview.innerHTML = renderMarkdown(text)
  CSS.highlights.clear()
  if (resetScroll) preview.scrollTop = 0
}

function sanitizeHtml(html: string) {
  return DOMPurify.sanitize(html)
}

function renderMarkdown(text: string) {
  taskIdx = 0
  return sanitizeHtml(marked.parse(text, { breaks: true, gfm: true }) as string)
}

marked.use({
  renderer: {
    code({ text, lang }) {
      const highlighted = highlightCode(text, lang || '', hljs)
      return `<pre><code class="language-${escAttr(lang || 'plaintext')}">${highlighted}</code></pre>`
    },
    listitem({ text, task, checked }) {
      if (task) {
        const idx = taskIdx++
        return `<li style="list-style:none;"><input type="checkbox" ${checked ? 'checked' : ''} data-task-idx="${idx}"> ${text}</li>`
      }
      return `<li>${text}</li>`
    },
  },
})

// ============= SEARCH =============
type CmMatch = { from: number; to: number }
let searchMatches: Array<CmMatch | Range> = []
let searchIndex = -1
let searchCurrentMark: CmMark | null = null
let searchInPreviewMode = false
let searchDebounce: ReturnType<typeof setTimeout> | null = null
let searchCountEls: NodeListOf<HTMLElement> | null = null

function getSearchCountEls(): NodeListOf<HTMLElement> {
  if (!searchCountEls) searchCountEls = document.querySelectorAll<HTMLElement>('.search-count')
  return searchCountEls
}

function debouncedSearch(query: string, forcePreview: boolean) {
  clearTimeout(searchDebounce ?? undefined)
  searchDebounce = setTimeout(() => doSearch(query, forcePreview), 300)
}

function toggleSearch() {
  const el = byEl<HTMLElement>('editorSearch')
  if (el.style.display !== 'none') {
    el.style.display = 'none'
    clearSearch()
    cm && cm.focus()
  } else {
    byEl<HTMLElement>('previewSearch').style.display = 'none'
    el.style.display = 'flex'
    const input = byEl<HTMLInputElement>('searchInput')
    input.value = ''
    input.focus()
    getSearchCountEls().forEach(el => (el.textContent = ''))
    clearSearch()
  }
}

function togglePreviewSearch() {
  const el = byEl<HTMLElement>('previewSearch')
  if (el.style.display !== 'none') {
    el.style.display = 'none'
    clearSearch()
  } else {
    byEl<HTMLElement>('editorSearch').style.display = 'none'
    el.style.display = 'flex'
    const input = byEl<HTMLInputElement>('previewSearchInput')
    input.value = ''
    input.focus()
    getSearchCountEls().forEach(el => (el.textContent = ''))
    clearSearch()
  }
}

function doSearch(query: string, forcePreview: boolean) {
  clearSearch()
  if (!query || !cm) {
    getSearchCountEls().forEach(el => (el.textContent = ''))
    return
  }
  const preview = byEl<HTMLElement>('previewContainer')
  searchInPreviewMode = forcePreview || (preview && preview.style.display !== 'none' && preview.style.display !== '')
  if (searchInPreviewMode) {
    searchInPreview(query)
  } else {
    searchInEditor(query)
  }
}

function searchInEditor(query: string) {
  if (!cm) return
  const text = cm.state.doc.toString()
  const matches = findMatchRanges(text, query)
  searchMatches = []
  for (const m of matches) {
    searchMatches.push({ from: m.from, to: m.to })
    addMark(cm, m.from, m.to, 'search-match')
  }
  if (searchMatches.length) {
    searchIndex = 0
    selectSearchMatch(0)
  } else {
    getSearchCountEls().forEach(el => (el.textContent = '0 results'))
  }
}

function searchInPreview(query: string) {
  const pane = byEl<HTMLElement>('previewPane')
  if (!query) {
    CSS.highlights.clear()
    searchMatches = []
    getSearchCountEls().forEach(el => (el.textContent = ''))
    return
  }
  const q = query.toLowerCase()
  const len = q.length
  searchMatches = []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT, null)

  CSS.highlights.clear()
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent
    const lower = text!.toLowerCase()
    let idx = 0
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      const range = document.createRange()
      range.setStart(node, idx)
      range.setEnd(node, idx + len)
      ranges.push(range)
      idx += 1
    }
  }
  if (ranges.length) {
    const highlight = new Highlight()
    for (const range of ranges) highlight.add(range)
    CSS.highlights.set('search-highlight', highlight)
  }

  searchMatches = ranges
  if (!searchMatches.length) {
    getSearchCountEls().forEach(el => (el.textContent = '0 results'))
    return
  }
  searchIndex = 0
  selectSearchMatch(0)
}

function selectSearchMatch(index: number) {
  if (!searchMatches.length) return
  searchIndex = (index + searchMatches.length) % searchMatches.length
  const editor = cm
  if (searchInPreviewMode) {
    CSS.highlights.set('search-current', new Highlight())
    const range = searchMatches[searchIndex]
    if (range instanceof Range) {
      CSS.highlights.set('search-current', new Highlight(range))
      const pane = byEl<HTMLElement>('previewPane')
      const rect = range.getBoundingClientRect()
      const paneRect = pane.getBoundingClientRect()
      pane.scrollTop += rect.top - paneRect.top - paneRect.height / 2
    }
  } else if (editor) {
    if (searchCurrentMark) {
      searchCurrentMark.clear()
      searchCurrentMark = null
    }
    const m = searchMatches[searchIndex]
    if (m && 'from' in m && 'to' in m) {
      setSelection(editor, m.from, m.to)
      searchCurrentMark = addMark(editor, m.from, m.to, 'search-match-current')
      editor.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: 'nearest', yMargin: 100 }) })
    }
  }
  getSearchCountEls().forEach(el => (el.textContent = `${searchIndex + 1} of ${searchMatches.length}`))
}

function searchNext() {
  clearTimeout(searchDebounce ?? undefined)
  selectSearchMatch(searchIndex + 1)
}

function searchPrev() {
  clearTimeout(searchDebounce ?? undefined)
  selectSearchMatch(searchIndex - 1)
}

function clearSearch() {
  clearTimeout(searchDebounce ?? undefined)
  CSS.highlights.clear()
  if (cm) {
    cm.dispatch({ selection: { anchor: cm.state.selection.main.head } })
    clearAllMarks(cm)
  }
  searchMatches = []
  searchIndex = -1
  searchInPreviewMode = false
  getSearchCountEls().forEach(el => (el.textContent = ''))
}

function discardChanges() {
  const note = state.currentFile
  if (!note) return

  if (!note.sha) {
    // New unsaved note — remove from sidebar and close
    if (!confirm('Discard this new note?')) return
    removeDraft(note.path)
    state = { ...state, notes: state.notes.filter(n => n.path !== note.path) }
    closeEditor()
    renderNoteList()
    toast('Note discarded', 'info')
    return
  }

  // Existing note — revert to last saved content
  removeDraft(note.path)
  clearRemoteRefresh()
  const result = revertNote(note, state.notes)
  state = { ...state, ...result }

  setContent(result.currentContent)
  byEl<HTMLElement>('editorStatus').textContent = ''
  byEl<HTMLButtonElement>('discardBtn').style.visibility = 'hidden'
  updatePreview()
  renderNoteList()
  toast('Changes discarded', 'info')
}

// ============= SAVE / DELETE =============
async function saveNote() {
  if (!state.currentFile) return
  const text = getContent()
  const btn = byEl<HTMLButtonElement>('saveBtn')
  const origHTML = btn.innerHTML
  btn.disabled = true
  btn.innerHTML =
    '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;vertical-align:middle"><span class="spinner"></span></span> <span class="label">Save</span>'

  try {
    const encrypted = await encryptContent(state.config, text)
    const note = state.currentFile
    const b64 = typeof encrypted === 'string' ? btoa(encrypted) : arrayToBase64(encrypted)

    const result = await ghPutFile(state.config, note.path, encrypted, commitMsg(), note.sha)
    const clean = saveNoteClean(note, state.notes, b64, result.content.sha, text)
    removeDraft(note.path)
    contentCache.set(note.path, b64)
    state = { ...state, ...clean }
    await cacheNotesToLocalStorage(clean.notes, state.dirs, state.currentBrowsePath)

    toast('Note saved successfully', 'success')
    clearRemoteRefresh()
    byEl<HTMLElement>('editorDirty').style.visibility = 'hidden'
    byEl<HTMLButtonElement>('discardBtn').style.visibility = 'hidden'
    btn.disabled = true
    renderNoteList()
  } catch (e) {
    const msg = errMsg(e)
    const isConflict = msg.includes('does not match') || msg.includes('409') || msg.toLowerCase().includes('conflict')
    // The old wording sent the user to 🔄 Sync, which only re-raises the ⚠️
    // button — and that button loads the remote over the local edit. Name the
    // trade-off instead of implying a save will just work.
    toast(
      isConflict
        ? '⛔ Remote file changed since your last sync — your edit was NOT saved. Copy your text, then use ⚠️ Remote to load theirs (that discards your edit) or discard locally to start from theirs.'
        : `Save failed: ${msg}`,
      'error',
    )
    btn.disabled = false
  } finally {
    btn.innerHTML = origHTML
  }
}

async function newNote() {
  if (state.currentFile && state.isDirty) {
    saveDraft(state.currentFile.path, state.currentContent)
  }

  const name = prompt('Note name (e.g., my-note):')
  if (!name || !name.trim()) return

  const ext = state.config.fileExt || '.md.gpg'
  const dir = state.currentBrowsePath || state.config.ghPath || ''
  const path = dir ? `${dir}/${name.trim()}${ext}` : `${name.trim()}${ext}`

  // Check if exists
  const existing = await ghGetFile(state.config, path)
  if (existing) {
    toast('A note with this name already exists', 'error')
    return
  }

  state = { ...state, currentFile: null, isDirty: false }

  byEl<HTMLElement>('placeholder').style.display = 'none'
  byEl<HTMLElement>('editor').style.display = 'flex'
  byEl<HTMLElement>('editorFilename').textContent = `${name.trim()}${ext}`
  byEl<HTMLElement>('editorDirty').style.visibility = 'hidden'
  clearRemoteRefresh()
  byEl<HTMLElement>('editorStatus').textContent = '🆕 New note'
  setContent(`# ${name.trim()}\n\n`)
  byEl<HTMLButtonElement>('saveBtn').disabled = false
  byEl<HTMLButtonElement>('deleteBtn').disabled = true
  const currentContent = getContent()
  state = { ...state, currentContent, originalContent: '', isDirty: true }

  // Create a temporary note object and add to sidebar immediately
  const newNoteObj = {
    name: `${name.trim()}${ext}`,
    path: path,
    sha: null,
    size: 0,
    date: '',
    dirty: true,
    content: null,
    decrypted: currentContent,
    originalText: '',
  }
  state = {
    ...state,
    currentFile: newNoteObj,
    notes: [...state.notes, newNoteObj].sort((a, b) => a.name.localeCompare(b.name)),
  }

  renderNoteList()
  updatePreview()
}

async function deleteNote() {
  if (!state.currentFile || !state.currentFile.sha) return
  if (!confirm(`Delete "${state.currentFile.name}"? This cannot be undone.`)) return

  try {
    await ghDeleteFile(state.config, state.currentFile.path, state.currentFile.sha, commitMsg())
    const deletedPath = state.currentFile.path
    removeDraft(deletedPath)
    removeCachedContent(deletedPath)
    clearRemoteRefresh()
    state = { ...state, notes: state.notes.filter(n => n.path !== deletedPath) }
    closeEditor()
    toast('Note deleted', 'info')
    renderNoteList()
  } catch (e) {
    toast(`Delete failed: ${errMsg(e)}`, 'error')
  }
}

// ============= UTILITIES =============
function toast(message: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') {
  const container = byEl<HTMLElement>('toastContainer')
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  container.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = '0.3s'
    setTimeout(() => el.remove(), 300)
  }, 4000)
}

function toggleTheme() {
  const root = document.documentElement
  const isDark =
    root.style.getPropertyValue('--bg') === '#ffffff' ||
    getComputedStyle(root).getPropertyValue('--bg').trim() === '#ffffff'
  if (isDark) {
    root.style.setProperty('--bg', '#0d1117')
    root.style.setProperty('--surface', '#161b22')
    root.style.setProperty('--surface-2', '#21262d')
    root.style.setProperty('--border', '#30363d')
    root.style.setProperty('--text', '#e6edf3')
    root.style.setProperty('--text-muted', '#8b949e')
    byEl<HTMLButtonElement>('themeBtn').textContent = '🌙'
    if (cm) setTheme(cm, 'frappe')
  } else {
    root.style.setProperty('--bg', '#ffffff')
    root.style.setProperty('--surface', '#f6f8fa')
    root.style.setProperty('--surface-2', '#eaeef2')
    root.style.setProperty('--border', '#d0d7de')
    root.style.setProperty('--text', '#1f2328')
    root.style.setProperty('--text-muted', '#656d76')
    byEl<HTMLButtonElement>('themeBtn').textContent = '☀️'
    if (cm) setTheme(cm, 'latte')
  }
}

function sidebarSearch(query: string) {
  const q = query.toLowerCase()
  const list = byEl<HTMLElement>('noteList')

  // Remove any previously injected cross-dir results
  list.querySelectorAll<HTMLElement>('.note-item.search-injected').forEach(el => el.remove())

  // Filter visible items
  const items = list.querySelectorAll<HTMLElement>('.note-item:not(.search-injected)')
  const isParent = (el: HTMLElement) => el.querySelector('.name')?.textContent?.trim() === '🔙 ..'
  items.forEach(el => {
    if (!q) {
      el.style.display = ''
      return
    }
    if (isParent(el)) {
      el.style.display = 'none'
      return
    }
    const name = el.querySelector('.name')
    el.style.display = name && name.textContent && name.textContent.toLowerCase().includes(q) ? '' : 'none'
  })

  if (!q) return

  // Search across cached notes from all directories
  const visiblePaths = new Set<string>()
  list.querySelectorAll<HTMLElement>('.note-item[data-type="file"]').forEach(el => {
    const p = el.getAttribute('data-path')
    if (p) visiblePaths.add(p)
  })

  const extra: Array<{ path: string; name: string }> = []
  contentCache.forEach((_val, path) => {
    if (visiblePaths.has(path)) return
    const name = path
      .split('/')
      .pop()!
      .replace(/\.md\.gpg$/, '')
      .replace(/\.gpg$/, '')
    if (name.toLowerCase().includes(q)) {
      extra.push({ path, name })
    }
  })

  if (extra.length) {
    const frag = document.createDocumentFragment()
    extra.forEach(n => {
      const dir = n.path.split('/').slice(0, -1).join('/')
      const div = document.createElement('div')
      div.className = 'note-item search-injected'
      div.setAttribute('data-path', n.path)
      div.setAttribute('data-type', 'file')
      div.style.cursor = 'pointer'
      div.innerHTML = `<span class="name">📄 ${escHtml(n.name)}</span><span style="font-size:11px;color:var(--text-muted)">${escHtml(dir)}</span>`
      frag.appendChild(div)
    })
    list.appendChild(frag)
  }
}

function toggleSidebar() {
  const sidebar = byEl<HTMLElement>('sidebar')
  const overlay = byEl<HTMLElement>('sidebarOverlay')
  const open = sidebar.classList.toggle('open')
  overlay.classList.toggle('open', open)
}

// Keep --header-h in sync with actual header height
function syncHeaderH() {
  const h = (document.querySelector('header') as HTMLElement).offsetHeight
  document.documentElement.style.setProperty('--header-h', h + 'px')
}
document.addEventListener('DOMContentLoaded', syncHeaderH)
window.addEventListener('load', syncHeaderH)
window.addEventListener('resize', syncHeaderH)
window.addEventListener('orientationchange', () => setTimeout(syncHeaderH, 100))

// When the network comes back, reconnect in the background so the restored note
// picks up origin changes (refreshOpenNoteContent) without being navigated away.
window.addEventListener('online', () => {
  if (state.config.ghToken && state.config.ghOwner && state.config.ghRepo) {
    connect(true).catch(e => console.error('Background connect failed:', e))
  }
})

// Close sidebar when selecting a note on mobile
document.addEventListener('click', e => {
  const sidebar = byEl<HTMLElement>('sidebar')
  if (
    window.innerWidth <= 768 &&
    sidebar.classList.contains('open') &&
    !!closestOf<HTMLElement>(e.target, '.note-item[data-type="file"]')
  ) {
    toggleSidebar()
  }
})

// ============= INIT =============
loadConfig()

async function init() {
  restoreDrafts()
  restorePendingRemoteRefresh()
  if (state.config.ghToken && state.config.ghOwner && state.config.ghRepo) {
    await loadFromCache(state.config.ghPath || '')
    const urlOrLast = getUrlParam('path') || getLastNotePath()
    const path =
      urlOrLast ||
      // After navigation that cleared the URL/last-note hint (closeEditor), a
      // note with a pending remote-refresh warning or the sole draft is still
      // the best candidate to reopen, so the ⚠️ Remote button survives reload.
      pendingRemoteRefresh?.path ||
      (draftCache.size === 1 ? [...draftCache.keys()][0] : '')
    if (path) await openNoteByPath(path)
    connect(true).catch(e => console.error('Background connect failed:', e))
  }
}
init()

// Bind events (replaces inline onclick/oninput/onkeydown/onchange handlers)
function bindEvents() {
  // Header
  byId('menuBtn')?.addEventListener('click', toggleSidebar)
  byId('pullBtn')?.addEventListener('click', pullChanges)
  byId('settingsBtn')?.addEventListener('click', openSettings)
  byId('themeBtn')?.addEventListener('click', toggleTheme)

  // Sidebar
  byId('sidebarOverlay')?.addEventListener('click', toggleSidebar)
  byId('newNoteBtn')?.addEventListener('click', newNote)
  byId('sidebarSearch')?.addEventListener('input', e => {
    byEl<HTMLElement>('sidebarSearchClear').classList.toggle('is-hidden', !(e.target as HTMLInputElement).value)
    sidebarSearch((e.target as HTMLInputElement).value)
  })
  byId('sidebarSearch')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ;(e.target as HTMLInputElement).value = ''
      byEl<HTMLElement>('sidebarSearchClear').classList.add('is-hidden')
      sidebarSearch('')
    }
  })
  byId('sidebarSearchClear')?.addEventListener('click', () => {
    const input = byEl<HTMLInputElement>('sidebarSearch')
    input.value = ''
    byEl<HTMLElement>('sidebarSearchClear').classList.add('is-hidden')
    sidebarSearch('')
    input.focus()
  })

  // Editor toolbar
  byId('boldBtn')?.addEventListener('click', () => insertMarkdown('**', '**', cm, onEditorInput))
  byId('italicBtn')?.addEventListener('click', () => insertMarkdown('*', '*', cm, onEditorInput))
  byId('headingBtn')?.addEventListener('click', () => insertMarkdown('#', '', cm, onEditorInput))
  byId('bulletBtn')?.addEventListener('click', () => insertMarkdown('- ', '', cm, onEditorInput))
  byId('taskBtn')?.addEventListener('click', () => toggleTaskOnLine(cm, state.currentFile, onEditorInput))
  byId('linkBtn')?.addEventListener('click', () => insertMarkdown('[', '](url)', cm, onEditorInput))
  byId('codeBtn')?.addEventListener('click', () => insertMarkdown('```\n', '\n```', cm, onEditorInput))
  byId('quoteBtn')?.addEventListener('click', () => insertMarkdown('> ', '', cm, onEditorInput))
  byId('dateBtn')?.addEventListener('click', () => insertTimestamp(cm, onEditorInput))
  byId('formatBtn')?.addEventListener('click', formatDoc)
  byId('toolbarSearchBtn')?.addEventListener('click', toggleSearch)

  // Editor search
  byId('searchInput')?.addEventListener('input', e => {
    byEl<HTMLElement>('searchInputClear').classList.toggle('is-hidden', !(e.target as HTMLInputElement).value)
    debouncedSearch((e.target as HTMLInputElement).value, false)
  })
  byId('searchInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.shiftKey ? searchPrev() : searchNext()
    }
  })
  byId('searchInputClear')?.addEventListener('click', () => {
    const input = byEl<HTMLInputElement>('searchInput')
    input.value = ''
    byEl<HTMLElement>('searchInputClear').classList.add('is-hidden')
    debouncedSearch('', false)
    input.focus()
  })
  byId('editorSearchPrev')?.addEventListener('click', searchPrev)
  byId('editorSearchNext')?.addEventListener('click', searchNext)
  byId('editorSearchClose')?.addEventListener('click', toggleSearch)

  // Editor header actions
  byId('previewToggle')?.addEventListener('click', togglePreview)
  byId('discardBtn')?.addEventListener('click', discardChanges)
  byId('remoteRefreshBtn')?.addEventListener('click', applyPendingRemoteRefresh)
  byId('saveBtn')?.addEventListener('click', saveNote)
  byId('deleteBtn')?.addEventListener('click', deleteNote)

  // Preview header
  byId('previewSearchBtn')?.addEventListener('click', togglePreviewSearch)
  byId('previewCloseBtn')?.addEventListener('click', togglePreview)

  // Preview search
  byId('previewSearchInput')?.addEventListener('input', e => {
    byEl<HTMLElement>('previewSearchClear').classList.toggle('is-hidden', !(e.target as HTMLInputElement).value)
    debouncedSearch((e.target as HTMLInputElement).value, true)
  })
  byId('previewSearchInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.shiftKey ? searchPrev() : searchNext()
    }
  })
  byId('previewSearchClear')?.addEventListener('click', () => {
    const input = byEl<HTMLInputElement>('previewSearchInput')
    input.value = ''
    byEl<HTMLElement>('previewSearchClear').classList.add('is-hidden')
    debouncedSearch('', true)
    input.focus()
  })
  byId('previewSearchPrev')?.addEventListener('click', searchPrev)
  byId('previewSearchNext')?.addEventListener('click', searchNext)
  byId('previewSearchClose')?.addEventListener('click', togglePreviewSearch)

  // Settings tabs
  document.querySelectorAll<HTMLElement>('.tabs .tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset['tab'] || ''))
  })
  byId('cryptoMode')?.addEventListener('change', onCryptoModeChange)
  byId('settingsCancelBtn')?.addEventListener('click', closeSettings)
  byId('settingsSaveBtn')?.addEventListener('click', saveSettings)
}

bindEvents()

// Task list checkbox delegation (replaces inline onclick in renderMarkdown)
byEl<HTMLElement>('previewPane')?.addEventListener('click', e => {
  const cb = closestOf<HTMLElement>(e.target, 'input[data-task-idx]')
  if (cb) {
    const idx = parseInt(cb.dataset['taskIdx'] || '', 10)
    if (!isNaN(idx)) toggleTaskByIndex(idx, cm, onEditorInput)
  }
})

// Breadcrumb directory navigation delegation
byEl<HTMLElement>('breadcrumb')?.addEventListener('click', e => {
  const link = closestOf<HTMLElement>(e.target, 'a[data-dir]')
  if (link) {
    e.preventDefault()
    navigateToDir(link.dataset['dir'] || '')
  }
})

// Close modal on overlay click
byEl<HTMLElement>('settingsModal')?.addEventListener('click', function (e) {
  if (e.target === this) closeSettings()
})
