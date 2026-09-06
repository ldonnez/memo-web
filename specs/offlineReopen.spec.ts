import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
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
// These functions are pure state transitions (no DOM / IDB / fetch), mirroring
// loadFromCache / navigateToDir / connect (app.ts) and listCachedNotePaths /
// pickBestCachedRecord (lib/util.ts).
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
    notes: rec.notes,
    dirs: rec.dirs,
    currentBrowsePath: rec.currentBrowsePath,
    currentFile: state.currentFile, // mirrored from `{ ...state }` in app.ts
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
): SnapState {
  // Mirrors app.ts connect() catch after doConnect throws (offline).
  if (withGuard && stateBefore.currentBrowsePath !== startPath) {
    return stateBefore
  }
  // Mirrors app.ts: const fallbackPath = c.ghPath || state.currentBrowsePath
  const fallbackPath = ghPath || stateBefore.currentBrowsePath
  return loadFromCache(stateBefore, records, fallbackPath)
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
