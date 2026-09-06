import { describe, it, before, beforeEach, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { saveLastNotePath, getLastNotePath, clearLastNotePath, getUrlParam } from '../lib/util.ts'

describe('last note persistence (saveLastNotePath / getLastNotePath / clearLastNotePath)', () => {
  let ls: Record<string, string>

  before(() => {
    ls = {}
    globalThis.localStorage = {
      getItem: (k: string) => ls[k] ?? null,
      setItem: (k: string, v: string) => {
        ls[k] = v
      },
      removeItem: (k: string) => {
        delete ls[k]
      },
    } as unknown as Storage
  })

  beforeEach(() => {
    ls = {}
  })

  after(() => {
    ls = {}
  })

  it('starts with no last note when nothing is saved', () => {
    assert.equal(getLastNotePath(), '')
  })

  it('persists the path when a note is opened (selectNote)', () => {
    saveLastNotePath('notes/welcome.md.gpg')
    assert.equal(localStorage.getItem('memoweb_lastNote'), 'notes/welcome.md.gpg')
    assert.equal(getLastNotePath(), 'notes/welcome.md.gpg')
  })

  it('survives app close / reopen (storage only, in-memory lost)', () => {
    saveLastNotePath('notes/hello.md.gpg')

    // Simulate closing the app — the in-memory copy (if any) is gone, storage persists.
    assert.equal(ls['memoweb_lastNote'], 'notes/hello.md.gpg')

    // Simulate reopening the app — the path is read back from storage.
    assert.equal(getLastNotePath(), 'notes/hello.md.gpg')
  })

  it('overwrites the previous note when a new note is opened', () => {
    saveLastNotePath('notes/first.md.gpg')
    saveLastNotePath('notes/second.md.gpg')
    assert.equal(getLastNotePath(), 'notes/second.md.gpg')
    assert.equal(ls['memoweb_lastNote'], 'notes/second.md.gpg')
  })

  it('is cleared when the editor is closed (closeEditor)', () => {
    saveLastNotePath('notes/open.md.gpg')
    clearLastNotePath()
    assert.equal(ls['memoweb_lastNote'], undefined)
    assert.equal(getLastNotePath(), '')
  })

  it('handles subdirectory and root-level paths', () => {
    saveLastNotePath('deeply/nested/dir/note.md.gpg')
    assert.equal(getLastNotePath(), 'deeply/nested/dir/note.md.gpg')

    saveLastNotePath('root-note.md.gpg')
    assert.equal(getLastNotePath(), 'root-note.md.gpg')
  })

  it('clearLastNotePath is a no-op when nothing is saved', () => {
    clearLastNotePath()
    assert.equal(ls['memoweb_lastNote'], undefined)
    assert.equal(getLastNotePath(), '')
  })
})

describe('init — last note resolution (URL param takes priority)', () => {
  let ls: Record<string, string>

  before(() => {
    ls = {}
    globalThis.localStorage = {
      getItem: (k: string) => ls[k] ?? null,
      setItem: (k: string, v: string) => {
        ls[k] = v
      },
      removeItem: (k: string) => {
        delete ls[k]
      },
    } as unknown as Storage
  })

  beforeEach(() => {
    ls = {}
  })

  after(() => {
    ls = {}
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  // Mirrors app.ts init(): const path = getUrlParam('path') || getLastNotePath()
  const resolvePath = (): string => getUrlParam('path') || getLastNotePath()

  function withSearch(search: string, fn: () => void) {
    const prevWindow = global.window
    global.window = { location: { search } } as unknown as Window & typeof globalThis
    try {
      fn()
    } finally {
      global.window = prevWindow
    }
  }

  it('opens the last visited note when no ?path= URL param is present', () => {
    saveLastNotePath('notes/last.md.gpg')
    withSearch('?owner=o&repo=r', () => {
      assert.equal(resolvePath(), 'notes/last.md.gpg')
    })
  })

  it('opens nothing when there is no URL param and no saved note', () => {
    withSearch('', () => {
      assert.equal(resolvePath(), '')
    })
  })

  it('gives priority to the ?path= URL param over the saved note (deep link)', () => {
    saveLastNotePath('notes/last.md.gpg')
    withSearch('?path=notes/deep-link.md.gpg', () => {
      assert.equal(resolvePath(), 'notes/deep-link.md.gpg')
    })
  })

  it('falls back to the saved note when ?path= is present but empty', () => {
    saveLastNotePath('notes/last.md.gpg')
    withSearch('?path=', () => {
      assert.equal(resolvePath(), 'notes/last.md.gpg')
    })
  })

  it('does not open a note after the editor was closed', () => {
    saveLastNotePath('notes/open.md.gpg')
    clearLastNotePath()
    withSearch('', () => {
      assert.equal(resolvePath(), '')
    })
  })
})

describe('last note helpers — robustness', () => {
  let ls: Record<string, string>

  before(() => {
    ls = { memoweb_lastNote: 'a-path' }
    globalThis.localStorage = {
      getItem: (k: string) => ls[k] ?? null,
      setItem: (k: string, v: string) => {
        ls[k] = v
      },
      removeItem: (k: string) => {
        delete ls[k]
      },
    } as unknown as Storage
  })

  after(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  it('reads a pre-existing stored value back', () => {
    assert.equal(getLastNotePath(), 'a-path')
  })

  it('handles missing localStorage gracefully', () => {
    const saved = globalThis.localStorage
    delete (globalThis as { localStorage?: Storage }).localStorage
    assert.equal(getLastNotePath(), '')
    saveLastNotePath('notes/x.md.gpg')
    clearLastNotePath()
    globalThis.localStorage = saved
  })

  it('handles throwing localStorage gracefully', () => {
    const saved = globalThis.localStorage
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage
    assert.equal(getLastNotePath(), '')
    saveLastNotePath('notes/x.md.gpg')
    clearLastNotePath()
    globalThis.localStorage = saved
  })
})
