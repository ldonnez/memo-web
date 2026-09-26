import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  computeDirtyState,
  markNoteClean,
  revertNote,
  cleanNoteInList,
  formatNoteItem,
  applyRemoteContent,
  serializePendingRefresh,
  parsePendingRefresh,
} from '../lib/util.ts'
import { planPull, decidePull, localWorkingText, baseOf } from '../lib/sync.ts'
import type { Note } from '../lib/types.ts'

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    name: 'test.md.gpg',
    path: 'test.md.gpg',
    date: '',
    dirty: false,
    decrypted: '',
    originalText: '',
    sha: 'abc123',
    size: 10,
    content: null,
    ...overrides,
  }
}

describe('computeDirtyState', () => {
  it('returns isDirty=false when content matches original', () => {
    const note = makeNote()
    const result = computeDirtyState([note], note, 'hello', 'hello')
    assert.equal(result.isDirty, false)
    assert.equal(result.currentFile!.dirty, false)
  })

  it('returns isDirty=true when content differs from original', () => {
    const note = makeNote()
    const result = computeDirtyState([note], note, 'hello', 'goodbye')
    assert.equal(result.isDirty, true)
    assert.equal(result.currentFile!.dirty, true)
  })

  it('updates the note in the notes array', () => {
    const note = makeNote()
    const other = makeNote({ name: 'other.md.gpg', path: 'other.md.gpg' })
    const result = computeDirtyState([note, other], note, 'changed', 'original')
    const updated = result.notes.find(n => n.path === 'test.md.gpg')!
    assert.equal(updated.dirty, true)
    const untouched = result.notes.find(n => n.path === 'other.md.gpg')!
    assert.equal(untouched.dirty, false)
  })

  it('returns notes as-is when currentFile is null', () => {
    const notes = [makeNote()]
    const result = computeDirtyState(notes, null, 'hello', 'hello')
    assert.equal(result.currentFile, null)
    assert.equal(result.isDirty, false)
    assert.equal(result.notes, notes)
  })
})

describe('markNoteClean', () => {
  it('sets dirty=false, isDirty=false, and stores originalText', () => {
    const note = makeNote({ dirty: true, decrypted: 'old', originalText: 'old' })
    const result = markNoteClean(note, [note], 'saved content')
    assert.equal(result.currentFile.dirty, false)
    assert.equal(result.isDirty, false)
    assert.equal(result.currentFile.originalText, 'saved content')
    assert.equal(result.currentFile.decrypted, 'saved content')
    assert.equal(result.originalContent, 'saved content')
  })

  it('preserves other notes in the list', () => {
    const note = makeNote({ dirty: true })
    const other = makeNote({ name: 'other.md.gpg', path: 'other.md.gpg' })
    const result = markNoteClean(note, [note, other], 'saved')
    assert.equal(result.notes.length, 2)
    const otherNote = result.notes.find(n => n.path === 'other.md.gpg')!
    assert.equal(otherNote.dirty, false)
  })
})

describe('revertNote', () => {
  it('sets dirty=false and reverts to originalText', () => {
    const note = makeNote({
      dirty: true,
      decrypted: 'unsaved edits',
      originalText: 'original content',
    })
    const result = revertNote(note, [note])
    assert.equal(result.currentFile.dirty, false)
    assert.equal(result.currentFile.decrypted, 'original content')
    assert.equal(result.currentContent, 'original content')
    assert.equal(result.originalContent, 'original content')
    assert.equal(result.isDirty, false)
  })

  it('falls back to empty string when originalText is missing', () => {
    const note = makeNote({ dirty: true })
    const result = revertNote(note, [note])
    assert.equal(result.currentFile.decrypted, '')
    assert.equal(result.currentContent, '')
  })
})

describe('cleanNoteInList', () => {
  it('cleans dirty flag on the matching note', () => {
    const notes = [makeNote({ path: 'a.md.gpg', dirty: true }), makeNote({ path: 'b.md.gpg', dirty: true })]
    const result = cleanNoteInList(notes, 'a.md.gpg')
    assert.equal(result.find(n => n.path === 'a.md.gpg')!.dirty, false)
    assert.equal(result.find(n => n.path === 'b.md.gpg')!.dirty, true)
  })

  it('returns same array when path not found', () => {
    const notes = [makeNote({ dirty: true })]
    const result = cleanNoteInList(notes, 'nonexistent.md.gpg')
    assert.equal(result.find(n => n.path === 'test.md.gpg')!.dirty, true)
  })
})

describe('dirty-state chain with formatNoteItem', () => {
  it('initially clean note has no asterisk', () => {
    const note = makeNote()
    assert.doesNotMatch(formatNoteItem(note, undefined), / \*/)
  })

  it('computeDirtyState → dirty note shows asterisk', () => {
    const note = makeNote({ decrypted: 'original', originalText: 'original' })
    const result = computeDirtyState([note], note, 'edited', 'original')
    assert.match(formatNoteItem(result.currentFile!, undefined), / \*/)
    assert.match(formatNoteItem(result.currentFile!, undefined), /status-badge dirty/)
  })

  it('dirty → markNoteClean → asterisk removed', () => {
    const note = makeNote({ dirty: true, decrypted: 'unsaved', originalText: 'original' })
    const result = markNoteClean(note, [note], 'saved content')
    const html = formatNoteItem(result.currentFile, undefined)
    assert.doesNotMatch(html, / \*/)
    assert.doesNotMatch(html, /status-badge dirty/)
  })

  it('dirty → revertNote → asterisk removed', () => {
    const note = makeNote({
      dirty: true,
      decrypted: 'unsaved edits',
      originalText: 'original content',
    })
    const result = revertNote(note, [note])
    const html = formatNoteItem(result.currentFile, undefined)
    assert.doesNotMatch(html, / \*/)
  })

  it('dirty → cleanNoteInList → asterisk removed', () => {
    const note = makeNote({ dirty: true })
    const notesArray = [note]
    const cleaned = cleanNoteInList(notesArray, note.path)
    const html = formatNoteItem(
      cleaned.find(n => n.path === note.path)!,
      undefined,
    )
    assert.doesNotMatch(html, / \*/)
  })
})

describe('save button state (isDirty → saveBtn.disabled = !isDirty)', () => {
  it('clean note → save disabled', () => {
    const note = makeNote({ decrypted: 'hello', originalText: 'hello' })
    const result = computeDirtyState([note], note, 'hello', 'hello')
    assert.equal(result.isDirty, false)
  })

  it('edit → save enabled', () => {
    const note = makeNote({ decrypted: 'hello', originalText: 'hello' })
    const result = computeDirtyState([note], note, 'edited', 'hello')
    assert.equal(result.isDirty, true)
  })

  it('edit → undo (match original) → save disabled', () => {
    const note = makeNote({ decrypted: 'hello', originalText: 'hello' })
    const dirty = computeDirtyState([note], note, 'edited', 'hello')
    assert.equal(dirty.isDirty, true)
    const clean = computeDirtyState(dirty.notes, dirty.currentFile, 'hello', 'hello')
    assert.equal(clean.isDirty, false)
  })

  it('full cycle: clean → edit → save → clean → save disabled', () => {
    const original = makeNote({ decrypted: 'original', originalText: 'original', dirty: false })

    // edit
    const edited = computeDirtyState([original], original, 'edited', 'original')
    assert.equal(edited.isDirty, true)

    // save
    const saved = markNoteClean(edited.currentFile!, edited.notes, 'edited')
    assert.equal(saved.isDirty, false)
    assert.equal(saved.currentFile.dirty, false)
    assert.equal(saved.currentFile.originalText, 'edited')
  })

  it('full cycle: clean → edit → discard → clean → save disabled', () => {
    const note = makeNote({ decrypted: 'edited', originalText: 'original', dirty: true })

    // discard
    const discarded = revertNote(note, [note])
    assert.equal(discarded.isDirty, false)
    assert.equal(discarded.currentContent, 'original')
    assert.equal(discarded.originalContent, 'original')
  })

  it('new note (originalContent empty) → save enabled', () => {
    const note = makeNote({ decrypted: '# New\n\n', originalText: '', dirty: false })
    const result = computeDirtyState([note], note, '# New\n\n', '')
    assert.equal(result.isDirty, true)
  })

  it('load from API (markNoteClean with decrypted) → save disabled', () => {
    const note = makeNote({ dirty: false, content: 'b64', decrypted: null, originalText: '' })
    const decrypted = 'file content from api'
    const loaded = markNoteClean(note, [note], decrypted)
    assert.equal(loaded.isDirty, false)
    assert.equal(loaded.currentFile.dirty, false)
  })

  it('draft load (originalContent set to the base) → save disabled', () => {
    const note = makeNote({ dirty: false, decrypted: null, originalText: '' })
    const draft = 'unsaved draft text'
    // selectNote's draft path re-points the dirty comparison at the merge base,
    // so an untouched draft reads as clean. A draft that differs from the base
    // is what makes the note dirty (see specs/syncBase.spec.ts).
    const loaded = computeDirtyState([note], note, draft, draft)
    assert.equal(loaded.isDirty, false, 'a draft equal to the base is not a modification')
    const edited = computeDirtyState(loaded.notes, loaded.currentFile, `${draft}!`, draft)
    assert.equal(edited.isDirty, true, 'editing on top of a draft is a modification')
  })
})

describe('applyRemoteContent (open-note refresh after reconnect)', () => {
  const remote = makeNote({
    path: 'note.md.gpg',
    decrypted: 'stale cached text',
    originalText: 'stale cached text',
    content: 'old-b64',
    sha: 'old-sha',
  })

  it('replaces content + editor text with the fresh remote copy and clears dirty', () => {
    const fresh = applyRemoteContent(remote, [remote], 'new-b64', 'fresh text from origin', 'new-sha')
    assert.equal(fresh.currentFile.content, 'new-b64')
    assert.equal(fresh.currentFile.sha, 'new-sha', 'sha updated to the fresh remote sha')
    assert.equal(fresh.currentFile.decrypted, 'fresh text from origin')
    assert.equal(fresh.currentFile.dirty, false)
    assert.equal(fresh.currentContent, 'fresh text from origin')
    assert.equal(fresh.originalContent, 'fresh text from origin')
    assert.equal(fresh.isDirty, false)
    assert.equal(fresh.notes[0]!.content, 'new-b64', 'listing note updated too')
  })

  it('keeps other notes untouched', () => {
    const other = makeNote({ path: 'other.md.gpg' })
    const fresh = applyRemoteContent(remote, [remote, other], 'new-b64', 'fresh', 'new-sha')
    assert.equal(fresh.notes[1], other, 'unrelated note object identity preserved')
  })

  it('matches the markNoteClean contract: fresh state is save-disabled after refresh', () => {
    // Re-deriving dirty state from the refreshed note + content stays clean.
    const fresh = applyRemoteContent(remote, [remote], 'new-b64', 'fresh text', 'new-sha')
    const dirty = computeDirtyState(fresh.notes, fresh.currentFile, fresh.currentContent, fresh.originalContent)
    assert.equal(dirty.isDirty, false)
  })
})

describe('the pull decision for the open note (base / working / remote)', () => {
  const BASE = 'base text'
  const LOCAL = 'unsaved edits'
  const REMOTE = 'fresh text from origin'
  const known = { text: BASE, sha: 'old-sha' }

  it('remote SHA === base SHA → up-to-date (nothing to pull)', () => {
    assert.equal(planPull({ base: known, remoteSha: 'old-sha', working: null }), 'up-to-date')
  })

  it('remote moved + no local edits → apply (auto fast-forward)', () => {
    assert.equal(planPull({ base: known, remoteSha: 'new-sha', working: null }), 'apply')
  })

  it('remote moved + a draft identical to the base → apply, not a warning', () => {
    // The reported bug: a draft is written on every navigation, so an untouched
    // note used to look "locally modified" and every remote change became a ⚠️.
    assert.equal(planPull({ base: known, remoteSha: 'new-sha', working: BASE }), 'apply')
  })

  it('remote moved + real local edits → conflict (never clobber unsaved edits)', () => {
    assert.equal(planPull({ base: known, remoteSha: 'new-sha', working: LOCAL }), 'conflict')
  })

  it('a local edit does not raise a warning while the remote is unchanged', () => {
    assert.equal(planPull({ base: known, remoteSha: 'old-sha', working: LOCAL }), 'up-to-date')
  })

  it('unknown base + local edits → decrypt, and only the plaintext can conflict', () => {
    const unknown = baseOf(makeNote())
    assert.deepEqual(unknown, { text: null, sha: null })
    assert.equal(planPull({ base: unknown, remoteSha: 'new-sha', working: LOCAL }), 'decrypt')
    assert.equal(decidePull({ base: null, working: LOCAL, remote: REMOTE }), 'conflict')
    assert.equal(decidePull({ base: null, working: LOCAL, remote: LOCAL }), 'up-to-date')
  })

  it('applyRemoteContent then the next pull is up-to-date', () => {
    const note = makeNote({ path: 'note.md.gpg', originalText: BASE, baseText: BASE, baseSha: 'old-sha' })
    const fresh = applyRemoteContent(note, [note], 'new-b64', REMOTE, 'new-sha')
    assert.equal(planPull({ base: baseOf(fresh.currentFile), remoteSha: 'new-sha', working: null }), 'up-to-date')
  })

  it('an open, dirty editor is a working copy only while it is dirty', () => {
    assert.equal(localWorkingText({ openText: LOCAL, isOpenDirty: true }), LOCAL)
    assert.equal(localWorkingText({ openText: REMOTE, isOpenDirty: false }), null)
    assert.equal(localWorkingText({ draft: LOCAL, openText: REMOTE, isOpenDirty: false }), LOCAL, 'a draft counts too')
  })
})

describe('pending remote refresh persistence (survives reload)', () => {
  const PR = { path: 'sub/note.md.gpg', content: 'remote-b64', sha: 'remote-sha' }

  it('serialize → parse round-trips the exact payload', () => {
    const raw = serializePendingRefresh(PR)!
    assert.equal(typeof raw, 'string')
    assert.deepEqual(parsePendingRefresh(raw), PR)
    assert.equal(parsePendingRefresh(raw)!.content, 'remote-b64')
    assert.equal(parsePendingRefresh(raw)!.sha, 'remote-sha')
  })

  it('null payload serializes to nothing and parses back to null', () => {
    assert.equal(serializePendingRefresh(null), null)
    assert.equal(serializePendingRefresh(null) !== 'null', true, 'must not store the string "null"')
    assert.equal(parsePendingRefresh(null), null)
  })

  it('malformed JSON → null (no crash, stale flag dropped)', () => {
    assert.equal(parsePendingRefresh('not json'), null)
  })

  it('incomplete payload → null', () => {
    assert.equal(parsePendingRefresh(JSON.stringify({ path: 'x.md.gpg' })), null, 'missing content/sha')
    assert.equal(parsePendingRefresh(JSON.stringify({})), null)
    assert.equal(parsePendingRefresh(''), null)
  })

  it('extra keys are ignored, core fields win', () => {
    const raw = JSON.stringify({ ...PR, old: true, ts: 123 })
    assert.deepEqual(parsePendingRefresh(raw), PR)
  })
})
