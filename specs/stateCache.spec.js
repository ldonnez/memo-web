import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { markNoteClean, cleanNoteInList, formatNoteItem } from '../lib/util.js';

// ============= HELPERS (mirror app.js logic) =============

function mapEntry(item, contentCache, draftCache) {
  return {
    name: item.name,
    path: item.path,
    sha: item.sha,
    size: item.size,
    date: item.date || '',
    dirty: draftCache.has(item.path) || false,
    content: contentCache.get(item.path) || null,
    decrypted: null,
    originalText: '',
  };
}

function mapEntries(entries, contentCache, draftCache) {
  return entries
    .filter(item => item.type === 'file' && item.name.endsWith('.md.gpg'))
    .map(item => mapEntry(item, contentCache, draftCache))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Simulates fetchAllNotesContent: skips notes with content, fetches+populates cache for others
function simulateFetchAllNotesContent(notes, contentCache, fakeContent) {
  return notes.map(n => {
    if (n.content) return n;
    const data = fakeContent(n.path);
    if (data) {
      contentCache.set(n.path, data.content);
      return { ...n, content: data.content, sha: data.sha };
    }
    return n;
  });
}

// Simulates saveNote's state update: markNoteClean + update cache + remove draft
function simulateSave(state, notePath, savedText, contentCache, draftCache) {
  const note = state.notes.find(n => n.path === notePath);
  if (!note) return state;
  const b64 = Buffer.from(savedText).toString('base64');
  const clean = markNoteClean(note, state.notes, savedText);
  draftCache.delete(notePath);
  contentCache.set(notePath, b64);
  return {
    ...state,
    ...clean,
    notes: clean.notes.map(n => (n.path === notePath ? { ...n, content: b64 } : n)),
    currentFile: { ...clean.currentFile, sha: 'newsha', content: b64 },
  };
}

function makeListingEntry(name, overrides) {
  return {
    name,
    path: name,
    type: 'file',
    sha: 'abc123',
    size: 100,
    date: '2025-01-01',
    ...overrides,
  };
}

function makeState(overrides) {
  return {
    notes: [],
    dirs: [],
    currentFile: null,
    isDirty: false,
    currentContent: '',
    originalContent: '',
    ...overrides,
  };
}

// ============= TESTS =============

describe('contentCache — note mapping after save', () => {
  it('sets dirty=false and populates content after save via markNoteClean + cache update', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg')];

    // Initial mapping (like connect/navigateToDir)
    let notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].dirty, false);
    assert.strictEqual(notes[0].content, null);

    // Simulate fetchAllNotesContent populating contentCache (first load)
    const fakeContent = p => ({ content: Buffer.from('original').toString('base64'), sha: 'sha1' });
    notes = simulateFetchAllNotesContent(notes, cc, fakeContent);
    assert.ok(cc.has('a.md.gpg'), 'contentCache populated after first fetch');
    assert.ok(notes[0].content, 'note.content set after first fetch');

    // Simulate save: user edits, saves
    let state = makeState({ notes });
    state = simulateSave(state, 'a.md.gpg', 'edited text', cc, dc);

    assert.strictEqual(dc.has('a.md.gpg'), false, 'draft deleted after save');
    assert.strictEqual(
      cc.get('a.md.gpg'),
      Buffer.from('edited text').toString('base64'),
      'contentCache updated with new b64',
    );
    const savedNote = state.notes.find(n => n.path === 'a.md.gpg');
    assert.strictEqual(savedNote.dirty, false, 'note is clean after save');
    assert.strictEqual(
      savedNote.content,
      Buffer.from('edited text').toString('base64'),
      'note.content updated in list',
    );

    // Navigate away then back (simulate selectNote: draft miss → content from cache)
    const returned = mapEntries(entries, cc, dc);
    assert.strictEqual(returned[0].dirty, false);
    assert.strictEqual(
      returned[0].content,
      Buffer.from('edited text').toString('base64'),
      'returned note has fresh content from contentCache',
    );
  });

  it('retains contentCache entry after navigating to another dir and back', () => {
    const cc = new Map();
    const dc = new Map();
    const entriesA = [makeListingEntry('a.md.gpg')];
    const entriesB = [makeListingEntry('b.md.gpg')];

    // Load dir A, populate cache
    const fakeContent = p => ({ content: Buffer.from('content-' + p).toString('base64'), sha: 's1' });
    simulateFetchAllNotesContent(mapEntries(entriesA, cc, dc), cc, fakeContent);
    assert.ok(cc.has('a.md.gpg'), 'a cached after loading dir A');

    // Navigate to dir B (creates new listing, does NOT clear contentCache)
    mapEntries(entriesB, cc, dc);
    assert.ok(cc.has('a.md.gpg'), 'a still cached after navigating to B');

    // Navigate back to dir A
    const notesAagain = mapEntries(entriesA, cc, dc);
    assert.ok(notesAagain[0].content, 'a has content from cache when returning');
    assert.strictEqual(notesAagain[0].content, Buffer.from('content-a.md.gpg').toString('base64'));
  });
});

describe('contentCache — fetchAllNotesContent skip behavior', () => {
  it('skips notes that already have content in the list', () => {
    const cc = new Map();
    const notes = [
      { name: 'a.md.gpg', path: 'a.md.gpg', content: 'existing-b64', sha: 'olds', dirty: false },
      { name: 'b.md.gpg', path: 'b.md.gpg', content: null, sha: 'sha-b', dirty: false },
    ];
    // Mark a as already cached
    cc.set('a.md.gpg', 'existing-b64');

    const called = [];
    const fakeContent = p => {
      called.push(p);
      return { content: Buffer.from('fetched').toString('base64'), sha: 'new-sha' };
    };

    const updated = simulateFetchAllNotesContent(notes, cc, fakeContent);
    assert.deepStrictEqual(called, ['b.md.gpg'], 'only b was fetched, a was skipped');
    assert.strictEqual(updated[0].content, 'existing-b64', 'a kept its existing content');
    assert.strictEqual(updated[1].content, Buffer.from('fetched').toString('base64'), 'b got fetched content');
  });

  it('populates contentCache for newly fetched notes', () => {
    const cc = new Map();
    const notes = [{ name: 'a.md.gpg', path: 'a.md.gpg', content: null, sha: 'sha-a', dirty: false }];
    const fakeContent = p => ({ content: 'cGF5bG9hZA==', sha: 'sha-new' });
    const updated = simulateFetchAllNotesContent(notes, cc, fakeContent);
    assert.strictEqual(updated[0].content, 'cGF5bG9hZA==');
    assert.strictEqual(cc.get('a.md.gpg'), 'cGF5bG9hZA==');
  });

  it('does not throw when ghGetFile fails for a note', () => {
    const cc = new Map();
    const notes = [{ name: 'a.md.gpg', path: 'a.md.gpg', content: null, sha: 'sha-a', dirty: false }];
    const fakeContent = p => null; // ghGetFile returned null/undefined
    const updated = simulateFetchAllNotesContent(notes, cc, fakeContent);
    assert.strictEqual(updated[0].content, null, 'content stayed null on fetch failure');
    assert.strictEqual(cc.has('a.md.gpg'), false, 'contentCache not set on fetch failure');
  });
});

describe('contentCache — offline fallback', () => {
  it('populates contentCache from cached note data on offline load', () => {
    const cc = new Map();
    const cachedNotes = [
      { name: 'a.md.gpg', path: 'a.md.gpg', content: 'cached-b64', sha: 'cached-sha' },
      { name: 'b.md.gpg', path: 'b.md.gpg', content: null, sha: 'sha-b' },
    ];

    // Offline catch block in connect/navigateToDir:
    for (const n of cachedNotes) {
      if (n.content) cc.set(n.path, n.content);
    }

    assert.strictEqual(cc.get('a.md.gpg'), 'cached-b64', 'contentCache populated from cached note');
    assert.strictEqual(cc.has('b.md.gpg'), false, 'null-content cached entry does not pollute contentCache');
  });

  it('offline-loaded contentCache survives subsequent listing mapping', () => {
    const cc = new Map();
    const dc = new Map();

    // Simulate loading from IndexedDB cache
    cc.set('a.md.gpg', 'offline-b64');

    // Now map entries (like connect() offline catch does after populating contentCache)
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].content, 'offline-b64', 'note gets content from offline-populated cache');
    assert.strictEqual(notes[0].dirty, false, 'offline note is clean');
  });
});

describe('contentCache — save updates both cache and list', () => {
  it('updates note.content in the notes array AND contentCache after save', () => {
    const cc = new Map();
    cc.set('a.md.gpg', 'old-b64');
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    let state = makeState({ notes });

    state = simulateSave(state, 'a.md.gpg', 'new content', cc, dc);

    const savedB64 = Buffer.from('new content').toString('base64');
    assert.strictEqual(cc.get('a.md.gpg'), savedB64, 'contentCache has new b64');
    assert.strictEqual(state.notes.find(n => n.path === 'a.md.gpg').content, savedB64, 'notes array has new b64');

    // Subsequent mapping also sees new b64
    const remapped = mapEntries(entries, cc, dc);
    assert.strictEqual(remapped[0].content, savedB64, 'remapped note has new b64');
  });

  it('updates SHA in currentFile but not in notes array', () => {
    const cc = new Map();
    const dc = new Map();
    const fakeContent = p => ({ content: 'b64', sha: 'oldsha' });
    let notes = mapEntries([makeListingEntry('a.md.gpg', { sha: 'sha-a' })], cc, dc);
    notes = simulateFetchAllNotesContent(notes, cc, fakeContent);
    let state = makeState({ notes, currentFile: notes[0] });

    state = simulateSave(state, 'a.md.gpg', 'saved', cc, dc);
    assert.strictEqual(state.currentFile.sha, 'newsha', 'currentFile.sha updated');
    assert.notStrictEqual(
      state.currentFile.sha,
      state.notes.find(n => n.path === 'a.md.gpg').sha,
      'notes array sha lags behind currentFile.sha — not updated during save',
    );
  });
});

describe('draftCache + contentCache interplay', () => {
  it('save removes draft, updates cache, and note maps as clean with content', () => {
    const cc = new Map();
    cc.set('a.md.gpg', 'old-b64');
    const dc = new Map();
    dc.set('a.md.gpg', 'unsaved edit');

    // Initial mapping shows dirty + cached
    const entries = [makeListingEntry('a.md.gpg')];
    let notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].dirty, true, 'dirty before save');
    assert.strictEqual(notes[0].content, 'old-b64', 'has cached content');

    // Save
    simulateSave(makeState({ notes }), 'a.md.gpg', 'saved content', cc, dc);

    // Re-map (like after pullChanges refreshes the listing)
    notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].dirty, false, 'clean after save + re-map');
    assert.strictEqual(notes[0].content, Buffer.from('saved content').toString('base64'), 'fresh content after save');
    assert.strictEqual(dc.has('a.md.gpg'), false, 'draft cleared');
  });

  it('full cycle: edit → navigate (draft saved) → return (draft loaded) → save → return (clean from cache)', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg')];
    const fakeContent = p => ({ content: Buffer.from('original').toString('base64'), sha: 'sha1' });

    // Step 1: load dir, fetch content
    let notes = mapEntries(entries, cc, dc);
    notes = simulateFetchAllNotesContent(notes, cc, fakeContent);
    let state = makeState({ notes, currentFile: notes[0] });

    // Step 2: edit (simulate computeDirtyState setting dirty)
    state = { ...state, isDirty: true, currentContent: 'edited' };

    // Step 3: navigate away (selectNote/navigateToDir saves draft)
    dc.set('a.md.gpg', 'edited');
    assert.strictEqual(dc.has('a.md.gpg'), true, 'draft saved on navigate away');

    // Step 4: navigate back (selectNote loads draft → dirty)
    // Simulate loadDraft path in selectNote
    const draft = dc.get('a.md.gpg');
    assert.strictEqual(draft, 'edited', 'draft loaded on return');
    // After loading draft, note is dirty
    state = { ...state, isDirty: true };

    // Step 5: edit more and save
    simulateSave(state, 'a.md.gpg', 'final saved', cc, dc);
    assert.strictEqual(dc.has('a.md.gpg'), false, 'draft cleared after save');

    // Step 6: navigate away and back (simulate selectNote with no draft)
    const returned = mapEntries(entries, cc, dc);
    assert.strictEqual(returned[0].dirty, false, 'note is clean');
    assert.strictEqual(
      returned[0].content,
      Buffer.from('final saved').toString('base64'),
      'note has final saved content from cache',
    );
    assert.strictEqual(dc.has('a.md.gpg'), false, 'no draft on return');
  });
});

describe('multiple notes — independent cache state', () => {
  it('saving one note does not affect another notes cached content', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg'), makeListingEntry('b.md.gpg')];
    const fakeContent = p => ({ content: Buffer.from(p + '-content').toString('base64'), sha: 's-' + p });

    let notes = mapEntries(entries, cc, dc);
    notes = simulateFetchAllNotesContent(notes, cc, fakeContent);
    let state = makeState({ notes });

    // Save only a
    state = simulateSave(state, 'a.md.gpg', 'only A changed', cc, dc);

    const bInState = state.notes.find(n => n.path === 'b.md.gpg');
    assert.strictEqual(
      bInState.content,
      Buffer.from('b.md.gpg-content').toString('base64'),
      'b content unchanged after saving a',
    );

    assert.strictEqual(cc.get('a.md.gpg'), Buffer.from('only A changed').toString('base64'), 'a contentCache updated');
    assert.strictEqual(
      cc.get('b.md.gpg'),
      Buffer.from('b.md.gpg-content').toString('base64'),
      'b contentCache unchanged',
    );
  });

  it('dirty flags for two notes are independent', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg'), makeListingEntry('b.md.gpg')];

    dc.set('a.md.gpg', 'draft for a');
    const notes = mapEntries(entries, cc, dc);

    assert.strictEqual(notes.find(n => n.path === 'a.md.gpg').dirty, true, 'a is dirty');
    assert.strictEqual(notes.find(n => n.path === 'b.md.gpg').dirty, false, 'b is clean');
  });
});

describe('formatNoteItem — offline dot + dirty badge integration', () => {
  it('shows offline dot when content is present in cached note', () => {
    const note = {
      name: 'n.md.gpg',
      path: 'n.md.gpg',
      dirty: false,
      content: 'b64',
      decrypted: null,
      originalText: '',
    };
    const html = formatNoteItem(note, '');
    assert.ok(html.includes('offline-dot'), 'offline dot present when content');
    assert.ok(!html.includes('unsaved'), 'no unsaved badge');
  });

  it('shows both offline dot and dirty badge when cached and edited', () => {
    const note = { name: 'n.md.gpg', path: 'n.md.gpg', dirty: true, content: 'b64', decrypted: null, originalText: '' };
    const html = formatNoteItem(note, '');
    assert.ok(html.includes('offline-dot'), 'offline dot present');
    assert.ok(html.includes('unsaved'), 'unsaved badge present');
  });

  it('shows dirty badge without offline dot when content is null', () => {
    const note = { name: 'n.md.gpg', path: 'n.md.gpg', dirty: true, content: null, decrypted: null, originalText: '' };
    const html = formatNoteItem(note, '');
    assert.ok(html.includes('unsaved'), 'unsaved badge present');
    assert.ok(!html.includes('offline-dot'), 'no offline dot without content');
  });

  it('shows neither badge when clean and uncached', () => {
    const note = { name: 'n.md.gpg', path: 'n.md.gpg', dirty: false, content: null, decrypted: null, originalText: '' };
    const html = formatNoteItem(note, '');
    assert.ok(!html.includes('unsaved'), 'no unsaved badge');
    assert.ok(!html.includes('offline-dot'), 'no offline dot');
  });
});

describe('edge cases — contentCache boundary', () => {
  it('handles empty contentCache gracefully in note mapping', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].content, null, 'null content when cache empty');
  });

  it('empty base64 string in contentCache is falsy via || fallback to null', () => {
    const cc = new Map();
    cc.set('a.md.gpg', '');
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].content, null, 'empty string coerces to null via || fallback');
  });

  it('contentCache with non-string value is passed through as-is', () => {
    const cc = new Map();
    cc.set('a.md.gpg', null);
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].content, null, 'null value becomes null (same as cache miss)');
  });

  it('listing entry with size=0 still maps with null content', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('empty.md.gpg', { size: 0 })];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].size, 0);
    assert.strictEqual(notes[0].content, null);
  });
});

describe('edge cases — draftCache boundary', () => {
  it('empty draftCache does not set dirty on any note', () => {
    const cc = new Map();
    const dc = new Map();
    const entries = [makeListingEntry('a.md.gpg'), makeListingEntry('b.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(
      notes.every(n => !n.dirty),
      true,
      'no dirty notes',
    );
  });

  it('draft with empty string still marks note as dirty', () => {
    const cc = new Map();
    const dc = new Map([['a.md.gpg', '']]);
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].dirty, true, 'empty string draft still marks dirty');
  });

  it('draftCache entries for non-existent listing entries are ignored', () => {
    const cc = new Map();
    const dc = new Map([['ghost.md.gpg', 'ghost draft']]);
    const entries = [makeListingEntry('a.md.gpg')];
    const notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes.length, 1, 'only a is in the listing');
    assert.strictEqual(notes[0].dirty, false, 'a is not dirty from unrelated draft');
  });
});

describe('end-to-end state invariants', () => {
  it('markNoteClean preserves existing note.content in the list when mapped back', () => {
    const note = {
      name: 'a.md.gpg',
      path: 'a.md.gpg',
      dirty: true,
      content: 'b64content',
      sha: 'sha',
      size: 10,
      date: '',
      decrypted: null,
      originalText: 'old',
    };
    const result = markNoteClean(note, [note], 'saved text');
    const savedNote = result.notes.find(n => n.path === 'a.md.gpg');
    assert.strictEqual(savedNote.content, 'b64content', 'markNoteClean preserves content');
    assert.strictEqual(savedNote.dirty, false, 'dirty cleared');
  });

  it('cleanNoteInList followed by mapEntries preserves cache state', () => {
    const cc = new Map();
    cc.set('a.md.gpg', 'b64');
    const dc = new Map();
    dc.set('a.md.gpg', 'draft');
    const entries = [makeListingEntry('a.md.gpg')];
    let notes = mapEntries(entries, cc, dc);
    assert.strictEqual(notes[0].dirty, true);

    // Simulate save: cleanNoteInList + draftCache.delete
    notes = cleanNoteInList(notes, 'a.md.gpg');
    dc.delete('a.md.gpg');

    // Re-map (like after pullChanges/navigateToDir)
    const remapped = mapEntries(entries, cc, dc);
    assert.strictEqual(remapped[0].dirty, false, 'clean after re-map');
    assert.strictEqual(remapped[0].content, 'b64', 'content from cache still present');
  });
});
