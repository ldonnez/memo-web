import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { decideRemoteRefresh } from '../lib/util.ts'
import { draftCache } from '../lib/draft.ts'
import type { Note, Dir } from '../lib/types.ts'

// =====================================================================
// Mirrors app.ts offline-reopen flow so the race fix stays regression-safe.
//
// Root cause fixed in app.ts:
//   init()  : await openNoteByPath(path)  -> restores subdir + selection BEFORE
//             connect(true)  (background) -> would otherwise clobber state back
//             to the root/ghPath cache when offline.
//   connect(): if (state.currentBrowsePath !== startPath) return  in the catch,
//             so a background reconnect cannot overwrite an already-restored
//             subdir navigation.
//
// Added later (the success-path bug):
//   doConnect(): bail when an open note's dir differs from the connect target
//             (ghPath), so a background reconnect cannot reset the browse path
//             to root and close the just-restored subdir note.
//   connect() catch: additionally bail when a restored note is open and the
//             fallback (c.ghPath) would move away from its dir.
//
// These functions are pure state transitions (no DOM / IDB / fetch), mirroring
// loadFromCache / navigateToDir / connect / doConnect (app.ts) and
// listCachedNotePaths / pickBestCachedRecord (lib/util.ts).
// =====================================================================

interface RecordData {
  notes: Note[]
  dirs: Dir[]
  currentBrowsePath: string
}

interface SnapState {
  notes: Note[]
  dirs: Dir[]
  currentBrowsePath: string
  currentFile: string | null
  pendingRefresh?: string | null
  persistedRefresh?: string | null
}

function makeNote(name: string, path: string): Note {
  return {
    name,
    path,
    sha: 'sha',
    size: 1,
    date: '',
    dirty: false,
    content: null,
    decrypted: null,
    originalText: '',
  }
}

function snapshot(path: string, files: string[], subdirs: string[] = []): RecordData & { timestamp: number } {
  return {
    notes: files.map(name => makeNote(name, `${path ? path + '/' : ''}${name}`)),
    dirs: subdirs.map(name => ({ name, path: `${path ? path + '/' : ''}${name}` })),
    currentBrowsePath: path,
    timestamp: Date.now(),
  }
}

const ROOT = snapshot('', ['root.md.gpg'], ['sub'])
const SUBDIR = snapshot('sub', ['note.md.gpg'])
const DOCS = snapshot('docs', ['doc.md.gpg'])
const NESTED = snapshot('a/b', ['nested.md.gpg'])

/** Mirrors app.ts loadFromCache(path): loads the exact record for `path`, preserving currentFile (spread of ...state). */
function loadFromCache(state: SnapState, records: Record<string, RecordData>, path: string): SnapState {
  const rec = records[path || '(root)']
  if (!rec) return state
  return {
    ...state, // warns + currentFile preserved, matching `state = { ...state, notes, dirs, ... }`
    notes: rec.notes,
    dirs: rec.dirs,
    currentBrowsePath: rec.currentBrowsePath,
  }
}

/** Mirrors app.ts selectNote(path): sets currentFile + keeps dir. */
function selectNote(state: SnapState, path: string): SnapState {
  const found = state.notes.find(n => n.path === path)
  if (!found) return state
  return { ...state, currentFile: found.path }
}

/** Mirrors app.ts openNoteByPath(path) for a note in a subdir, offline. */
async function openNoteByPath(state: SnapState, records: Record<string, RecordData>, path: string): Promise<SnapState> {
  let next = state
  const noteFound = next.notes.find(n => n.path === path)
  if (noteFound) {
    next = selectNote(next, path)
    return next
  }
  const parts = path.split('/')
  if (parts.length > 1) {
    const dir = parts.slice(0, -1).join('/')
    // Mirrors navigateToDir(dir) offline: ghListDir throws -> catch -> loadFromCache(dir)
    next = loadFromCache(next, records, dir)
    const note = next.notes.find(n => n.path === path)
    if (note) next = selectNote(next, path)
  }
  return next
}

/** Mirrors app.ts navigateToDir(dir) for offline: ghListDir throws -> catch -> loadFromCache(dir). */
async function navigateToDir(state: SnapState, records: Record<string, RecordData>, dir: string): Promise<SnapState> {
  const startPath = state.currentBrowsePath
  // Simulate ghListDir throwing (offline).
  try {
    throw new Error('offline')
  } catch {
    // navigateToDir catch: if path changed during fetch, bail.
    if (state.currentBrowsePath !== startPath) return state
    return loadFromCache(state, records, dir || '')
  }
}

// =====================================================================
// The regression: connect() catch clobbering an already-restored subdir.
// =====================================================================

function runConnectCatch(
  stateBefore: SnapState,
  startPath: string,
  records: Record<string, RecordData>,
  ghPath: string,
  withGuard: boolean,
  preserveNote = true,
): SnapState {
  // Mirrors app.ts connect() catch after doConnect throws (offline).
  if (withGuard && stateBefore.currentBrowsePath !== startPath) {
    return stateBefore
  }
  // Mirrors app.ts: const fallbackPath = c.ghPath || state.currentBrowsePath
  const fallbackPath = ghPath || stateBefore.currentBrowsePath
  // Mirrors app.ts: if (state.currentFile && fallbackPath !== state.currentBrowsePath) return
  if (preserveNote && stateBefore.currentFile && fallbackPath !== stateBefore.currentBrowsePath) {
    return stateBefore
  }
  return loadFromCache(stateBefore, records, fallbackPath)
}

/** Mirrors app.ts doConnect success: stale-path + open-note guards, then the root listing clobber. */
function runConnectSuccess(
  stateBefore: SnapState,
  startPath: string,
  path: string,
  records: Record<string, RecordData>,
  withGuard: boolean,
): SnapState {
  // Mirrors app.ts doConnect: if (state.currentBrowsePath !== startPath) return
  if (stateBefore.currentBrowsePath !== startPath) return stateBefore
  // Mirrors the new success-path guard: never navigate away from an open note.
  if (withGuard && stateBefore.currentFile && stateBefore.currentBrowsePath !== path) return stateBefore
  // Mirrors app.ts line 311: state = { ...state, dirs, notes, currentBrowsePath: path }
  const rec = records[path || '(root)']
  if (!rec) return stateBefore
  let next: SnapState = {
    notes: rec.notes,
    dirs: rec.dirs,
    currentBrowsePath: rec.currentBrowsePath,
    currentFile: stateBefore.currentFile,
  }
  // Mirrors doConnect's trailing closeEditor(): the open note vanished from the new listing.
  if (next.currentFile && !next.notes.find(n => n.path === next.currentFile)) {
    next = { ...next, currentFile: null }
  }
  return next
}

describe('offline reopen — connect catch does not clobber a restored subdir', () => {
  async function restoreSubdir(): Promise<SnapState> {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    return await openNoteByPath(state, { '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')
  }

  const RECORDS = { '(root)': ROOT, sub: SUBDIR }

  it('keeps the restored subdir + selected note when currentBrowsePath changed', async () => {
    // openNoteByPath finished FIRST: state is now the subdir with note selected.
    const state = await restoreSubdir()
    assert.equal(state.currentBrowsePath, 'sub', 'openNoteByPath restored the subdir')
    assert.equal(state.currentFile, 'sub/note.md.gpg', 'note selected')

    // The background connect() catch fires with startPath = root (''), ghPath unset.
    const after = runConnectCatch(state, /*startPath*/ '', RECORDS, /*ghPath*/ '', /*withGuard*/ true)
    assert.equal(after.currentBrowsePath, 'sub', 'guard prevents re-loading the cache')
    assert.equal(after.currentFile, 'sub/note.md.gpg', 'selection preserved')
  })

  it('regression: without the guard a configured ghPath clobbers the subdir back to root', async () => {
    const state = await restoreSubdir()

    // OLD behavior with ghPath set (e.g. "docs"): fallbackPath = ghPath, so the
    // configured root cache always wins regardless of any subdir the user had
    // navigated into — the sidebar jumps back to "docs" and no longer shows the
    // subdir the note lives in.
    const after = runConnectCatch(
      state,
      /*startPath*/ '',
      { '(root)': ROOT, docs: DOCS },
      /*ghPath*/ 'docs',
      /*withGuard*/ false,
      /*preserveNote*/ false,
    )
    assert.equal(after.currentBrowsePath, 'docs', 'bug: current dir reset to the configured root path')
    assert.equal(after.notes.length, 1, 'bug: now listing the ghPath dir instead of the subdir')
    assert.equal(after.notes[0]!.path, 'docs/doc.md.gpg')
  })

  it('keeps the subdir when connect catches after ghPath navigation is restored (guard active)', async () => {
    const state = await restoreSubdir()

    // Fixed behavior, even with a configured ghPath: the stale-path guard sees the
    // currentBrowsePath changed since connect began and refuses to reload the root.
    const after = runConnectCatch(
      state,
      /*startPath*/ '',
      { '(root)': ROOT, docs: DOCS },
      /*ghPath*/ 'docs',
      /*withGuard*/ true,
    )
    assert.equal(after.currentBrowsePath, 'sub', 'subdir preserved despite ghPath being set')
    assert.equal(after.currentFile, 'sub/note.md.gpg', 'selection preserved')
  })

  it('guard is a no-op when the user has NOT navigated (still loads the fallback)', async () => {
    // No reopen of a subdir: currentBrowsePath unchanged from handoff.
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    const after = runConnectCatch(state, /*startPath*/ '', { '(root)': ROOT }, /*ghPath*/ '', /*withGuard*/ true)
    assert.equal(after.currentBrowsePath, '', 'fallback still loads when path unchanged')
  })

  it('guard passes when startPath equals currentBrowsePath (real init flow: openNoteByPath awaited first)', async () => {
    // In the real init flow, openNoteByPath is awaited before connect, so
    // startPath = currentBrowsePath = 'sub'. Guard sees no change → fallback loads.
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = await openNoteByPath(state, { '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')
    assert.equal(state.currentBrowsePath, 'sub', 'subdir restored')

    // connect started with startPath = 'sub' (captured after openNoteByPath finished).
    const after = runConnectCatch(
      state,
      /*startPath*/ 'sub',
      { '(root)': ROOT, sub: SUBDIR },
      /*ghPath*/ '',
      /*withGuard*/ true,
    )
    // Guard sees currentBrowsePath === startPath → no bail → fallback loads.
    // fallbackPath = ghPath || currentBrowsePath = '' || 'sub' = 'sub' → loads SUBDIR.
    assert.equal(after.currentBrowsePath, 'sub', 'fallback loaded the same subdir (path unchanged)')
    assert.equal(after.notes.length, 1, 'subdir notes intact')
  })

  it('navigateToDir preserves subdir when guard detects stale path', async () => {
    // navigateToDir has its own stale-path guard: if currentBrowsePath changed during
    // ghListDir, it bails without touching state.
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = selectNote(state, 'root.md.gpg')

    // Simulate the user navigating again during fetch: change startPath after capture.
    const after = await navigateToDir(state, { '(root)': ROOT, sub: SUBDIR }, 'sub')
    // navigateToDir threw (offline) → catch → loadFromCache('sub') → SUBDIR loaded.
    assert.equal(after.currentBrowsePath, 'sub', 'loaded subdir from cache')
  })

  it('openNoteByPath handles nested subdir (a/b/note.md.gpg)', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = await openNoteByPath(state, { '(root)': ROOT, 'a/b': NESTED }, 'a/b/nested.md.gpg')
    assert.equal(state.currentBrowsePath, 'a/b', 'nested subdir restored')
    assert.equal(state.currentFile, 'a/b/nested.md.gpg', 'nested note selected')
  })

  it('openNoteByPath silently does nothing for a flat path not in current list', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    const before = { ...state }
    state = await openNoteByPath(state, { '(root)': ROOT }, 'nonexistent.md.gpg')
    // Flat path → parts.length === 1 → no navigation attempted, no selection.
    assert.deepEqual(state.notes, before.notes, 'notes unchanged')
    assert.equal(state.currentBrowsePath, '', 'browse path unchanged')
    assert.equal(state.currentFile, null, 'no file selected')
  })

  it('openNoteByPath selects note already in the current list without navigation', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = selectNote(state, 'root.md.gpg')
    // Note is already in the root list — openNoteByPath should short-circuit.
    const after = await openNoteByPath(state, { '(root)': ROOT }, 'root.md.gpg')
    assert.equal(after.currentFile, 'root.md.gpg', 'selected without navigation')
    assert.equal(after.currentBrowsePath, '', 'browse path unchanged (no navigation)')
  })

  it('openNoteByPath handles subdir not in cache (cache miss)', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    // No 'missing' key in records → loadFromCache returns state unchanged.
    const after = await openNoteByPath(state, { '(root)': ROOT }, 'missing/note.md.gpg')
    assert.equal(after.currentBrowsePath, '', 'browse path unchanged (cache miss)')
    assert.equal(after.currentFile, null, 'no file selected')
  })

  it('catch: ghPath fallback cannot clobber when startPath === currentBrowsePath (restored note open)', async () => {
    // Real initiated flow: connect captures startPath AFTER openNoteByPath, so it is
    // already 'sub'. The stale-path guard no-ops — only the open-note guard saves us
    // from the configured ghPath fallback overwriting the restored subdir.
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = await openNoteByPath(state, { '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')
    assert.equal(state.currentBrowsePath, 'sub')
    assert.equal(state.currentFile, 'sub/note.md.gpg')

    // ghPath = 'docs', fallbackPath = 'docs', which differs from the subdir the
    // note is open in.
    const after = runConnectCatch(
      state,
      /*startPath*/ 'sub',
      { '(root)': ROOT, docs: DOCS },
      /*ghPath*/ 'docs',
      /*withGuard*/ true,
    )
    assert.equal(after.currentBrowsePath, 'sub', 'open-note guard keeps the subdir')
    assert.equal(after.currentFile, 'sub/note.md.gpg', 'note selection preserved')
  })

  it('catch: regression — without the open-note guard, ghPath fallback clobbers even with startPath === currentBrowsePath', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = await openNoteByPath(state, { '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')

    const after = runConnectCatch(
      state,
      /*startPath*/ 'sub',
      { '(root)': ROOT, docs: DOCS },
      /*ghPath*/ 'docs',
      /*withGuard*/ true,
      /*preserveNote*/ false,
    )
    assert.equal(after.currentBrowsePath, 'docs', 'bug: sidebar jumped to the configured root')
  })
})

// =====================================================================
// The OTHER clobber: doConnect SUCCESS unconditionally reset currentBrowsePath
// to the configured root (line 311) and then closed the editor when the open
// subdir note was absent from the root listing (lines 332-338). This is what
// made the restored note close and the app land on the main menu ~2s after open.
// =====================================================================

describe('offline reopen — doConnect success does not close a restored subdir note', () => {
  async function restoreSubdir(): Promise<SnapState> {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    return await openNoteByPath(state, { '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')
  }

  it('regression: without the guard, success navigates to root and closes the note', async () => {
    const state = await restoreSubdir()
    assert.equal(state.currentBrowsePath, 'sub')
    assert.equal(state.currentFile, 'sub/note.md.gpg')

    // OLD behavior: doConnect sets currentBrowsePath = '' (target) and the open
    // subdir note is not in the root listing → closeEditor() → note gone, main menu.
    const after = runConnectSuccess(
      state,
      /*startPath*/ 'sub',
      /*path*/ '',
      { '(root)': ROOT, sub: SUBDIR },
      /*withGuard*/ false,
    )
    assert.equal(after.currentBrowsePath, '', 'bug: sidebar reset to root')
    assert.equal(after.currentFile, null, 'bug: editor closed because the note left the listing')
  })

  it('guard keeps the restored subdir + open note when connect targets the root', async () => {
    const state = await restoreSubdir()
    const after = runConnectSuccess(
      state,
      /*startPath*/ 'sub',
      /*path*/ '',
      { '(root)': ROOT, sub: SUBDIR },
      /*withGuard*/ true,
    )
    assert.equal(after.currentBrowsePath, 'sub', 'no navigation away from the open note')
    assert.equal(after.currentFile, 'sub/note.md.gpg', 'note stays open')
  })

  it('guard is a no-op when the note is open in the connect target dir (refresh proceeds)', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = selectNote(state, 'root.md.gpg')

    // connect target '' === currentBrowsePath '' → guard no-ops → refresh runs.
    const after = runConnectSuccess(
      state,
      /*startPath*/ '',
      /*path*/ '',
      { '(root)': ROOT, sub: SUBDIR },
      /*withGuard*/ true,
    )
    assert.equal(after.currentBrowsePath, '', 'refresh proceeds')
    assert.equal(after.currentFile, 'root.md.gpg', 'note still present in the refreshed root list')
  })

  it('guard is a no-op when no note is open (clean browsing navigate-to-root works)', async () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = await navigateToDir(state, { '(root)': ROOT, sub: SUBDIR }, 'sub')

    // No currentFile → the guard bails only on open notes → connect navigates to root.
    const after = runConnectSuccess(
      state,
      /*startPath*/ 'sub',
      /*path*/ '',
      { '(root)': ROOT, sub: SUBDIR },
      /*withGuard*/ true,
    )
    assert.equal(after.currentBrowsePath, '', 'navigated to the configured root as before')
    assert.equal(after.currentFile, null, 'no selection made')
  })

  it('open note missing from the refreshed listing still closes (deleted-remotely behavior kept)', async () => {
    // Note open in the target dir, but the fresh listing no longer contains it.
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = selectNote(state, 'root.md.gpg')

    // The refreshed root listing dropped root.md.gpg (deleted on the remote).
    const after = runConnectSuccess(
      state,
      /*startPath*/ '',
      /*path*/ '',
      { '(root)': snapshot('', ['other.md.gpg']) },
      /*withGuard*/ true,
    )
    assert.equal(after.currentBrowsePath, '', 'refresh proceeds for the same dir')
    assert.equal(after.currentFile, null, 'editor closes because the file was deleted remotely')
  })
})

// =====================================================================
// The order fix: awaiting openNoteByPath before connect(true) makes the
// subdir navigation win deterministically.
// =====================================================================

async function initOrdered(
  records: Record<string, RecordData>,
  lastPath: string,
): Promise<{ state: SnapState; order: string[] }> {
  const order: string[] = []
  let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
  // init(): await loadFromCache(ghPath)
  state = loadFromCache(state, records, '')
  order.push(`loadFromCache(${state.currentBrowsePath || '(root)'})`)

  // init(): await openNoteByPath(path)  <-- FIXED: now awaited
  state = await openNoteByPath(state, records, lastPath)
  order.push(`openNoteByPath -> ${state.currentBrowsePath}`)

  // connect(true) starts AFTER; capture startPath = currentBrowsePath
  const startPath = state.currentBrowsePath
  state = runConnectCatch(state, startPath, records, /*ghPath*/ '', /*withGuard*/ true)
  order.push(`connect.catch -> ${state.currentBrowsePath}`)
  return { state, order }
}

describe('offline reopen — awaited openNoteByPath runs before connect(true)', () => {
  it('restores the subdir + selection and keeps it after the background connect', async () => {
    const { state, order } = await initOrdered({ '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')
    assert.deepEqual(order, ['loadFromCache((root))', 'openNoteByPath -> sub', 'connect.catch -> sub'])
    assert.equal(state.currentBrowsePath, 'sub')
    assert.equal(state.currentFile, 'sub/note.md.gpg')
  })

  it('loads the root cache and selects nothing when there is no last note', async () => {
    const { state, order } = await initOrdered({ '(root)': ROOT, sub: SUBDIR }, '')
    assert.deepEqual(order, ['loadFromCache((root))', 'openNoteByPath -> ', 'connect.catch -> '])
    assert.equal(state.currentBrowsePath, '')
    assert.equal(state.currentFile, null)
  })

  it('interleaving edge: connect.catch resolves last but guard protects the subdir', async () => {
    // Even if openNoteByPath completed first and connect fired last with the old
    // startPath, the guard keeps the subdir.
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, { '(root)': ROOT }, '(root)')
    state = await openNoteByPath(state, { '(root)': ROOT, sub: SUBDIR }, 'sub/note.md.gpg')
    // connect captured startPath = '' (before navigation) but runs its catch now.
    const after = runConnectCatch(state, '', { '(root)': ROOT, sub: SUBDIR }, '', true)
    assert.equal(after.currentBrowsePath, 'sub')
    assert.equal(after.currentFile, 'sub/note.md.gpg')
  })
})

// =====================================================================
// loadFromCache edge cases: cache-miss fallback, empty cache, and
// currentFile preservation across a cache reload.
// =====================================================================

describe('offline reopen — loadFromCache edge cases', () => {
  const RECORDS = { '(root)': ROOT, sub: SUBDIR }

  it('preserves currentFile across a cache reload (spread of ...state)', () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, RECORDS, '(root)')
    state = selectNote(state, 'root.md.gpg')
    assert.equal(state.currentFile, 'root.md.gpg', 'note selected')

    // Reload another dir's cache; currentFile must be preserved (mirrors ...state spread).
    const after = loadFromCache(state, RECORDS, 'sub')
    assert.equal(after.currentBrowsePath, 'sub', 'navigated to sub')
    assert.equal(after.currentFile, 'root.md.gpg', 'currentFile preserved across loadFromCache')
    assert.equal(after.notes.length, 1, 'subdir notes loaded')
  })

  it('loadFromCache on a cache miss leaves state unchanged (mock mirrors app fallback semantics)', () => {
    let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    state = loadFromCache(state, RECORDS, '(root)')
    // Path with no record and no fallback in the mock → state unchanged.
    const before = { ...state, currentFile: state.currentFile }
    const after = loadFromCache(state, RECORDS, 'unknown')
    assert.deepEqual(after.notes, before.notes, 'notes unchanged on cache miss')
    assert.equal(after.currentBrowsePath, before.currentBrowsePath, 'browse path unchanged on cache miss')
  })

  it('loadFromCache on an empty cache leaves state unchanged', () => {
    const state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
    const after = loadFromCache(state, {}, '(root)')
    assert.equal(after.notes.length, 0, 'no notes in empty cache')
    assert.equal(after.currentBrowsePath, '', 'browse path unchanged')
  })
})

// =====================================================================
// Reopen of a subdir note must NOT prefetch the dir listing into the note's
// `content`: that advances the note to the NEW remote b64 before the draft
// restore, so refreshOpenNoteContent sees "remote unchanged" and skips the
// dirty-flag → the ⚠️ Remote warning button never shows.
// =====================================================================

/** Mirrors app.ts navigateToDir(dir, { prefetch: false }) online: fresh content-less listing + merge of the previous cached record's content into notes. */
function navigateToDirNoPrefetch(fresh: Note[], cachedDir: RecordData, dir: string): SnapState {
  const prev = new Map(cachedDir.notes.map(n => [n.path, n]))
  return {
    notes: fresh.map(n => {
      const p = prev.get(n.path)
      return p && p.content ? { ...n, content: p.content, sha: p.sha ?? n.sha } : n
    }),
    dirs: [],
    currentBrowsePath: dir,
    currentFile: null,
  }
}

describe('closeEditor must not clear the pending remote-refresh warning', () => {
  // Mirrors app.ts closeEditor(): navigation-close resets the editor but must
  // keep a restored "remote changed while dirty" warning (pendingRefresh) so the
  // ⚠️ Remote button reappears when the note is reopened — it is only cleared on
  // save/discard/apply/new/pull.
  function closeEditor(state: SnapState): SnapState {
    return { ...state, currentFile: null }
  }

  // Mirrors app.ts syncRemoteRefreshBtn(): the button shows for the open note
  // when the warning comes from memory OR from the persisted payload.
  function buttonShown(state: SnapState): boolean {
    return (
      !!state.currentFile &&
      (state.pendingRefresh === state.currentFile || state.persistedRefresh === state.currentFile)
    )
  }

  it('reopen flow: restored warning survives navigateToDir close and re-shows on selectNote', () => {
    // init() order: restoreDrafts() + restorePendingRemoteRefresh() restore the
    // flag BEFORE openNoteByPath, which navigates (closeEditor) and then selects.
    let state = loadFromCache(
      { notes: [], dirs: [], currentBrowsePath: '', currentFile: null, pendingRefresh: 'sub/note.md.gpg' },
      { '(root)': ROOT },
      '(root)',
    )
    state = closeEditor(state) // navigateToDir -> closeEditor (openNoteByPath, subdir case)
    assert.equal(state.currentFile, null, 'editor closed')

    // selectNote reopens the drafted note; currentFile now matches the warning.
    state = selectNote(loadFromCache(state, { sub: SUBDIR }, 'sub'), 'sub/note.md.gpg')
    assert.equal(state.currentFile, 'sub/note.md.gpg', 'note reopened')
    assert.ok(buttonShown(state), 'warning matches reopened note (button visible)')
  })

  it('self-healing: the persisted payload alone re-shows the button even if memory was wiped', () => {
    // Mirrors a reopen where pendingRemoteRefresh was cleared in memory but the
    // localStorage payload survived: buttonShown derives from persistedRefresh too.
    let state: SnapState = {
      notes: [],
      dirs: [],
      currentBrowsePath: '',
      currentFile: null,
      pendingRefresh: null,
      persistedRefresh: 'sub/note.md.gpg',
    }
    state = selectNote(loadFromCache(state, { sub: SUBDIR }, 'sub'), 'sub/note.md.gpg')
    assert.ok(buttonShown(state), 'button visible from persisted payload alone')
  })

  it('a fresh selection without a warning shows nothing', () => {
    let state = loadFromCache(
      { notes: [], dirs: [], currentBrowsePath: '', currentFile: null },
      { '(root)': ROOT },
      '(root)',
    )
    state = selectNote(state, 'root.md.gpg')
    assert.ok(!buttonShown(state), 'no button when no warning was restored or persisted')
  })

  it('init fallback reopens the pending-warning note when URL/lastNote were cleared', () => {
    // Mirrors init(): when closeEditor (navigation) wiped the URL param and
    // lastNote before reload, init now falls back to the pending refresh path
    // and reopens it, so the ⚠️ Remote button shows for that note again.
    let state: SnapState = {
      notes: [],
      dirs: [],
      currentBrowsePath: '',
      currentFile: null,
      pendingRefresh: 'sub/note.md.gpg',
    }
    const path = state.pendingRefresh // init: urlOrLast || pendingRemoteRefresh?.path || single draft
    assert.equal(path, 'sub/note.md.gpg', 'derived from pending refresh')
    state = selectNote(loadFromCache(state, { sub: SUBDIR }, 'sub'), path)
    assert.equal(state.currentFile, 'sub/note.md.gpg', 'warned note reopened')
    assert.ok(buttonShown(state), 'button shown for reopened warned note')
  })
})

describe('a connect prefetch must not advance the drafted note baseline (second-reload regression)', () => {
  // User flow: edit locally → another device pushes → reload #1 shows the ⚠️
  // button ✓ → reload #2 loses it ✗. Root cause: reload #1's connect re-fetched
  // the fresher remote content into the note and cached it, so reload #2 loaded
  // that as the dirty-compare baseline → remote === baseline → decideRemoteRefresh
  // 'skip' → clearRemoteRefresh(). Mirrors app.ts doConnect merge: a drafted
  // note's baseline (content BEFORE the prefetch) survives the fetch + cache.
  function currentNote(state: SnapState, path: string): Note {
    const found = state.notes.find(n => n.path === path)
    assert.ok(found, `note ${path} present`)
    return found
  }

  it('a connect prefetch does not advance the drafted note baseline', () => {
    const B64_OLD = 'bG9jYWwtYmFzZWxpbmU=' // what the user originally opened/edited
    const B64_NEW = 'bmV3ZXItcmVtb3Rl' // pushed from the other device
    draftCache.set('root.md.gpg', 'MY-EDITED-DRAFT')
    try {
      const base = { ...ROOT, notes: [{ ...makeNote('root.md.gpg', 'root.md.gpg'), content: B64_OLD, sha: 'sha-old' }] }
      // reload #1: loadFromCache restores the baseline; selectNote opens the note.
      const afterLoad = selectNote(
        loadFromCache({ notes: [], dirs: [], currentBrowsePath: '', currentFile: null }, { '(root)': base }, '(root)'),
        'root.md.gpg',
      )

      // doConnect (mirror): parseEntries rebuilds notes; the naive prefetch would
      // return the fresher remote content for the drafted note…
      const prefetched = [{ ...makeNote('root.md.gpg', 'root.md.gpg'), content: B64_NEW, sha: 'sha-new' }]
      // …but the baseline capture + merge keep the pre-connect content for drafts.
      const baselineByPath = new Map(afterLoad.notes.map(n => [n.path, n]))
      const merged = prefetched.map(n => (draftCache.has(n.path) ? (baselineByPath.get(n.path) ?? n) : n))
      const mergedNote = merged.find(n => n.path === 'root.md.gpg')
      assert.ok(mergedNote, 'merged note present')
      assert.equal(mergedNote.content, B64_OLD, 'drafted note baseline untouched by prefetch')
      assert.equal(
        decideRemoteRefresh(mergedNote, true, true, B64_NEW, 'sha-new').action,
        'flag',
        'refresh still flags → ⚠️ button stays across reload #2',
      )
    } finally {
      draftCache.delete('root.md.gpg')
    }
  })

  it('reload #1 and #2 both decide flag when the baseline stays put', () => {
    const B64_OLD = 'YmFzZWxpbmU='
    const B64_NEW = 'bG9jYWwtYmFzZWxpbmU='
    draftCache.set('root.md.gpg', 'DRAFT')
    try {
      const base = {
        ...ROOT,
        notes: [{ ...makeNote('root.md.gpg', 'root.md.gpg'), content: B64_OLD, sha: 'sha-old' }],
      }
      let state: SnapState = { notes: [], dirs: [], currentBrowsePath: '', currentFile: null }
      state = selectNote(loadFromCache(state, { '(root)': base }, '(root)'), 'root.md.gpg')

      for (let reload = 1; reload <= 2; reload++) {
        state = loadFromCache(state, { '(root)': base }, '(root)') // cache still holds baseline
        const decision = decideRemoteRefresh(currentNote(state, 'root.md.gpg'), true, true, B64_NEW, 'sha-new')
        assert.equal(decision.action, 'flag', `reload ${reload} flags (does not skip/clear)`)
        assert.equal(currentNote(state, 'root.md.gpg').content, B64_OLD, `reload ${reload} baseline unchanged`)
      }
    } finally {
      draftCache.delete('root.md.gpg')
    }
  })
})

describe('openNoteByPath prefetch opt-out keeps the dirty-flag baseline', () => {
  function cachedSubWithContent(content: string | null): RecordData {
    return {
      notes: [{ ...makeNote('note.md.gpg', 'sub/note.md.gpg'), content }],
      dirs: [],
      currentBrowsePath: 'sub',
    }
  }

  it('navigateToDir(prefetch:false) retains the OLD cached content, so a changed remote flags the warning', () => {
    const navigated = navigateToDirNoPrefetch(
      [makeNote('note.md.gpg', 'sub/note.md.gpg')],
      cachedSubWithContent('old-remote-b64'),
      'sub',
    )
    const reopened = selectNote(navigated, 'sub/note.md.gpg')
    const note = reopened.notes.find(n => n.path === 'sub/note.md.gpg')!

    // Baseline preserved → decideRemoteRefresh can see the remote changed.
    assert.equal(note.content, 'old-remote-b64', 'baseline must stay the OLD cached content')
    const decision = decideRemoteRefresh(note, /*isDirty*/ true, /*hasDraft*/ true, 'new-remote-b64', 'new-sha')
    assert.equal(decision.action, 'flag', 'dirty reopen + changed remote → offer the warning button')
  })

  it('regression: the old prefetching navigateToDir advanced content to the new remote → no flag shown', () => {
    // Old behavior: fetchAllNotesContent wrote the NEW b64 into the note's content.
    const note = {
      ...makeNote('note.md.gpg', 'sub/note.md.gpg'),
      content: 'new-remote-b64' as string | null,
      sha: 'new-sha',
    }
    const decision = decideRemoteRefresh(note, true, true, 'new-remote-b64', 'new-sha')
    assert.equal(decision.action, 'skip', 'bug: remote === advanced listing content → warning never offered')
  })
})
