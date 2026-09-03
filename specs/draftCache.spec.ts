import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { formatNoteItem, computeDirtyState, cleanNoteInList } from '../lib/util.ts'
import { makeNote as makeNoteHelper } from './helpers.ts'
import type { GhFileEntry, Note } from '../lib/types.ts'

function mapEntry(item: GhFileEntry, contentCache: Map<string, string>, draftCache: Map<string, string>): Note {
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
  }
}

interface LoadState {
  notes: Note[]
  currentContent: string
  originalContent: string
  isDirty: boolean
}

function applyDraftLoad(state: LoadState, notePath: string, draft: string | undefined): LoadState {
  return {
    ...state,
    notes: state.notes.map(n => (n.path === notePath ? { ...n, dirty: true } : n)),
    currentContent: draft as string,
    originalContent: draft as string,
    isDirty: true,
  }
}

describe('draft cache — note mapping', () => {
  it('sets dirty=true when a draft exists', () => {
    const item: GhFileEntry = { name: 'test.md.gpg', path: 'test.md.gpg', sha: 's', size: 0, type: 'file' }
    const cc = new Map<string, string>()
    const dc = new Map<string, string>([['test.md.gpg', 'unsaved content']])
    const note = mapEntry(item, cc, dc)
    assert.strictEqual(note.dirty, true)
  })

  it('sets dirty=false when no draft exists', () => {
    const item: GhFileEntry = { name: 'test.md.gpg', path: 'test.md.gpg', sha: 's', size: 0, type: 'file' }
    const cc = new Map<string, string>([['test.md.gpg', 'cached']])
    const dc = new Map<string, string>()
    const note = mapEntry(item, cc, dc)
    assert.strictEqual(note.dirty, false)
  })

  it('sets content from contentCache', () => {
    const item: GhFileEntry = { name: 'test.md.gpg', path: 'test.md.gpg', sha: 's', size: 0, type: 'file' }
    const cc = new Map<string, string>([['test.md.gpg', 'cached content']])
    const dc = new Map<string, string>()
    const note = mapEntry(item, cc, dc)
    assert.strictEqual(note.content, 'cached content')
  })

  it('both draft and content cache can be set independently', () => {
    const item: GhFileEntry = { name: 'test.md.gpg', path: 'test.md.gpg', sha: 's', size: 0, type: 'file' }
    const cc = new Map<string, string>([['test.md.gpg', 'remote content']])
    const dc = new Map<string, string>([['test.md.gpg', 'draft content']])
    const note = mapEntry(item, cc, dc)
    assert.strictEqual(note.dirty, true)
    assert.strictEqual(note.content, 'remote content')
  })

  it('returns content: null when neither cache has the path', () => {
    const item: GhFileEntry = { name: 'test.md.gpg', path: 'test.md.gpg', sha: 's', size: 0, type: 'file' }
    const cc = new Map<string, string>()
    const dc = new Map<string, string>()
    const note = mapEntry(item, cc, dc)
    assert.strictEqual(note.dirty, false)
    assert.strictEqual(note.content, null)
  })
})

describe('draft cache — formatNoteItem integration', () => {
  it('shows asterisk when dirty from draft', () => {
    const note = makeNoteHelper({ name: 'test.md.gpg', path: 'test.md.gpg', dirty: true, content: 'abc' })
    const html = formatNoteItem(note, '')
    assert.ok(html.includes('*'))
    assert.ok(html.includes('offline-dot'))
  })

  it('shows only offline dot when content but no draft', () => {
    const note = makeNoteHelper({ name: 'test.md.gpg', path: 'test.md.gpg', dirty: false, content: 'abc' })
    const html = formatNoteItem(note, '')
    assert.ok(!html.includes('*'))
    assert.ok(html.includes('offline-dot'))
  })

  it('shows nothing when clean and uncached', () => {
    const note = makeNoteHelper({ name: 'test.md.gpg', path: 'test.md.gpg', dirty: false, content: null })
    const html = formatNoteItem(note, '')
    assert.ok(!html.includes('*'))
    assert.ok(!html.includes('offline-dot'))
  })
})

describe('draft cache — state transitions', () => {
  it('draft save preserves dirty flag on the note', () => {
    const notes: Note[] = [
      makeNoteHelper({ name: 'a.md.gpg', path: 'a.md.gpg', dirty: false, content: 'enc', originalText: '' }),
    ]
    const currentFile = notes[0]
    const draftCache = new Map<string, string>()

    // Simulate: user edits → dirty
    const result = computeDirtyState(notes, currentFile!, 'edited content', 'original content')
    const editedNotes = result.notes
    assert.strictEqual(editedNotes.find(n => n.path === 'a.md.gpg')!.dirty, true, 'note is dirty after editing')

    // Simulate: save draft (like selectNote does when navigating away)
    draftCache.set('a.md.gpg', 'edited content')
    // After saving draft, the dirty flag stays true (selectNote no longer calls cleanNoteInList)
    assert.strictEqual(
      editedNotes.find(n => n.path === 'a.md.gpg')!.dirty,
      true,
      'dirty flag persists after saving draft',
    )

    // Simulate: later, selectNote loads the draft
    const state: LoadState = {
      notes: editedNotes,
      currentContent: '',
      originalContent: '',
      isDirty: false,
    }
    const loaded = applyDraftLoad(state, 'a.md.gpg', draftCache.get('a.md.gpg'))
    assert.strictEqual(loaded.notes.find(n => n.path === 'a.md.gpg')!.dirty, true, 'note is dirty after draft load')
    assert.strictEqual(loaded.isDirty, true, 'state.isDirty is true after draft load')
    assert.strictEqual(loaded.originalContent, 'edited content', 'originalContent is the draft text')
  })

  it('draft load keeps dirty flag even when content matches original', () => {
    // This tests the scenario where setContent(draft) fires onEditorInput
    // which calls computeDirtyState with originalContent=draft.
    // The draft load code must override that and keep dirty=true.
    const notes: Note[] = [
      makeNoteHelper({ name: 'a.md.gpg', path: 'a.md.gpg', dirty: false, content: 'enc', originalText: '' }),
    ]
    const draft = 'unsaved text'

    // onEditorInput would call computeDirtyState:
    const result = computeDirtyState(notes, notes[0]!, draft, draft)
    // This returns isDirty=false (content matches original)
    assert.strictEqual(result.isDirty, false, 'computeDirtyState returns clean when content matches original')
    assert.strictEqual(
      result.notes.find(n => n.path === 'a.md.gpg')!.dirty,
      false,
      'note is clean after matching computeDirtyState',
    )

    // But applyDraftLoad must override it:
    const state: LoadState = { notes: result.notes, currentContent: draft, originalContent: draft, isDirty: false }
    const loaded = applyDraftLoad(state, 'a.md.gpg', draft)
    assert.strictEqual(loaded.notes.find(n => n.path === 'a.md.gpg')!.dirty, true, 'draft load overrides dirty to true')
    assert.strictEqual(loaded.isDirty, true, 'draft load overrides isDirty to true')
  })

  it('cleanNoteInList clears dirty flag (used by discard/save)', () => {
    const notes: Note[] = [
      makeNoteHelper({ name: 'a.md.gpg', path: 'a.md.gpg', dirty: true, content: 'enc', originalText: '' }),
    ]
    const cleaned = cleanNoteInList(notes, 'a.md.gpg')
    assert.strictEqual(cleaned.find(n => n.path === 'a.md.gpg')!.dirty, false, 'cleanNoteInList clears dirty')
  })
})
