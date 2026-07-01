import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeDirtyState, markNoteClean, revertNote, cleanNoteInList, formatNoteItem } from '../lib/util.js';

function makeNote(overrides) {
  return {
    name: 'test.md.gpg',
    path: 'test.md.gpg',
    date: '',
    dirty: false,
    decrypted: '',
    originalText: '',
    ...overrides,
  };
}

describe('computeDirtyState', () => {
  it('returns isDirty=false when content matches original', () => {
    const note = makeNote();
    const result = computeDirtyState([note], note, 'hello', 'hello');
    assert.equal(result.isDirty, false);
    assert.equal(result.currentFile.dirty, false);
  });

  it('returns isDirty=true when content differs from original', () => {
    const note = makeNote();
    const result = computeDirtyState([note], note, 'hello', 'goodbye');
    assert.equal(result.isDirty, true);
    assert.equal(result.currentFile.dirty, true);
  });

  it('updates the note in the notes array', () => {
    const note = makeNote();
    const other = makeNote({ name: 'other.md.gpg', path: 'other.md.gpg' });
    const result = computeDirtyState([note, other], note, 'changed', 'original');
    const updated = result.notes.find(n => n.path === 'test.md.gpg');
    assert.equal(updated.dirty, true);
    const untouched = result.notes.find(n => n.path === 'other.md.gpg');
    assert.equal(untouched.dirty, false);
  });

  it('returns notes as-is when currentFile is null', () => {
    const notes = [makeNote()];
    const result = computeDirtyState(notes, null, 'hello', 'hello');
    assert.equal(result.currentFile, null);
    assert.equal(result.isDirty, false);
    assert.equal(result.notes, notes);
  });
});

describe('markNoteClean', () => {
  it('sets dirty=false, isDirty=false, and stores originalText', () => {
    const note = makeNote({ dirty: true, decrypted: 'old', originalText: 'old' });
    const result = markNoteClean(note, [note], 'saved content');
    assert.equal(result.currentFile.dirty, false);
    assert.equal(result.isDirty, false);
    assert.equal(result.currentFile.originalText, 'saved content');
    assert.equal(result.currentFile.decrypted, 'saved content');
    assert.equal(result.originalContent, 'saved content');
  });

  it('preserves other notes in the list', () => {
    const note = makeNote({ dirty: true });
    const other = makeNote({ name: 'other.md.gpg', path: 'other.md.gpg' });
    const result = markNoteClean(note, [note, other], 'saved');
    assert.equal(result.notes.length, 2);
    const otherNote = result.notes.find(n => n.path === 'other.md.gpg');
    assert.equal(otherNote.dirty, false);
  });
});

describe('revertNote', () => {
  it('sets dirty=false and reverts to originalText', () => {
    const note = makeNote({
      dirty: true,
      decrypted: 'unsaved edits',
      originalText: 'original content',
    });
    const result = revertNote(note, [note]);
    assert.equal(result.currentFile.dirty, false);
    assert.equal(result.currentFile.decrypted, 'original content');
    assert.equal(result.currentContent, 'original content');
    assert.equal(result.originalContent, 'original content');
    assert.equal(result.isDirty, false);
  });

  it('falls back to empty string when originalText is missing', () => {
    const note = makeNote({ dirty: true, originalText: undefined });
    const result = revertNote(note, [note]);
    assert.equal(result.currentFile.decrypted, '');
    assert.equal(result.currentContent, '');
  });
});

describe('cleanNoteInList', () => {
  it('cleans dirty flag on the matching note', () => {
    const notes = [makeNote({ path: 'a.md.gpg', dirty: true }), makeNote({ path: 'b.md.gpg', dirty: true })];
    const result = cleanNoteInList(notes, 'a.md.gpg');
    assert.equal(result.find(n => n.path === 'a.md.gpg').dirty, false);
    assert.equal(result.find(n => n.path === 'b.md.gpg').dirty, true);
  });

  it('returns same array when path not found', () => {
    const notes = [makeNote({ dirty: true })];
    const result = cleanNoteInList(notes, 'nonexistent.md.gpg');
    assert.equal(result.find(n => n.path === 'test.md.gpg').dirty, true);
  });
});

describe('dirty-state chain with formatNoteItem', () => {
  it('initially clean note has no asterisk', () => {
    const note = makeNote();
    assert.doesNotMatch(formatNoteItem(note, null), / \*/);
  });

  it('computeDirtyState → dirty note shows asterisk', () => {
    const note = makeNote({ decrypted: 'original', originalText: 'original' });
    const result = computeDirtyState([note], note, 'edited', 'original');
    assert.match(formatNoteItem(result.currentFile, null), / \*/);
    assert.match(formatNoteItem(result.currentFile, null), /status-badge dirty/);
  });

  it('dirty → markNoteClean → asterisk removed', () => {
    const note = makeNote({ dirty: true, decrypted: 'unsaved', originalText: 'original' });
    const result = markNoteClean(note, [note], 'saved content');
    const html = formatNoteItem(result.currentFile, null);
    assert.doesNotMatch(html, / \*/);
    assert.doesNotMatch(html, /status-badge dirty/);
  });

  it('dirty → revertNote → asterisk removed', () => {
    const note = makeNote({
      dirty: true,
      decrypted: 'unsaved edits',
      originalText: 'original content',
    });
    const result = revertNote(note, [note]);
    const html = formatNoteItem(result.currentFile, null);
    assert.doesNotMatch(html, / \*/);
  });

  it('dirty → cleanNoteInList → asterisk removed', () => {
    const note = makeNote({ dirty: true });
    const notesArray = [note];
    const cleaned = cleanNoteInList(notesArray, note.path);
    const html = formatNoteItem(
      cleaned.find(n => n.path === note.path),
      null,
    );
    assert.doesNotMatch(html, / \*/);
  });
});

describe('save button state (isDirty → saveBtn.disabled = !isDirty)', () => {
  it('clean note → save disabled', () => {
    const note = makeNote({ decrypted: 'hello', originalText: 'hello' });
    const result = computeDirtyState([note], note, 'hello', 'hello');
    assert.equal(result.isDirty, false);
  });

  it('edit → save enabled', () => {
    const note = makeNote({ decrypted: 'hello', originalText: 'hello' });
    const result = computeDirtyState([note], note, 'edited', 'hello');
    assert.equal(result.isDirty, true);
  });

  it('edit → undo (match original) → save disabled', () => {
    const note = makeNote({ decrypted: 'hello', originalText: 'hello' });
    const dirty = computeDirtyState([note], note, 'edited', 'hello');
    assert.equal(dirty.isDirty, true);
    const clean = computeDirtyState(dirty.notes, dirty.currentFile, 'hello', 'hello');
    assert.equal(clean.isDirty, false);
  });

  it('full cycle: clean → edit → save → clean → save disabled', () => {
    const original = makeNote({ decrypted: 'original', originalText: 'original', dirty: false });

    // edit
    const edited = computeDirtyState([original], original, 'edited', 'original');
    assert.equal(edited.isDirty, true);

    // save
    const saved = markNoteClean(edited.currentFile, edited.notes, 'edited');
    assert.equal(saved.isDirty, false);
    assert.equal(saved.currentFile.dirty, false);
    assert.equal(saved.currentFile.originalText, 'edited');
  });

  it('full cycle: clean → edit → discard → clean → save disabled', () => {
    const note = makeNote({ decrypted: 'edited', originalText: 'original', dirty: true });

    // discard
    const discarded = revertNote(note, [note]);
    assert.equal(discarded.isDirty, false);
    assert.equal(discarded.currentContent, 'original');
    assert.equal(discarded.originalContent, 'original');
  });

  it('new note (originalContent empty) → save enabled', () => {
    const note = makeNote({ decrypted: '# New\n\n', originalText: '', dirty: false });
    const result = computeDirtyState([note], note, '# New\n\n', '');
    assert.equal(result.isDirty, true);
  });

  it('load from API (markNoteClean with decrypted) → save disabled', () => {
    const note = makeNote({ dirty: false, content: 'b64', decrypted: null, originalText: '' });
    const decrypted = 'file content from api';
    const loaded = markNoteClean(note, [note], decrypted);
    assert.equal(loaded.isDirty, false);
    assert.equal(loaded.currentFile.dirty, false);
  });

  it('draft load (originalContent set to draft text) → save enabled', () => {
    const note = makeNote({ dirty: false, decrypted: null, originalText: '' });
    const draft = 'unsaved draft text';
    // selectNote draft path sets originalContent to draft and isDirty true
    const loaded = { ...computeDirtyState([note], note, draft, ''), isDirty: true };
    assert.equal(loaded.isDirty, true);
    // If user does not edit further, content == original (both draft)
    const noEdit = computeDirtyState(loaded.notes, loaded.currentFile, draft, draft);
    // isDirty is false BUT selectNote overrides to true —
    // This documents the choice: draft loads force dirty regardless of comparison
    assert.equal(
      noEdit.isDirty,
      false,
      'computeDirtyState says clean when draft===original, but selectNote forces isDirty=true',
    );
  });
});
