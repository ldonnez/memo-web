import { describe, it, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  baseOf,
  localWorkingText,
  planPull,
  decidePull,
  carryBases,
  mergeDirListing,
  applyLocalStatus,
  isModified,
} from '../lib/sync.ts'
import {
  markNoteClean,
  saveNoteClean,
  applyRemoteContent,
  reconcileSha,
  computeDirtyState,
  revertNote,
} from '../lib/util.ts'
import { draftCache, contentCache } from '../lib/draft.ts'
import { makeNote } from './helpers.ts'
import type { Note } from '../lib/types.ts'

// =====================================================================
// End-to-end behaviour of the pull path, driven through the real pure
// functions (planPull / decidePull / markNoteClean / applyRemoteContent /
// carryBases / applyLocalStatus) with the app.ts orchestration mirrored
// step for step and commented with the app.ts line it mirrors.
//
// The reported bug these tests pin down:
//   "On opening the app it only shows the offline notes, and when the remote
//    has changes the button says the remote has changes instead of updating
//    the note."
// Two causes, both covered below:
//   1. startup is cache-first with a background connect, so the open note is
//      only reconciled afterwards (init → loadFromCache → openNoteByPath →
//      connect(true) → doConnect → refreshOpenNoteContent);
//   2. the reconcile asked "isDirty || hasDraft", and a draft is written on
//      every navigation — so a note that was merely *opened* looked locally
//      modified and every remote change became a ⚠️ button.
// =====================================================================

const PATH = 'note.md.gpg'
const V1 = '# Note\n\nfirst version'
const V2 = '# Note\n\nchanged on another device'
const LOCAL_EDIT = '# Note\n\nfirst version\n\nmy unsaved line'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8')

interface RemoteFile {
  sha: string
  b64: string
  text: string
}

/**
 * A stand-in for the GitHub Contents API. `push` mints a NEW sha even when the
 * text is unchanged, mirroring openpgp's randomized encryption: two blobs of the
 * same plaintext have different SHAs, so "the SHA moved" does not imply "the
 * text changed".
 */
class FakeOrigin {
  files = new Map<string, RemoteFile>()
  private counter = 0

  seed(path: string, text: string, sha?: string): RemoteFile {
    const file: RemoteFile = { sha: sha ?? `sha-${++this.counter}`, b64: b64(text), text }
    this.files.set(path, file)
    return file
  }

  push(path: string, text: string): RemoteFile {
    return this.seed(path, text)
  }

  get(path: string): RemoteFile | null {
    return this.files.get(path) ?? null
  }
}

interface AppState {
  notes: Note[]
  currentFile: Note | null
  currentContent: string
  originalContent: string
  isDirty: boolean
}

interface RefreshOutcome {
  state: AppState
  updated: boolean
  flagged: boolean
  /** The ⚠️ state (memoweb_pending_refresh) after the pull. */
  pending: Pending
}

function initialState(): AppState {
  return { notes: [], currentFile: null, currentContent: '', originalContent: '', isDirty: false }
}

/** Mirrors app.ts loadFromCache(path): the record's notes, badged from the base. */
function loadFromCache(record: Note[]): AppState {
  const notes = applyLocalStatus(record, p => draftCache.get(p))
  for (const n of notes) if (n.content) contentCache.set(n.path, n.content)
  return { ...initialState(), notes }
}

/** The record the app persists for a directory (lib/util.ts cacheNotesToLocalStorage). */
function cachedRecord(state: AppState): Note[] {
  return state.notes
}

/** Mirrors app.ts selectNote(path) for a note that has a draft. */
function openDraftedNote(state: AppState, path: string): AppState {
  const found = state.notes.find(n => n.path === path)
  if (!found) return state
  const draft = draftCache.get(path)
  if (draft === undefined) return state
  let note = found
  let base = baseOf(note)
  if (base.text === null && note.content) {
    const decrypted = unb64(note.content)
    base = { text: decrypted, sha: note.sha }
    note = { ...note, baseText: decrypted, baseSha: note.sha, originalText: decrypted }
  }
  if (!isModified(base, draft)) {
    // Identical to the base: the note was opened and left alone. Drop the draft
    // and fall through to the clean open below.
    draftCache.delete(path)
  } else {
    // The note's own baseline must be re-pointed at the merge base, not left at
    // whatever the listing carried (usually ''). revertNote() reads originalText
    // and then adopts it as the base, so a stale '' would make Discard empty the
    // note and record '' as the last synced content.
    note = { ...note, originalText: base.text ?? '' }
    return {
      ...state,
      notes: applyLocalStatus(
        state.notes.map(n => (n.path === path ? note : n)),
        p => draftCache.get(p),
      ),
      currentFile: note,
      currentContent: draft,
      originalContent: base.text ?? '',
      isDirty: true,
    }
  }
  return openCleanNote(state, path, note)
}

/** Mirrors app.ts selectNote(path) for a note with no draft. */
function openCleanNote(state: AppState, path: string, known?: Note): AppState {
  const found = known ?? state.notes.find(n => n.path === path)
  if (!found) return state
  const note = found.content ? found : { ...found, content: b64(V1) }
  const clean = markNoteClean(
    note,
    state.notes.map(n => (n.path === path ? note : n)),
    unb64(note.content!),
  )
  return {
    ...state,
    notes: clean.notes,
    currentFile: clean.currentFile,
    currentContent: clean.originalContent,
    originalContent: clean.originalContent,
    isDirty: false,
  }
}

function openNote(state: AppState, path: string): AppState {
  return draftCache.has(path) ? openDraftedNote(state, path) : openCleanNote(state, path)
}

/** Mirrors app.ts doConnect's listing refresh: rebuild notes, keep the base. */
function refreshListing(state: AppState, origin: FakeOrigin, paths: string[]): AppState {
  const listed = paths.map(path => {
    const file = origin.get(path)!
    return makeNote({ name: path, path, sha: file.sha, date: '', content: null })
  })
  return { ...state, notes: applyLocalStatus(carryBases(listed, state.notes), p => draftCache.get(p)) }
}

/** Mirrors lib/github.ts fetchAllNotesContent: a drafted note is never fetched. */
function prefetch(state: AppState, origin: FakeOrigin): AppState {
  return {
    ...state,
    notes: state.notes.map(n => {
      if (n.content) return n
      if (draftCache.has(n.path)) return n
      const file = origin.get(n.path)
      if (!file) return n
      contentCache.set(n.path, file.b64)
      return { ...n, content: file.b64, sha: file.sha }
    }),
  }
}

/**
 * Mirrors app.ts refreshOpenNoteContent(): the app's `git pull` for the open
 * note. Returns whether the editor was updated and whether the ⚠️ button
 * (memoweb_pending_refresh) should be raised.
 */
function refreshOpenNote(state: AppState, origin: FakeOrigin, pending: Pending = null): RefreshOutcome {
  const openFile = state.currentFile
  if (!openFile) return { state, updated: false, flagged: false, pending }
  const data = origin.get(openFile.path)
  if (!data) return { state, updated: false, flagged: false, pending }
  const raise = (): Pending => ({ path: openFile.path, content: data.b64, sha: data.sha })

  const base = baseOf(openFile)
  const working = localWorkingText({
    draft: draftCache.get(openFile.path),
    openText: state.currentContent,
    isOpenDirty: state.isDirty,
  })
  const plan = planPull({ base, remoteSha: data.sha, working })

  if (plan === 'up-to-date') {
    // Up to date: any warning for THIS note is resolved (app.ts clears it here).
    const reconciled = reconcileSha(openFile, state.notes, data.sha)
    const next = reconciled ? { ...state, ...reconciled } : state
    const stillFlagged = pending?.path === openFile.path ? null : pending
    return { state: next, updated: false, flagged: false, pending: stillFlagged }
  }
  if (plan === 'conflict') {
    return { state, updated: false, flagged: true, pending: raise() }
  }
  const decrypted = unb64(data.b64)
  const action = plan === 'decrypt' ? decidePull({ base: base.text, working, remote: decrypted }) : 'fast-forward'
  if (action === 'conflict') {
    return { state, updated: false, flagged: true, pending: raise() }
  }
  if (action === 'up-to-date') {
    // The working copy is already on the remote: the draft is redundant, so drop
    // it, adopt the remote as the base and leave the editor as it is. Taking the
    // remote resolves any warning for this note (app.ts adoptRemoteContent).
    draftCache.delete(openFile.path)
    contentCache.set(openFile.path, data.b64)
    return {
      state: adopt(state, openFile, data, decrypted),
      updated: true,
      flagged: false,
      pending: pending?.path === openFile.path ? null : pending,
    }
  }
  // A keystroke (or a navigation draft) may have landed while the blob was in
  // flight. Compare the content, not the draft's existence.
  const workingNow = localWorkingText({
    draft: draftCache.get(openFile.path),
    openText: state.currentContent,
    isOpenDirty: state.isDirty,
  })
  if (isModified(base, workingNow)) {
    return { state, updated: false, flagged: true, pending: raise() }
  }
  contentCache.set(openFile.path, data.b64)
  return {
    state: adopt(state, openFile, data, decrypted),
    updated: true,
    flagged: false,
    pending: pending?.path === openFile.path ? null : pending,
  }
}

/** Mirrors app.ts adoptRemoteContent(): content, editor text and base all move. */
function adopt(state: AppState, openFile: Note, data: RemoteFile, decrypted: string): AppState {
  const result = applyRemoteContent(openFile, state.notes, data.b64, decrypted, data.sha)
  return {
    ...state,
    notes: result.notes,
    currentFile: result.currentFile,
    currentContent: result.currentContent,
    originalContent: result.originalContent,
    isDirty: false,
  }
}

type Pending = { path: string; content: string; sha: string } | null

/** Mirrors app.ts applyPendingRemoteRefresh(): take the remote and drop the draft. */
function applyRemoteWarning(state: AppState, pending: Pending): AppState {
  const openFile = state.currentFile
  if (!openFile || !pending || pending.path !== openFile.path) return state
  const decrypted = unb64(pending.content)
  draftCache.delete(openFile.path)
  contentCache.set(openFile.path, pending.content)
  const result = applyRemoteContent(openFile, state.notes, pending.content, decrypted, pending.sha)
  return {
    ...state,
    notes: applyLocalStatus(result.notes, p => draftCache.get(p)),
    currentFile: result.currentFile,
    currentContent: result.currentContent,
    originalContent: result.originalContent,
    isDirty: false,
  }
}

/** Mirrors app.ts saveNote(). */
function saveNote(state: AppState, origin: FakeOrigin, path: string, text: string): AppState {
  const note = state.currentFile
  if (!note || note.path !== path) return state
  const pushed = origin.push(path, text)
  const clean = saveNoteClean(note, state.notes, pushed.b64, pushed.sha, text)
  draftCache.delete(path)
  contentCache.set(path, pushed.b64)
  return {
    ...state,
    notes: applyLocalStatus(clean.notes, p => draftCache.get(p)),
    currentFile: clean.currentFile,
    currentContent: text,
    originalContent: clean.originalContent,
    isDirty: false,
  }
}

/** The whole startup sequence: offline snapshot first, then the background connect. */
function startup(origin: FakeOrigin, reopenPath: string | null): { state: AppState; pending: Pending } {
  const record = cachedRecord(loadFromCache([makeNote({ name: PATH, path: PATH, sha: '', content: b64(V1) })]))
  let state = openNote(loadFromCache(record), reopenPath ?? PATH)
  let pending: Pending = null
  const connected = prefetch(refreshListing(state, origin, [PATH]), origin)
  const outcome = refreshOpenNote(connected, origin)
  state = outcome.state
  pending = outcome.flagged ? { path: PATH, content: origin.get(PATH)!.b64, sha: origin.get(PATH)!.sha } : null
  return { state, pending }
}

/**
 * The whole startup sequence WITH the persisted record modelled separately from
 * state.notes, because that separation is where the merge base can go stale:
 *
 *   doConnect(): parseEntries + fetchAllNotesContent → cacheNotesToLocalStorage
 *     (app.ts:376)  ← the record now holds the PRE-refresh base
 *   doConnect(): refreshOpenNoteContent() (app.ts:395) fast-forwards and advances
 *     the base in memory only
 *   doConnect(): walkAllDirsAndPrefetch() (app.ts:377, setTimeout 0) rebuilds every
 *     note from a fresh listing, carries the base out of the record it is about to
 *     overwrite, and writes that record back (lib/github.ts:308-314)
 *
 * `persistAfterRefresh` is the fix under test: without it the walk faithfully
 * restores the *stale* base it read, and the next reload starts the whole
 * fast-forward dance over again with a base that is not the content the user
 * actually has.
 */
function startupWithRecord(
  origin: FakeOrigin,
  record: Note[],
  opts: { persistAfterRefresh?: boolean } = {},
): { state: AppState; record: Note[] } {
  let state = openNote(loadFromCache(record), PATH)
  // doConnect(): listing + prefetch, then the cache write that happens BEFORE the
  // open note is refreshed.
  state = prefetch(refreshListing(state, origin, [PATH]), origin)
  let stored = [...state.notes]

  // doConnect(): refreshOpenNoteContent()
  state = refreshOpenNote(state, origin).state
  if (opts.persistAfterRefresh) stored = [...state.notes]

  // walkAllDirsAndPrefetch(): fresh listing → carryBases from the record → write back
  const listed = [makeNote({ name: PATH, path: PATH, sha: origin.get(PATH)!.sha })]
  stored = carryBases(prefetch({ ...initialState(), notes: listed }, origin).notes, stored)

  return { state, record: stored }
}

beforeEach(() => {
  draftCache.clear()
  contentCache.clear()
})

// =====================================================================
// 1. The reported bug: a clean note must auto-update on open.
// =====================================================================

describe('opening the app with a changed remote', () => {
  it('auto-updates the open note instead of raising the ⚠️ button', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')

    // The user opened the note on this device, so the cache holds a base.
    const first = startup(origin, PATH)
    assert.equal(first.state.currentContent, V1, 'starts from the offline snapshot')

    // Another device pushes.
    origin.push(PATH, V2)

    const { state, pending } = startup(origin, PATH)
    assert.equal(state.currentContent, V2, 'the editor now shows the remote text')
    assert.equal(pending, null, 'no ⚠️ button')
    assert.equal(state.isDirty, false, 'still clean')
  })

  it('moves the base to the remote so a second open is a no-op', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    startup(origin, PATH)
    origin.push(PATH, V2)

    const { state } = startup(origin, PATH)
    assert.deepEqual(baseOf(state.currentFile!), { text: V2, sha: origin.get(PATH)!.sha })
    const second = refreshOpenNote(state, origin)
    assert.equal(second.updated, false, 'nothing left to pull')
    assert.equal(second.flagged, false)
  })

  it('a note that was merely opened and left alone also auto-updates', () => {
    // A draft is written on every navigation, so this note "has a draft" while
    // being byte-identical to the base. That is the exact false positive the
    // old isDirty||hasDraft test produced.
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    draftCache.set(PATH, V1)

    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    assert.equal(draftCache.has(PATH), false, 'the redundant draft is dropped on open')

    origin.push(PATH, V2)
    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, false, 'no ⚠️ button for an untouched note')
    assert.equal(outcome.updated, true, 'fast-forwarded')
    assert.equal(outcome.state.currentContent, V2)
  })

  it('an unchanged remote is left completely alone (no decrypt, no re-render churn)', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]), PATH)
    const outcome = refreshOpenNote(state, origin)
    assert.equal(planPull({ base: baseOf(state.currentFile!), remoteSha: 'sha-v1', working: null }), 'up-to-date')
    assert.equal(outcome.updated, false)
    assert.equal(outcome.flagged, false)
  })

  it('a re-push of identical text is treated as up to date, not a conflict', () => {
    // Randomized encryption: same plaintext, new blob SHA.
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]), PATH)
    origin.push(PATH, V1)
    const pushedSha = origin.get(PATH)!.sha
    assert.notEqual(pushedSha, 'sha-v1', 'the blob really was re-encrypted')
    assert.equal(planPull({ base: baseOf(state.currentFile!), remoteSha: pushedSha, working: null }), 'apply')
    const outcome = refreshOpenNote(state, origin)
    assert.equal(outcome.flagged, false, 'nothing to warn about')
    assert.equal(outcome.state.currentFile!.sha, pushedSha, 'the SHA is refreshed so the next save cannot 409')
    assert.equal(outcome.state.currentContent, V1, 'the text is unchanged')
  })
})

// =====================================================================
// 2. Genuine divergence must never be silently overwritten.
// =====================================================================

describe('opening the app with local edits and a changed remote', () => {
  function diverge(): { origin: FakeOrigin } {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    // The user edits and navigates away: onEditorInput persisted a draft.
    draftCache.set(PATH, LOCAL_EDIT)
    origin.push(PATH, V2)
    return { origin }
  }

  it('Discard reverts to the pre-edit content, not to an empty note', () => {
    draftCache.set(PATH, LOCAL_EDIT)
    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    // The listing carried originalText: '' (nothing had been decrypted into the
    // note yet). revertNote() reads that field and then adopts it as the base, so
    // Discard would empty the note AND record '' as the last synced content.
    const reverted = revertNote(state.currentFile!, state.notes)
    assert.equal(reverted.currentContent, V1, 'the pre-edit content comes back')
    assert.equal(reverted.currentFile.baseText, V1, 'the base is the real content, not an empty string')
    assert.equal(reverted.isDirty, false, 'discarding local work leaves a clean note')
  })

  it('keeps the local text, the draft and the base; only the ⚠️ appears', () => {
    const { origin } = diverge()
    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    assert.equal(state.currentContent, LOCAL_EDIT, 'the editor reopens on the local edit')
    assert.equal(state.isDirty, true)

    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, true, '⚠️ remote has changes')
    assert.equal(outcome.updated, false, 'the remote is NOT applied over the edit')
    assert.equal(outcome.state.currentContent, LOCAL_EDIT, 'local text intact')
    assert.equal(draftCache.get(PATH), LOCAL_EDIT, 'draft intact')
    assert.deepEqual(baseOf(outcome.state.currentFile!), { text: V1, sha: 'sha-v1' }, 'base pinned for a merge')
  })

  it('the warning survives a reload — the divergence is still detected', () => {
    const { origin } = diverge()
    const record = [
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ]
    const first = openNote(loadFromCache(record), PATH)
    const firstOutcome = refreshOpenNote(prefetch(refreshListing(first, origin, [PATH]), origin), origin)
    assert.equal(firstOutcome.flagged, true, 'reload #1 flags')

    // The listing prefetch must not advance the base, or reload #2 would see
    // "remote === base" and silently clear the warning.
    const reloaded = openNote(loadFromCache(cachedRecord(firstOutcome.state)), PATH)
    assert.deepEqual(baseOf(reloaded.currentFile!), { text: V1, sha: 'sha-v1' }, 'the cached base is the merge base')
    assert.equal(reloaded.isDirty, true, 'the draft is still recognised as an edit')
    const secondOutcome = refreshOpenNote(prefetch(refreshListing(reloaded, origin, [PATH]), origin), origin)
    assert.equal(secondOutcome.flagged, true, 'reload #2 still flags')
  })

  it('a prefetch never advances the base of a drafted note', () => {
    const { origin } = diverge()
    const state = loadFromCache([
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ])
    const after = prefetch(refreshListing(state, origin, [PATH]), origin)
    const note = after.notes[0]!
    assert.deepEqual(baseOf(note), { text: V1, sha: 'sha-v1' }, 'base untouched')
    assert.equal(note.sha, origin.get(PATH)!.sha, 'the listing SHA still moves forward')
    assert.notEqual(note.sha, 'sha-v1', 'and it really did move')
  })

  it('taking the remote resolves it: local edit dropped, base moved, draft gone', () => {
    const { origin } = diverge()
    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    const remoteSha = origin.get(PATH)!.sha
    const pending: Pending = { path: PATH, content: origin.get(PATH)!.b64, sha: remoteSha }
    const resolved = applyRemoteWarning(outcome.state, pending)

    assert.equal(resolved.currentContent, V2, 'the remote version is now in the editor')
    assert.equal(draftCache.has(PATH), false, 'draft dropped')
    assert.equal(resolved.isDirty, false, 'clean')
    assert.equal(resolved.notes[0]!.dirty, false, 'the sidebar badge is gone')
    assert.deepEqual(baseOf(resolved.currentFile!), { text: V2, sha: remoteSha })
    assert.equal(planPull({ base: baseOf(resolved.currentFile!), remoteSha, working: null }), 'up-to-date')
  })

  it('a keystroke that lands mid-flight flags instead of yanking the editor', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]), PATH)
    origin.push(PATH, V2)
    // planPull was computed as "apply" (the note was clean) but the user typed
    // while the blob was in flight.
    const typing: AppState = { ...state, isDirty: true, currentContent: `${V1}!` }
    draftCache.set(PATH, `${V1}!`)
    const outcome = refreshOpenNote(typing, origin)
    assert.equal(outcome.flagged, true)
    assert.equal(outcome.updated, false)
    assert.equal(outcome.state.currentContent, `${V1}!`, 'the keystroke survives')
  })
})

// =====================================================================
// 3. A base recorded on another device (or by an older build).
// =====================================================================

describe('unknown base', () => {
  it('no base + no local edits → takes the remote', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V2, 'sha-v2')
    const state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v2', content: b64(V2) })]), PATH)
    assert.deepEqual(baseOf(state.currentFile!), { text: V2, sha: 'sha-v2' }, 'opening establishes the base')
  })

  it('no base + local edits + a differing remote → flagged after decrypting', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    origin.push(PATH, V2)
    draftCache.set(PATH, LOCAL_EDIT)
    const state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]), PATH)
    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, true)
    assert.equal(outcome.state.currentContent, LOCAL_EDIT, 'the local edit is not lost')
  })

  it('no base + local edits that the remote already has → up to date, not a conflict', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, LOCAL_EDIT, 'sha-remote')
    draftCache.set(PATH, LOCAL_EDIT)
    const state = openNote(
      loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-remote', content: b64(LOCAL_EDIT) })]),
      PATH,
    )
    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, false, 'the edit is already on the remote')
    assert.equal(outcome.updated, false, 'so there is nothing to apply')
    assert.deepEqual(
      baseOf(outcome.state.currentFile!),
      { text: LOCAL_EDIT, sha: 'sha-remote' },
      'the base is the text the remote already carries',
    )
    assert.equal(outcome.state.notes[0]!.dirty, false, 'and the draft is dropped as redundant')
  })
})

// =====================================================================
// 4. Save → reconnect must be a no-op, and never a false conflict.
// =====================================================================

describe('saving then reconnecting', () => {
  it('the note is clean and the next pull has nothing to do', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    let state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]), PATH)

    state = { ...state, currentContent: LOCAL_EDIT, isDirty: true }
    draftCache.set(PATH, LOCAL_EDIT)
    state = saveNote(state, origin, PATH, LOCAL_EDIT)

    assert.equal(state.notes[0]!.dirty, false, 'saved → clean in the sidebar')
    assert.equal(draftCache.has(PATH), false, 'draft removed')
    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.updated, false)
    assert.equal(outcome.flagged, false)
    assert.equal(outcome.state.currentFile!.sha, origin.get(PATH)!.sha, 'the save SHA is what gets sent next')
  })

  it('a save survives a reload (the base rides in the cache record)', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    let state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]), PATH)
    state = { ...state, currentContent: LOCAL_EDIT, isDirty: true }
    draftCache.set(PATH, LOCAL_EDIT)
    state = saveNote(state, origin, PATH, LOCAL_EDIT)

    const reloaded = loadFromCache(cachedRecord(state))
    const reopened = openNote(reloaded, PATH)
    assert.equal(reopened.isDirty, false, 'no phantom edit after reload')
    assert.equal(reopened.notes[0]!.dirty, false)
    assert.deepEqual(baseOf(reopened.currentFile!), { text: LOCAL_EDIT, sha: origin.get(PATH)!.sha })
  })
})

// =====================================================================
// 5. Offline behaviour: the snapshot must stay truthful.
// =====================================================================

describe('offline', () => {
  it('shows the snapshot and reports no remote change (no connect happened)', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    assert.equal(state.currentContent, V1)
    assert.equal(state.notes[0]!.dirty, false)
    assert.equal(draftCache.size, 0, 'no drafts invented')
  })

  it('an offline edit is still detected as unsaved', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    draftCache.set(PATH, LOCAL_EDIT)
    const state = loadFromCache([
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ])
    assert.equal(state.notes[0]!.dirty, true, 'the local edit is badged')
    assert.equal(openNote(state, PATH).currentContent, LOCAL_EDIT)
  })

  it('reconnecting later resolves the offline edit without a false conflict', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    draftCache.set(PATH, LOCAL_EDIT)
    const offline = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    // The remote never moved: our edit is just unpushed.
    const outcome = refreshOpenNote(prefetch(refreshListing(offline, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, false, 'nothing to warn about')
    assert.equal(outcome.updated, false, 'and nothing to overwrite')
    assert.equal(outcome.state.currentContent, LOCAL_EDIT)
  })
})

// =====================================================================
// 6. The background walk must not erase the bases it did not decrypt.
// =====================================================================

describe('background prefetch of other directories', () => {
  it('carryBases from the existing record preserves each base', () => {
    // What walkAllDirsAndPrefetch does per directory: rebuild the notes from a
    // fresh listing, then merge the base back out of the record it is about to
    // overwrite.
    const record = [
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ]
    const origin = new FakeOrigin()
    origin.push(PATH, V2)

    const walked = prefetch(
      { ...initialState(), notes: [makeNote({ name: PATH, path: PATH, sha: origin.get(PATH)!.sha })] },
      origin,
    )
    const merged = carryBases(walked.notes, record)
    assert.deepEqual(baseOf(merged[0]!), { text: V1, sha: 'sha-v1' }, 'the merge base survived the walk')
    assert.equal(merged[0]!.content, origin.get(PATH)!.b64, 'the payload is the fresh one')
  })

  it('a note that was never opened keeps an unknown base rather than a wrong one', () => {
    const record = [makeNote({ name: PATH, path: PATH })]
    const origin = new FakeOrigin()
    origin.seed(PATH, V2, 'sha-v2')
    const walked = prefetch({ ...initialState(), notes: [makeNote({ name: PATH, path: PATH })] }, origin)
    const merged = carryBases(walked.notes, record)
    assert.deepEqual(baseOf(merged[0]!), { text: null, sha: null })
    assert.equal(planPull({ base: baseOf(merged[0]!), remoteSha: 'sha-v2', working: null }), 'apply')
  })
})

// =====================================================================
// 7. Multi-note directories: a divergence in one note must not block another.
// =====================================================================

describe('several notes in one directory', () => {
  const OTHER = 'other.md.gpg'
  const OTHER_V1 = 'other first'
  const OTHER_V2 = 'other changed'

  it('fast-forwards the clean note and flags only the edited one', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    origin.seed(OTHER, OTHER_V1, 'sha-o1')
    draftCache.set(PATH, LOCAL_EDIT)
    origin.push(PATH, V2)
    origin.push(OTHER, OTHER_V2)

    let state = loadFromCache([
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      makeNote({
        name: OTHER,
        path: OTHER,
        sha: 'sha-o1',
        content: b64(OTHER_V1),
        baseText: OTHER_V1,
        baseSha: 'sha-o1',
      }),
    ])
    state = openNote(state, PATH)
    state = prefetch(refreshListing(state, origin, [PATH, OTHER]), origin)

    const listed = state.notes.find(n => n.path === PATH)!
    assert.equal(listed.dirty, true, 'the edited note is badged')
    assert.equal(state.notes.find(n => n.path === OTHER)!.dirty, false, 'the clean note is not')

    // Pull the clean note.
    const cleanState: AppState = {
      ...state,
      currentFile: state.notes.find(n => n.path === OTHER)!,
      currentContent: OTHER_V1,
      originalContent: OTHER_V1,
      isDirty: false,
    }
    const outcome = refreshOpenNote(cleanState, origin)
    assert.equal(outcome.updated, true, 'the clean note updated')
    assert.equal(outcome.flagged, false)
    assert.equal(outcome.state.currentContent, OTHER_V2)
    assert.equal(draftCache.get(PATH), LOCAL_EDIT, "the other note's edit is untouched")
  })
})

// =====================================================================
// 8. The persisted record must keep the base the pull advanced.
// =====================================================================

describe('the advanced merge base survives in the cache record', () => {
  it('a startup fast-forward is persisted, so the walk cannot revert it', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const record = [makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]
    origin.push(PATH, V2)

    const { state, record: stored } = startupWithRecord(origin, record, { persistAfterRefresh: true })

    assert.equal(state.currentContent, V2, 'the editor fast-forwarded')
    const storedNote = stored.find(n => n.path === PATH)!
    assert.deepEqual(
      baseOf(storedNote),
      { text: V2, sha: origin.get(PATH)!.sha },
      'the record must hold the base the pull advanced, not the one it replaced',
    )
  })

  it('regression: without a write after the refresh, the walk restores the stale base', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const record = [makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1) })]
    origin.push(PATH, V2)

    // The bug: the fast-forward is applied to state.notes only, so the walk
    // re-reads the pre-refresh record and writes the old base back.
    const { state, record: stored } = startupWithRecord(origin, record)
    assert.equal(state.currentContent, V2, 'in memory the base is correct')
    assert.deepEqual(
      baseOf(stored.find(n => n.path === PATH)!),
      { text: V1, sha: 'sha-v1' },
      'bug: the persisted base is the pre-pull one, so the next reload re-pulls',
    )
  })

  it('a base that was persisted first is not clobbered by the walk', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const record = [
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ]
    origin.push(PATH, V2)

    const { record: stored } = startupWithRecord(origin, record, { persistAfterRefresh: true })
    const storedNote = stored.find(n => n.path === PATH)!
    assert.equal(storedNote.content, origin.get(PATH)!.b64, 'the payload is fresh')
    assert.equal(storedNote.baseText, V2, 'and so is the base it was decrypted from')
  })
})

// =====================================================================
// 9. The draft must track the editor in both directions.
// =====================================================================

/** Mirrors app.ts onEditorInput(): recompute dirty, then save OR remove the draft. */
function editNote(state: AppState, text: string): AppState {
  const result = computeDirtyState(state.notes, state.currentFile, text, state.originalContent)
  const next: AppState = {
    ...state,
    currentContent: text,
    notes: result.notes,
    currentFile: result.currentFile,
    isDirty: result.isDirty,
  }
  if (state.currentFile) {
    if (result.isDirty) draftCache.set(state.currentFile.path, text)
    else draftCache.delete(state.currentFile.path)
  }
  return next
}

describe('typing and then undoing an edit', () => {
  function opened(): { origin: FakeOrigin; state: AppState } {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    return { origin, state }
  }

  it('the draft is written while dirty', () => {
    const { state } = opened()
    const edited = editNote(state, `${V1}\ntyped`)
    assert.equal(edited.isDirty, true)
    assert.equal(draftCache.get(PATH), `${V1}\ntyped`, 'unsaved work is persisted')
  })

  it('undoing back to the base removes the draft', () => {
    const { state } = opened()
    const undone = editNote(editNote(state, `${V1}\ntyped`), V1)
    assert.equal(undone.isDirty, false)
    assert.equal(
      draftCache.has(PATH),
      false,
      'the abandoned text must not outlive the undo — it would resurrect on the next open',
    )
  })

  it('the note reloads clean, without the abandoned text', () => {
    const { state } = opened()
    const undone = editNote(editNote(state, `${V1}\ntyped`), V1)
    const reloaded = loadFromCache([...undone.notes])
    assert.equal(reloaded.notes[0]!.dirty, false, 'not badged unsaved')
    const reopened = openNote(reloaded, PATH)
    assert.equal(reopened.isDirty, false)
    assert.equal(reopened.currentContent, V1)
  })

  it('and a changed remote fast-forwards instead of warning', () => {
    const { origin, state } = opened()
    const undone = editNote(editNote(state, `${V1}\ntyped`), V1)
    origin.push(PATH, V2)
    const outcome = refreshOpenNote(prefetch(refreshListing(undone, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, false, 'no ⚠️ for an edit the user undid')
    assert.equal(outcome.updated, true, 'the remote is applied')
    assert.equal(outcome.state.currentContent, V2)
  })

  it('a stale divergent draft from an older build is surfaced, never silently dropped', () => {
    // Defensive: localStorage can hold a draft written by a build that only ever
    // appended to the map. Even if such a draft is sitting next to a clean editor,
    // it is an unknown working copy, so the honest answer is to warn and let the
    // user decide — never to overwrite it.
    const { origin, state } = opened()
    draftCache.set(PATH, `${V1}\nabandoned by an older build`)
    origin.push(PATH, V2)
    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, true, 'the ⚠️ is the honest outcome')
    assert.equal(outcome.updated, false, 'the local text is not overwritten')
    assert.equal(draftCache.get(PATH), `${V1}\nabandoned by an older build`, 'and the draft is kept')
  })
})

// =====================================================================
// 10. Unknown base whose remote already carries the local edit.
// =====================================================================

describe('unknown base whose remote already has the local edit', () => {
  it('adopts the remote as the base and raises no ⚠️', () => {
    const origin = new FakeOrigin()
    // Pushed from another device; this device still has it as an unsaved draft
    // and its cache record predates the merge base, so nothing can be compared.
    origin.seed(PATH, LOCAL_EDIT, 'sha-remote')
    draftCache.set(PATH, LOCAL_EDIT)
    const state = openNote(loadFromCache([makeNote({ name: PATH, path: PATH, sha: '', content: null })]), PATH)
    const note = state.currentFile!
    const base = baseOf(note)
    const working = localWorkingText({
      draft: draftCache.get(PATH),
      openText: state.currentContent,
      isOpenDirty: state.isDirty,
    })
    assert.deepEqual(base, { text: null, sha: null }, 'nothing to merge against')
    assert.equal(isModified(base, working), true, 'a draft with no base counts as an edit')
    assert.equal(planPull({ base, remoteSha: 'sha-remote', working }), 'decrypt', 'needs the plaintext')
    assert.equal(decidePull({ base: base.text, working, remote: LOCAL_EDIT }), 'up-to-date')

    const outcome = refreshOpenNote(prefetch(refreshListing(state, origin, [PATH]), origin), origin)
    assert.equal(outcome.flagged, false, 'our edit is already on the remote — nothing to warn about')
    assert.equal(outcome.state.currentContent, LOCAL_EDIT, 'and the editor must not be yanked')
    assert.equal(draftCache.has(PATH), false, 'the draft is redundant, not a conflict')
    assert.deepEqual(
      baseOf(outcome.state.currentFile!),
      { text: LOCAL_EDIT, sha: 'sha-remote' },
      'the base is adopted from the remote',
    )
  })
})

// =====================================================================
// 11. Navigating into a directory must not blind the pull decision.
// =====================================================================

describe('navigating into a directory with a drafted note', () => {
  // mergeDirListing(app.ts navigateToDir) merges the listing against the TARGET
  // dir's cache record. Reading the base from state.notes instead (the directory
  // being left) matches no path, so a drafted note ends up with no base AND no
  // content — and "discard" then reverts it to an empty note.
  it('the drafted note keeps its base and its pre-edit blob', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    draftCache.set(PATH, LOCAL_EDIT)

    // The subdir's own cache record, as loadFromCache would have left it.
    const dirRecord = [
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ]

    // A fresh listing for that dir (content-less), merged the way the app does.
    const listed = [makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: null })]
    const merged = applyLocalStatus(
      mergeDirListing(listed, dirRecord, p => draftCache.has(p)),
      p => draftCache.get(p),
    )
    // The prefetch then skips it, exactly as fetchAllNotesContent does.
    const afterPrefetch = prefetch({ ...initialState(), notes: merged }, origin)

    const note = afterPrefetch.notes[0]!
    assert.notEqual(note.content, null, 'a drafted note must not be left content-less')
    assert.equal(note.content, b64(V1), 'it keeps the pre-edit blob')
    assert.deepEqual(baseOf(note), { text: V1, sha: 'sha-v1' }, 'and the base to compare the draft against')
    assert.equal(note.dirty, true, 'the local edit is still badged')

    // Opened from that state, the note can be reverted to real content.
    const state = openNote({ ...initialState(), notes: afterPrefetch.notes }, PATH)
    assert.equal(state.currentContent, LOCAL_EDIT, 'the draft is shown')
    assert.equal(state.originalContent, V1, 'discard would revert to the pre-edit content, not an empty note')
    const reverted = revertNote(state.currentFile!, state.notes)
    assert.equal(reverted.currentContent, V1, 'discard restores the note, it does not empty it')
  })

  it('regression: without the merge the note has no base and discard empties it', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    draftCache.set(PATH, LOCAL_EDIT)
    // carryBases against notes from a DIFFERENT directory: no path matches.
    const listed = [makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: null })]
    const otherDir = [makeNote({ name: 'root.md.gpg', path: 'root.md.gpg', baseText: V1, baseSha: 'sha-v1' })]
    const merged = carryBases(listed, otherDir)
    assert.deepEqual(baseOf(merged[0]!), { text: null, sha: null }, 'bug: the base was carried from the wrong record')
    const state = openNote({ ...initialState(), notes: merged }, PATH)
    assert.equal(state.originalContent, '', 'bug: nothing to discard back to')
  })
})

// =====================================================================
// 12. Resolving a divergence must take the ⚠️ button down with it.
// =====================================================================

describe('a warning that no longer applies', () => {
  // A note diverges, the ⚠️ button goes up, and the user then undoes their side
  // of it. The next pull can fast-forward — but if the button is left up, they
  // are still told their note has changes and clicking it discards nothing
  // (or, worse, something) for no reason.
  function divergedThenUndone(): { state: AppState; pending: Pending; origin: FakeOrigin } {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    draftCache.set(PATH, LOCAL_EDIT)
    origin.push(PATH, V2)

    const record = [
      makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
    ]
    let state = openNote(loadFromCache(record), PATH)
    state = prefetch(refreshListing(state, origin, [PATH]), origin)
    const raised = refreshOpenNote(state, origin)
    state = raised.state
    return { state, pending: raised.pending, origin }
  }

  it('the divergence is reported', () => {
    const { pending, origin } = divergedThenUndone()
    assert.ok(pending, 'precondition: the ⚠️ button is up')
    assert.equal(pending!.sha, origin.get(PATH)!.sha, 'it points at the version the other device pushed')
  })

  it('undoing the edit clears the draft, so the pull can fast-forward at all', () => {
    const { state } = divergedThenUndone()
    // onEditorInput(): the text is back at the base, so the note is not dirty and
    // the draft is REMOVED rather than left holding the abandoned text.
    const note = { ...state.currentFile!, baseText: V1, baseSha: 'sha-v1' }
    const result = computeDirtyState(state.notes, note, V1, V1)
    assert.equal(result.isDirty, false, 'the edit is gone')
    draftCache.delete(PATH)
    assert.equal(
      isModified(
        baseOf(note),
        localWorkingText({
          draft: draftCache.get(PATH),
          openText: V1,
          isOpenDirty: result.isDirty,
        }),
      ),
      false,
      'and nothing is left to protect — this is what makes it fast-forwardable',
    )
  })

  it('the next pull fast-forwards and clears the warning', () => {
    const { state, pending, origin } = divergedThenUndone()
    assert.ok(pending)

    // The user undoes their edit: the draft is back to the base.
    draftCache.set(PATH, V1)
    const note = state.notes[0]!
    const after = { ...state, currentFile: note, currentContent: V1, isDirty: false, notes: [note] }

    const outcome = refreshOpenNote(after, origin, pending)
    assert.equal(outcome.updated, true, 'the remote is applied')
    assert.equal(outcome.flagged, false)
    assert.equal(outcome.pending, null, 'and the ⚠️ button goes away with it')
    assert.equal(outcome.state.currentContent, V2, 'the editor shows the remote copy')
    assert.deepEqual(
      baseOf(outcome.state.currentFile!),
      { text: V2, sha: origin.get(PATH)!.sha },
      'the base moved to it',
    )
  })

  it('a warning about a DIFFERENT note is left alone', () => {
    const origin = new FakeOrigin()
    origin.seed(PATH, V1, 'sha-v1')
    origin.push(PATH, V2)
    const state = openNote(
      loadFromCache([
        makeNote({ name: PATH, path: PATH, sha: 'sha-v1', content: b64(V1), baseText: V1, baseSha: 'sha-v1' }),
      ]),
      PATH,
    )
    const outcome = refreshOpenNote(prefetch(state, origin), origin, {
      path: 'other.md.gpg',
      content: b64('x'),
      sha: 'sha-x',
    })
    assert.equal(outcome.pending?.path, 'other.md.gpg', 'not ours to clear')
  })
})
