import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { makeNote as makeNoteHelper } from './helpers.ts'
import type { Note } from '../lib/types.ts'

// ── helpers ──────────────────────────────────────────────────────────
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))
  return { promise, resolve }
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return makeNoteHelper({
    name: 'test.md.gpg',
    path: 'test.md.gpg',
    content: null,
    sha: 'sha1',
    dirty: false,
    ...overrides,
  })
}

interface CurrentState {
  notes: Note[]
  currentFile: Note | { path: string } | null
  currentContent: string
  isDirty?: boolean
}

function makeState(notes: Note[], currentFile: Note | null = null): CurrentState {
  return { notes, currentFile, currentContent: '' }
}

// ── faithful simulation of selectNote (no DOM) ──────────────────────
// Mirrors app.js selectNote's core async flow and guard logic exactly.
// Uses a shared mutable state object, like the module-level `state` in app.js.
interface SelectDeps {
  fetchFile: (path: string) => Promise<{ content: string; sha: string }>
  decrypt: (content: string) => Promise<string>
}

async function selectNote(shared: { current: CurrentState }, path: string, deps: SelectDeps): Promise<void> {
  let note = shared.current.notes.find(n => n.path === path)
  if (!note) return

  // setUrlParams + renderNoteList omitted — not relevant to the race guard
  shared.current = { ...shared.current, currentFile: note, isDirty: false }

  if (!note.content) {
    const data = await deps.fetchFile(note.path)
    if (!data) throw new Error('File not found')
    if (shared.current.currentFile?.path !== note.path) return
    note = { ...note, content: data.content, sha: data.sha }
    shared.current = {
      ...shared.current,
      notes: shared.current.notes.map(n => (n.path === note!.path ? note! : n)),
      currentFile: note,
    }
  }

  const decrypted = await deps.decrypt(note.content!)
  if (shared.current.currentFile?.path !== note.path) return
  shared.current = {
    ...shared.current,
    currentFile: { ...note, decrypted },
    currentContent: decrypted,
  }
}

// ── tests ────────────────────────────────────────────────────────────
describe('selectNote — race condition guard', () => {
  it('applies the result when no other note is selected during async ops', async () => {
    const noteA = makeNote({ path: 'a.md.gpg' })
    const shared = { current: makeState([noteA]) }

    await selectNote(shared, 'a.md.gpg', {
      fetchFile: async () => ({ content: 'b64-a', sha: 'sha-a' }),
      decrypt: async () => 'hello from A',
    })

    assert.equal(shared.current.currentFile!.path, 'a.md.gpg')
    assert.equal(shared.current.currentContent, 'hello from A')
  })

  it('discards stale fetch result when user clicks another note', async () => {
    const noteA = makeNote({ path: 'a.md.gpg' })
    const noteB = makeNote({ path: 'b.md.gpg', content: 'b64-b' })
    const shared = { current: makeState([noteA, noteB]) }

    const fetchA = deferred<{ content: string; sha: string }>()
    const decryptA = deferred<string>()
    const decryptB = deferred<string>()

    // Start both concurrently
    const pA = selectNote(shared, 'a.md.gpg', {
      fetchFile: () => fetchA.promise,
      decrypt: () => decryptA.promise,
    })
    const pB = selectNote(shared, 'b.md.gpg', {
      fetchFile: async () => ({ content: 'b64-b', sha: 'sha-b' }),
      decrypt: () => decryptB.promise,
    })

    // Simulate user switching to B while A's fetch is in flight
    shared.current = { ...shared.current, currentFile: { path: 'b.md.gpg' } }

    // A's fetch resolves (stale)
    fetchA.resolve({ content: 'b64-a', sha: 'sha-a' })
    // A's decrypt resolves (stale)
    decryptA.resolve('stale content from A')

    // B's decrypt resolves
    decryptB.resolve('content from B')

    await Promise.all([pA, pB])

    assert.equal(shared.current.currentFile!.path, 'b.md.gpg')
    assert.equal(shared.current.currentContent, 'content from B')
  })

  it('discards stale decrypt result when user clicks another note', async () => {
    const noteA = makeNote({ path: 'a.md.gpg', content: 'b64-a' })
    const noteB = makeNote({ path: 'b.md.gpg', content: 'b64-b' })
    const shared = { current: makeState([noteA, noteB]) }

    const decryptA = deferred<string>()
    const decryptB = deferred<string>()

    // Both notes have content (no fetch needed), start decrypt concurrently
    const pA = selectNote(shared, 'a.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptA.promise,
    })
    const pB = selectNote(shared, 'b.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptB.promise,
    })

    // Simulate user switching to B while decrypts are in flight
    shared.current = { ...shared.current, currentFile: { path: 'b.md.gpg' } }

    // A's decrypt resolves (stale)
    decryptA.resolve('stale from A')
    // B's decrypt resolves
    decryptB.resolve('content from B')

    await Promise.all([pA, pB])

    assert.equal(shared.current.currentFile!.path, 'b.md.gpg')
    assert.equal(shared.current.currentContent, 'content from B')
  })

  it('three rapid clicks — only the last note wins', async () => {
    const noteA = makeNote({ path: 'a.md.gpg', content: 'b64-a' })
    const noteB = makeNote({ path: 'b.md.gpg', content: 'b64-b' })
    const noteC = makeNote({ path: 'c.md.gpg', content: 'b64-c' })
    const shared = { current: makeState([noteA, noteB, noteC]) }

    const decryptA = deferred<string>()
    const decryptB = deferred<string>()
    const decryptC = deferred<string>()

    // All three notes have cached content (no fetch)
    const pA = selectNote(shared, 'a.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptA.promise,
    })
    const pB = selectNote(shared, 'b.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptB.promise,
    })
    const pC = selectNote(shared, 'c.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptC.promise,
    })

    // Simulate rapid clicks: A → B → C
    shared.current = { ...shared.current, currentFile: { path: 'b.md.gpg' } }
    shared.current = { ...shared.current, currentFile: { path: 'c.md.gpg' } }

    // All decrypts resolve
    decryptA.resolve('from A')
    decryptB.resolve('from B')
    decryptC.resolve('from C')

    await Promise.all([pA, pB, pC])

    assert.equal(shared.current.currentFile!.path, 'c.md.gpg')
    assert.equal(shared.current.currentContent, 'from C')
  })

  it('does not mutate state when the guard fires (stale result discarded)', async () => {
    const noteA = makeNote({ path: 'a.md.gpg', content: 'b64-a' })
    const noteB = makeNote({ path: 'b.md.gpg', content: 'b64-b' })
    const shared = { current: makeState([noteA, noteB]) }

    const decryptA = deferred<string>()
    const decryptB = deferred<string>()

    const pA = selectNote(shared, 'a.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptA.promise,
    })
    const pB = selectNote(shared, 'b.md.gpg', {
      fetchFile: async () => {
        throw new Error('fetch should not be called')
      },
      decrypt: () => decryptB.promise,
    })

    // Switch to B
    shared.current = { ...shared.current, currentFile: { path: 'b.md.gpg' } }

    // B resolves first — applies cleanly
    decryptB.resolve('content from B')
    await pB
    assert.equal(shared.current.currentContent, 'content from B')

    // A resolves second (stale) — should NOT overwrite
    decryptA.resolve('STALE from A')
    await pA
    assert.equal(shared.current.currentFile!.path, 'b.md.gpg')
    assert.equal(shared.current.currentContent, 'content from B')
  })
})
