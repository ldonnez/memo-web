import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatNoteItem, computeDirtyState, cleanNoteInList } from '../lib/util.js';

function mapEntry(item, contentCache, draftCache) {
  return {
    name: item.name,
    path: item.path,
    sha: item.sha,
    size: item.size,
    date: item.last_modified || '',
    dirty: draftCache.has(item.path) || false,
    content: contentCache.get(item.path) || null,
    decrypted: null,
    originalText: '',
  };
}

function applyDraftLoad(state, notePath, draft) {
  return {
    ...state,
    notes: state.notes.map(n => (n.path === notePath ? { ...n, dirty: true } : n)),
    currentContent: draft,
    originalContent: draft,
    isDirty: true,
  };
}

describe('draft cache — note mapping', () => {
  it('sets dirty=true when a draft exists', () => {
    const item = { name: 'test.md.gpg', path: 'test.md.gpg' };
    const cc = new Map();
    const dc = new Map([['test.md.gpg', 'unsaved content']]);
    const note = mapEntry(item, cc, dc);
    assert.strictEqual(note.dirty, true);
  });

  it('sets dirty=false when no draft exists', () => {
    const item = { name: 'test.md.gpg', path: 'test.md.gpg' };
    const cc = new Map([['test.md.gpg', 'cached']]);
    const dc = new Map();
    const note = mapEntry(item, cc, dc);
    assert.strictEqual(note.dirty, false);
  });

  it('sets content from contentCache', () => {
    const item = { name: 'test.md.gpg', path: 'test.md.gpg' };
    const cc = new Map([['test.md.gpg', 'cached content']]);
    const dc = new Map();
    const note = mapEntry(item, cc, dc);
    assert.strictEqual(note.content, 'cached content');
  });

  it('both draft and content cache can be set independently', () => {
    const item = { name: 'test.md.gpg', path: 'test.md.gpg' };
    const cc = new Map([['test.md.gpg', 'remote content']]);
    const dc = new Map([['test.md.gpg', 'draft content']]);
    const note = mapEntry(item, cc, dc);
    assert.strictEqual(note.dirty, true);
    assert.strictEqual(note.content, 'remote content');
  });

  it('returns content: null when neither cache has the path', () => {
    const item = { name: 'test.md.gpg', path: 'test.md.gpg' };
    const cc = new Map();
    const dc = new Map();
    const note = mapEntry(item, cc, dc);
    assert.strictEqual(note.dirty, false);
    assert.strictEqual(note.content, null);
  });
});

describe('draft cache — formatNoteItem integration', () => {
  it('shows asterisk when dirty from draft', () => {
    const note = { name: 'test.md.gpg', path: 'test.md.gpg', dirty: true, content: 'abc', decrypted: null };
    const html = formatNoteItem(note, '');
    assert.ok(html.includes('*'));
    assert.ok(html.includes('offline-dot'));
  });

  it('shows only offline dot when content but no draft', () => {
    const note = { name: 'test.md.gpg', path: 'test.md.gpg', dirty: false, content: 'abc', decrypted: null };
    const html = formatNoteItem(note, '');
    assert.ok(!html.includes('*'));
    assert.ok(html.includes('offline-dot'));
  });

  it('shows nothing when clean and uncached', () => {
    const note = { name: 'test.md.gpg', path: 'test.md.gpg', dirty: false, content: null, decrypted: null };
    const html = formatNoteItem(note, '');
    assert.ok(!html.includes('*'));
    assert.ok(!html.includes('offline-dot'));
  });
});

describe('draft cache — state transitions', () => {
  it('draft save preserves dirty flag on the note', () => {
    const notes = [
      { name: 'a.md.gpg', path: 'a.md.gpg', dirty: false, content: 'enc', decrypted: null, originalText: '' },
    ];
    const currentFile = notes[0];
    const draftCache = new Map();

    // Simulate: user edits → dirty
    const result = computeDirtyState(notes, currentFile, 'edited content', 'original content');
    const editedNotes = result.notes;
    assert.strictEqual(editedNotes.find(n => n.path === 'a.md.gpg').dirty, true, 'note is dirty after editing');

    // Simulate: save draft (like selectNote does when navigating away)
    draftCache.set('a.md.gpg', 'edited content');
    // After saving draft, the dirty flag stays true (selectNote no longer calls cleanNoteInList)
    assert.strictEqual(
      editedNotes.find(n => n.path === 'a.md.gpg').dirty,
      true,
      'dirty flag persists after saving draft',
    );

    // Simulate: later, selectNote loads the draft
    const state = {
      notes: editedNotes,
      currentContent: '',
      originalContent: '',
      isDirty: false,
    };
    const loaded = applyDraftLoad(state, 'a.md.gpg', draftCache.get('a.md.gpg'));
    assert.strictEqual(loaded.notes.find(n => n.path === 'a.md.gpg').dirty, true, 'note is dirty after draft load');
    assert.strictEqual(loaded.isDirty, true, 'state.isDirty is true after draft load');
    assert.strictEqual(loaded.originalContent, 'edited content', 'originalContent is the draft text');
  });

  it('draft load keeps dirty flag even when content matches original', () => {
    // This tests the scenario where setContent(draft) fires onEditorInput
    // which calls computeDirtyState with originalContent=draft.
    // The draft load code must override that and keep dirty=true.
    const notes = [
      { name: 'a.md.gpg', path: 'a.md.gpg', dirty: false, content: 'enc', decrypted: null, originalText: '' },
    ];
    const draft = 'unsaved text';

    // onEditorInput would call computeDirtyState:
    const result = computeDirtyState(notes, notes[0], draft, draft);
    // This returns isDirty=false (content matches original)
    assert.strictEqual(result.isDirty, false, 'computeDirtyState returns clean when content matches original');
    assert.strictEqual(
      result.notes.find(n => n.path === 'a.md.gpg').dirty,
      false,
      'note is clean after matching computeDirtyState',
    );

    // But applyDraftLoad must override it:
    const state = { notes: result.notes, currentContent: draft, originalContent: draft, isDirty: false };
    const loaded = applyDraftLoad(state, 'a.md.gpg', draft);
    assert.strictEqual(loaded.notes.find(n => n.path === 'a.md.gpg').dirty, true, 'draft load overrides dirty to true');
    assert.strictEqual(loaded.isDirty, true, 'draft load overrides isDirty to true');
  });

  it('cleanNoteInList clears dirty flag (used by discard/save)', () => {
    const notes = [
      { name: 'a.md.gpg', path: 'a.md.gpg', dirty: true, content: 'enc', decrypted: null, originalText: '' },
    ];
    const cleaned = cleanNoteInList(notes, 'a.md.gpg');
    assert.strictEqual(cleaned.find(n => n.path === 'a.md.gpg').dirty, false, 'cleanNoteInList clears dirty');
  });
});
