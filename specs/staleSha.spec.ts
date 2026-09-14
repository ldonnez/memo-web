import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { markNoteClean, saveNoteClean, reconcileSha, decideRemoteRefresh, applyRemoteContent } from '../lib/util.ts'
import { makeNote } from './helpers.ts'
import type { Note } from '../lib/types.ts'

// =====================================================================
// Regression tests for the stale-SHA conflict bug.
//
// Reported bug: open the app, edit + save a note (works), come back later,
// edit the same note again, press save → "conflict" error even though the
// remote change is the user's OWN previous save.
//
// Root cause (two halves):
//   1. saveNote() only wrote the new blob SHA returned by GitHub into
//      state.currentFile — state.notes[] kept the OLD SHA. A later
//      cacheNotesToLocalStorage() persisted the stale-SHA record.
//   2. After a reload, the cache served the stale SHA and
//      refreshOpenNoteContent()'s 'skip' branch (content matches → nothing
//      to refresh) never reconciled it. The next save therefore sent the
//      stale SHA to the GitHub Contents API → 409 "does not match".
//
// Fix: saveNoteClean() propagates the new SHA into both copies, saveNote()
// now also persists the updated notes to IndexedDB, and reconcileSha() fixes
// up a stale SHA in the skip branch.
// =====================================================================

function makeStaleNote(overrides: Partial<Note> = {}): Note {
  return makeNote({ name: 'test.md.gpg', path: 'test.md.gpg', sha: 'sha-old', content: 'b64-old', ...overrides })
}

// =====================================================================
// Half 1: save must propagate the new SHA into state.notes, not just
// state.currentFile. markNoteClean (the old save path) preserves the old SHA.
// =====================================================================

describe('save SHA propagation', () => {
  it('markNoteClean preserves the old SHA (the repro — save path must override it)', () => {
    const note = makeStaleNote()
    const clean = markNoteClean(note, [note], 'decrypted text')
    assert.equal(clean.currentFile.sha, 'sha-old', 'markNoteClean keeps the old SHA')
    assert.equal(clean.notes[0]!.sha, 'sha-old', 'notes copy also keeps the old SHA')
  })

  it('saveNoteClean propagates the new SHA into BOTH currentFile and notes', () => {
    const note = makeStaleNote()
    const result = saveNoteClean(note, [note], 'b64-new', 'sha-new', 'decrypted text')

    assert.equal(result.currentFile.sha, 'sha-new', 'currentFile gets the new SHA')
    assert.equal(result.notes[0]!.sha, 'sha-new', 'notes list gets the new SHA')
    assert.equal(result.currentFile.content, 'b64-new', 'currentFile gets the new content')
    assert.equal(result.notes[0]!.content, 'b64-new', 'notes list gets the new content')
    assert.equal(result.isDirty, false, 'note is clean after save')
    assert.equal(result.currentFile.dirty, false, 'dirty flag cleared')
    assert.equal(result.originalContent, 'decrypted text', 'originalContent updated')
  })

  it('saveNoteClean shares the same updated note object across currentFile and notes', () => {
    const note = makeStaleNote()
    const result = saveNoteClean(note, [note], 'b64-new', 'sha-new')
    assert.strictEqual(result.currentFile, result.notes[0], 'same object reference — no divergence possible')
  })

  it('saveNoteClean leaves other notes untouched', () => {
    const a = makeStaleNote()
    const b = makeNote({ name: 'b.md.gpg', path: 'b.md.gpg', sha: 'sha-b', content: 'b64-b' })
    const result = saveNoteClean(a, [a, b], 'b64-a2', 'sha-a2')
    assert.equal(result.notes[1]!.sha, 'sha-b', 'other note SHA untouched')
    assert.equal(result.notes[1]!.content, 'b64-b', 'other note content untouched')
  })
})

describe('the cache handoff after a save', () => {
  it('persisting state.notes after saveNoteClean records the correct SHA (no stale cache)', () => {
    const note = makeStaleNote()
    const result = saveNoteClean(note, [note], 'b64-new', 'sha-new')
    // cacheNotesToLocalStorage(result.notes, ...) — what saveNote now persists
    const persisted = result.notes.find(n => n.path === 'test.md.gpg')!
    assert.equal(persisted.sha, 'sha-new', 'cache record holds the correct SHA')
    assert.equal(persisted.content, 'b64-new', 'cache record holds the correct content')
  })
})

// =====================================================================
// Half 2: refreshOpenNoteContent's skip branch must reconcile a stale SHA
// even when the content already matches the remote.
// =====================================================================

describe('decideRemoteRefresh — skip still needs SHA reconciliation', () => {
  it('returns skip when remote content equals local content', () => {
    const note = makeStaleNote()
    const decision = decideRemoteRefresh(note, false, false, 'b64-old', 'sha-remote')
    assert.equal(decision.action, 'skip', 'content unchanged → skip')
  })

  it('skip carries no SHA — so the caller must reconcile separately (the repro)', () => {
    const note = makeStaleNote()
    const decision = decideRemoteRefresh(note, false, false, 'b64-old', 'sha-remote')
    assert.equal(decision.action, 'skip')
    // OLD app.ts skip branch just returned; note.sha stayed 'sha-old' while the
    // remote is 'sha-remote' → next save conflicts.
    assert.equal(note.sha, 'sha-old', 'note SHA was never reconciled by the old skip branch')
  })
})

describe('reconcileSha — fixes the stale SHA in the skip branch', () => {
  it('updates currentFile and notes when the remote SHA differs', () => {
    const note = makeStaleNote()
    const reconciled = reconcileSha(note, [note], 'sha-remote')
    assert.ok(reconciled, 'a reconciliation is produced')
    assert.equal(reconciled!.currentFile.sha, 'sha-remote', 'currentFile SHA reconciled')
    assert.equal(reconciled!.notes[0]!.sha, 'sha-remote', 'notes SHA reconciled')
  })

  it('preserves content while reconciling the SHA', () => {
    const note = makeStaleNote()
    const reconciled = reconcileSha(note, [note], 'sha-remote')!
    assert.equal(reconciled.currentFile.content, 'b64-old', 'content untouched')
    assert.equal(reconciled.currentFile.decrypted, note.decrypted, 'decrypted untouched')
  })

  it('returns null (no-op) when the SHA already matches the remote', () => {
    const note = makeStaleNote()
    assert.equal(reconcileSha(note, [note], 'sha-old'), null, 'no update when SHAs match')
  })

  it('leaves other notes untouched', () => {
    const a = makeStaleNote()
    const b = makeNote({ name: 'b.md.gpg', path: 'b.md.gpg', sha: 'sha-b', content: 'b64-b' })
    const reconciled = reconcileSha(a, [a, b], 'sha-fresh')!
    assert.equal(reconciled.notes[1]!.sha, 'sha-b', 'other note untouched')
  })
})

// =====================================================================
// Full round-trip through the real functions: save → cache → reload →
// refresh → save. The stale-SHA bug made the final save 409-conflict.
// =====================================================================

describe('full round-trip — save → cache → reload → refresh → save', () => {
  it('fixed save keeps the SHA consistent across reload and refresh', () => {
    // Session A: user saves → GitHub returns sha-v2
    const note = makeStaleNote({ content: 'b64-v1' })
    const afterSave = saveNoteClean(note, [note], 'b64-v2', 'sha-v2', 'saved')
    const cached = afterSave.notes[0]!
    assert.equal(cached.sha, 'sha-v2', 'cache holds the correct SHA')
    assert.equal(cached.content, 'b64-v2', 'cache holds the correct content')

    // Session B: reload from cache, open the note → SHA is already correct
    assert.equal(cached.sha, 'sha-v2', 'reloaded note has the correct SHA')

    // Session B: background refresh — content matches → skip, and the SHA is
    // already in sync so reconcileSha is a no-op
    const decision = decideRemoteRefresh(cached, false, false, 'b64-v2', 'sha-v2')
    assert.equal(decision.action, 'skip')
    const reconciled = reconcileSha(cached, afterSave.notes, 'sha-v2')
    assert.equal(reconciled, null, 'no reconciliation needed — SHA already correct')

    // Session B: user saves → sends sha-v2 → GitHub has sha-v2 → no conflict
    assert.equal(cached.sha, 'sha-v2', 'save uses the correct SHA — no false conflict')
  })

  it('if the cache was written by the pre-fix version (stale SHA), refresh repairs it', () => {
    // Simulate a cache record created by the OLD saveNote bug: b64-v2 content
    // but sha-v1 tag.
    const stale = makeStaleNote({ sha: 'sha-v1', content: 'b64-v2' })

    // Reload + open note
    const reopened = stale
    assert.equal(reopened.sha, 'sha-v1', 'old cache served a stale SHA')

    // Background refresh: content matches the remote → skip, but SHA differs
    const decision = decideRemoteRefresh(reopened, false, false, 'b64-v2', 'sha-v2')
    assert.equal(decision.action, 'skip', 'content matches → skip')
    const reconciled = reconcileSha(reopened, [reopened], 'sha-v2')
    assert.ok(reconciled, 'reconciliation produced')
    assert.equal(reconciled!.currentFile.sha, 'sha-v2', 'refresh repaired the SHA')

    // User saves → sends sha-v2 → GitHub has sha-v2 → no false conflict
    assert.equal(reconciled!.currentFile.sha, 'sha-v2', 'save uses the repaired SHA')
  })
})

// =====================================================================
// applyRemoteContent already propagates the SHA correctly (unchanged path).
// =====================================================================

describe('applyRemoteContent — SHA propagation (already correct)', () => {
  it('sets SHA from the remote on both currentFile and notes', () => {
    const note = makeStaleNote({ sha: 'old-sha' })
    const result = applyRemoteContent(note, [note], 'new-content', 'decrypted', 'new-sha')
    assert.equal(result.currentFile.sha, 'new-sha')
    assert.equal(result.notes[0]!.sha, 'new-sha')
  })
})
