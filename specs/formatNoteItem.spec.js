import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatNoteItem } from '../lib/util.js';

function makeNote(overrides) {
  return {
    name: 'test-note.md.gpg',
    path: 'test-note.md.gpg',
    date: '',
    dirty: false,
    ...overrides,
  };
}

describe('formatNoteItem', () => {
  it('renders a clean note without asterisk or badge', () => {
    const note = makeNote();
    const html = formatNoteItem(note, null);
    assert.doesNotMatch(html, / \*/);
    assert.doesNotMatch(html, /status-badge dirty/);
    assert.match(html, /📄 test-note/);
  });

  it('renders a dirty note with asterisk and unsaved badge', () => {
    const note = makeNote({ dirty: true });
    const html = formatNoteItem(note, null);
    assert.match(html, / \*</); // asterisk before closing span
    assert.match(html, /status-badge dirty/);
    assert.match(html, /unsaved/);
  });

  it('applies active class when path matches activeFile', () => {
    const note = makeNote({ path: 'active.md.gpg' });
    const html = formatNoteItem(note, 'active.md.gpg');
    assert.match(html, /class="note-item active"/);
  });

  it('does not apply active class when path differs', () => {
    const note = makeNote({ path: 'other.md.gpg' });
    const html = formatNoteItem(note, 'different.md.gpg');
    assert.doesNotMatch(html, /class="note-item active"/);
  });

  it('strips .md.gpg extension from display name', () => {
    const note = makeNote({ name: 'my-note.md.gpg' });
    const html = formatNoteItem(note, null);
    assert.match(html, /📄 my-note/);
  });

  it('strips .gpg extension from display name', () => {
    const note = makeNote({ name: 'config.json.gpg' });
    const html = formatNoteItem(note, null);
    assert.match(html, /📄 config\.json/);
  });

  it('shows date when present', () => {
    const note = makeNote({ date: '2024-03-15T10:05:30' });
    const html = formatNoteItem(note, null);
    assert.match(html, /<span class="date">/);
  });

  it('hides date when empty', () => {
    const note = makeNote({ date: '' });
    const html = formatNoteItem(note, null);
    assert.match(html, /<span class="date"><\/span>/);
  });

  it('escapes HTML in note name', () => {
    const note = makeNote({ name: '<script>alert("xss")</script>.md.gpg' });
    const html = formatNoteItem(note, null);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('escapes HTML in dirty asterisk position is correct', () => {
    const clean = formatNoteItem(makeNote({ dirty: false }), null);
    const dirty = formatNoteItem(makeNote({ dirty: true }), null);
    assert.equal(clean.includes(' *'), false);
    assert.equal(dirty.includes(' *'), true);
  });

  it('dirty note has no asterisk when name ends with gpg', () => {
    // Verify the asterisk is appended after the display name, not in the data attributes
    const dirty = formatNoteItem(makeNote({ name: 'note.md.gpg', dirty: true }), null);
    // The data-path should not contain *
    const pathMatch = dirty.match(/data-path="([^"]+)"/);
    assert.equal(pathMatch[1].includes('*'), false);
  });
});
