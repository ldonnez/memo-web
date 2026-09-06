import { describe, it, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { contentCache, draftCache } from '../lib/draft.ts'
import { makeNote } from './helpers.ts'
import type { Config, Note, GhFileData, GhFileEntry } from '../lib/types.ts'
import type { EntriesResult } from '../lib/github.ts'

let gh: (config: Config, method: string, path: string, body?: unknown) => Promise<unknown>
let parseEntries: (
  entries: Array<{
    type?: string
    name?: string
    path?: string
    sha?: string
    size?: number
    last_modified?: string | null
  }>,
  ext: string,
) => EntriesResult
let buildStatusText: (total: number, dirCount: number) => string
let verifyRepo: (config: Config) => Promise<{ full_name: string; name: string; default_branch: string }>
let ghGetFile: (config: Config, path: string) => Promise<GhFileData | null>
let ghListDir: (config: Config, path: string) => Promise<GhFileEntry[] | []>
let ghPutFile: (
  config: Config,
  path: string,
  content: string | Uint8Array,
  message: string,
  sha?: string | null,
) => Promise<{ content: { sha: string } }>
let ghDeleteFile: (config: Config, path: string, sha: string, message?: string) => Promise<unknown>
let fetchAllNotesContent: (config: Config, notes: Note[]) => Promise<Note[]>
let walkAllDirsAndPrefetch: (
  config: Config,
  rootPath: string,
  fileExt: string,
) => Promise<{
  totalNotes: number
  totalDirs: number
}>

before(async () => {
  const mod = await import('../lib/github.ts')
  gh = mod.gh
  parseEntries = mod.parseEntries
  buildStatusText = mod.buildStatusText
  verifyRepo = mod.verifyRepo
  ghGetFile = mod.ghGetFile
  ghListDir = mod.ghListDir
  ghPutFile = mod.ghPutFile
  ghDeleteFile = mod.ghDeleteFile
  fetchAllNotesContent = mod.fetchAllNotesContent
  walkAllDirsAndPrefetch = mod.walkAllDirsAndPrefetch
})

after(() => {
  ;(globalThis as Record<string, unknown>)['fetch'] = undefined
})

const makeConfig = (overrides?: Record<string, unknown>): Config => ({
  ghToken: 'test-token',
  ghOwner: 'test-owner',
  ghRepo: 'test-repo',
  ghBranch: 'main',
  ...overrides,
})

function mockFetch(status: number, body: unknown, ok?: boolean) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  const mockOk = ok ?? (status >= 200 && status < 300)
  ;(globalThis as any).fetch = async () => ({
    status,
    ok: mockOk,
    json: async () => (typeof body === 'string' ? JSON.parse(bodyStr) : body),
    text: async () => bodyStr,
  })
}

describe('parseEntries', () => {
  it('separates dirs and files by extension', () => {
    const entries = [
      { type: 'dir', name: 'sub', path: 'sub' },
      { type: 'file', name: 'a.md.gpg', path: 'a.md.gpg', sha: 's1', size: 10, last_modified: '2024-01-01' },
      { type: 'file', name: 'b.txt', path: 'b.txt', sha: 's2', size: 5 },
    ]
    const { dirs, notes } = parseEntries(entries, '.md.gpg')
    assert.equal(dirs.length, 1)
    assert.equal(dirs[0]!.name, 'sub')
    assert.equal(notes.length, 1)
    assert.equal(notes[0]!.name, 'a.md.gpg')
  })

  it('sorts dirs and notes alphabetically', () => {
    const entries = [
      { type: 'file', name: 'z.md.gpg', path: 'z.md.gpg', sha: 's1', size: 1 },
      { type: 'file', name: 'a.md.gpg', path: 'a.md.gpg', sha: 's2', size: 2 },
      { type: 'dir', name: 'beta', path: 'beta' },
      { type: 'dir', name: 'alpha', path: 'alpha' },
    ]
    const { dirs, notes } = parseEntries(entries, '.md.gpg')
    assert.equal(dirs[0]!.name, 'alpha')
    assert.equal(dirs[1]!.name, 'beta')
    assert.equal(notes[0]!.name, 'a.md.gpg')
    assert.equal(notes[1]!.name, 'z.md.gpg')
  })

  it('sets dirty=true when draft exists', () => {
    draftCache.set('drafty.md.gpg', 'draft content')
    const entries = [
      { type: 'file', name: 'drafty.md.gpg', path: 'drafty.md.gpg', sha: 's1', size: 1 },
      { type: 'file', name: 'clean.md.gpg', path: 'clean.md.gpg', sha: 's2', size: 2 },
    ]
    const { notes } = parseEntries(entries, '.md.gpg')
    assert.equal(notes.find(n => n.name === 'drafty.md.gpg')!.dirty, true)
    assert.equal(notes.find(n => n.name === 'clean.md.gpg')!.dirty, false)
    draftCache.clear()
  })

  it('skips files that do not match the extension', () => {
    const entries = [
      { type: 'file', name: 'a.md.gpg', path: 'a.md.gpg', sha: 's1', size: 1 },
      { type: 'file', name: 'notes.json', path: 'notes.json', sha: 's2', size: 2 },
    ]
    const { notes } = parseEntries(entries, '.md.gpg')
    assert.equal(notes.length, 1)
    assert.equal(notes[0]!.name, 'a.md.gpg')
  })

  it('returns empty arrays for empty input', () => {
    const { dirs, notes } = parseEntries([], '.md.gpg')
    assert.deepEqual(dirs, [])
    assert.deepEqual(notes, [])
  })
})

describe('buildStatusText', () => {
  it('formats with notes and folders', () => {
    assert.equal(buildStatusText(5, 2), '5 notes · 2 folders')
  })

  it('omits folder count when zero', () => {
    assert.equal(buildStatusText(3, 0), '3 notes')
  })

  it('handles single note no folders', () => {
    assert.equal(buildStatusText(1, 0), '1 notes')
  })
})

function mockFetchTimeout() {
  ;(globalThis as any).fetch = (_url: unknown, opts: { signal?: AbortSignal }) =>
    new Promise((_, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(opts?.signal?.reason || new Error('Aborted')))
    })
}

describe('gh (raw API)', () => {
  it('sends GET request with auth headers and returns JSON', async () => {
    let sentOpts: { headers?: Record<string, string>; cache?: string } | null = null as {
      headers?: Record<string, string>
      cache?: string
    } | null
    ;(globalThis as any).fetch = async (_url: unknown, opts: { headers?: Record<string, string>; cache?: string }) => {
      sentOpts = opts
      return { status: 200, ok: true, json: async () => ({ id: 1, name: 'test' }), text: async () => '{}' }
    }
    const result = await gh(makeConfig(), 'GET', '/repos/o/r')
    assert.equal((result as Record<string, unknown>)['id'], 1)
    assert.equal((result as Record<string, unknown>)['name'], 'test')
    assert.equal(sentOpts?.cache, 'no-store', 'GitHub API requests must bypass the browser HTTP cache')
    assert.equal(sentOpts?.headers?.['Authorization'], 'Bearer test-token')
  })

  it('does not allow cached responses for other methods', async () => {
    let sentOpts: { cache?: string } | null = null as { cache?: string } | null
    ;(globalThis as any).fetch = async (_url: unknown, opts: { cache?: string }) => {
      sentOpts = opts
      return { status: 200, ok: true, json: async () => ({}), text: async () => '{}' }
    }
    await gh(makeConfig(), 'DELETE', '/repos/o/r/contents/p')
    assert.equal(sentOpts?.cache, 'no-store')
  })

  it('sends POST with body as JSON', async () => {
    let sentBody: string | null = null
    ;(globalThis as any).fetch = async (_url: unknown, opts: { body?: unknown }) => {
      sentBody = opts?.body as string
      return { status: 201, ok: true, json: async () => ({ id: 1 }), text: async () => '{"id":1}' }
    }
    await gh(makeConfig(), 'POST', '/repos/o/r/issues', { title: 'bug' })
    assert.equal(JSON.parse(sentBody!).title, 'bug')
  })

  it('throws on non-ok response with API error message', async () => {
    mockFetch(422, { message: 'Validation failed' }, false)
    await assert.rejects(() => gh(makeConfig(), 'GET', '/repos/o/r'), { message: /Validation failed/ })
  })

  it('throws with status code when no error message', async () => {
    mockFetch(500, {}, false)
    await assert.rejects(() => gh(makeConfig(), 'GET', '/repos/o/r'), { message: /GitHub API error 500/ })
  })

  it('returns null on 204', async () => {
    ;(globalThis as any).fetch = async () => ({
      status: 204,
      ok: true,
      json: async () => ({}),
      text: async () => '',
    })
    const result = await gh(makeConfig(), 'DELETE', '/repos/o/r/contents/p')
    assert.equal(result, null)
  })

  it('rejects with a timeout error when the request exceeds ghTimeoutMs', async () => {
    mockFetchTimeout()
    await assert.rejects(() => gh(makeConfig({ ghTimeoutMs: 30 }), 'GET', '/repos/o/r'), {
      message: /Request timed out/,
    })
  })
})

describe('verifyRepo', () => {
  it('returns repo data on success', async () => {
    mockFetch(200, { full_name: 'o/r', default_branch: 'main' })
    const data = await verifyRepo(makeConfig())
    assert.equal(data.full_name, 'o/r')
  })

  it('bypasses the browser HTTP cache so offline loads cannot fake a connection', async () => {
    let sentCache: string | null = null
    ;(globalThis as any).fetch = async (_url: unknown, opts: { cache?: string }) => {
      sentCache = opts?.cache ?? null
      return {
        status: 200,
        ok: true,
        json: async () => ({ full_name: 'o/r', default_branch: 'main' }),
        text: async () => '{}',
      }
    }
    await verifyRepo(makeConfig())
    assert.equal(sentCache, 'no-store')
  })

  it('throws when repo is 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false)
    await assert.rejects(() => verifyRepo(makeConfig()), { message: /not found or no access/ })
  })

  it('throws on network error with offline hint', async () => {
    ;(globalThis as any).fetch = async () => {
      throw new Error('Failed to fetch')
    }
    await assert.rejects(() => verifyRepo(makeConfig()), { message: /Cannot reach GitHub API/ })
  })

  it('re-throws other errors unchanged', async () => {
    ;(globalThis as any).fetch = async () => {
      throw new Error('Something unexpected')
    }
    await assert.rejects(() => verifyRepo(makeConfig()), { message: /Something unexpected/ })
  })

  it('rejects with a timeout error when the request exceeds ghTimeoutMs', async () => {
    mockFetchTimeout()
    await assert.rejects(() => verifyRepo(makeConfig({ ghTimeoutMs: 30 })), {
      message: /Request timed out/,
    })
  })
})

describe('ghGetFile', () => {
  it('returns file data on success', async () => {
    mockFetch(200, { name: 'note.md.gpg', content: 'base64data' })
    const data = (await ghGetFile(makeConfig(), 'notes/test.md.gpg')) as unknown as Record<string, unknown>
    assert.equal(data['name'], 'note.md.gpg')
    assert.equal(data['content'], 'base64data')
  })

  it('returns null on 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false)
    const data = await ghGetFile(makeConfig(), 'nonexistent.md.gpg')
    assert.equal(data, null)
  })

  it('throws on other errors', async () => {
    mockFetch(500, { message: 'Internal Server Error' }, false)
    await assert.rejects(() => ghGetFile(makeConfig(), 'notes/test.md.gpg'))
  })
})

describe('ghListDir', () => {
  it('returns directory entries on success', async () => {
    const entries = [{ type: 'file', name: 'a.md.gpg' }]
    mockFetch(200, entries)
    const data = await ghListDir(makeConfig(), 'notes')
    assert.equal(data.length, 1)
    assert.equal(data[0]!.name, 'a.md.gpg')
  })

  it('returns empty array on 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false)
    const data = await ghListDir(makeConfig(), 'missing')
    assert.deepEqual(data, [])
  })

  it('throws on other errors', async () => {
    mockFetch(500, {}, false)
    await assert.rejects(() => ghListDir(makeConfig(), 'notes'))
  })
})

describe('ghPutFile', () => {
  it('sends PUT with content and message', async () => {
    let captured: { url: string; method: string; body: Record<string, unknown> } | null = null
    ;(globalThis as any).fetch = async (url: string, opts: { method?: string; body?: string }) => {
      captured = { url, method: opts?.method as string, body: JSON.parse(opts?.body as string) }
      return { status: 201, ok: true, json: async () => ({ content: { sha: 'newsha' } }), text: async () => '{}' }
    }
    const result = await ghPutFile(makeConfig(), 'notes/test.md.gpg', 'hello', 'my message', 'oldsha')
    assert.equal(captured!.method, 'PUT')
    assert(captured!.url.includes(encodeURIComponent('notes/test.md.gpg')))
    assert.equal(captured!.body['message'], 'my message')
    assert.equal(captured!.body['sha'], 'oldsha')
    assert.equal(captured!.body['branch'], 'main')
    assert.equal(result.content.sha, 'newsha')
  })

  it('omits sha when not provided', async () => {
    ;(globalThis as any).fetch = async (_url: unknown, opts: { body?: string }) => {
      const body = JSON.parse(opts.body as string)
      assert.equal(body.sha, undefined)
      return { status: 201, ok: true, json: async () => ({ content: { sha: 's1' } }), text: async () => '{}' }
    }
    await ghPutFile(makeConfig(), 'notes/new.md.gpg', 'content', 'create')
  })

  it('base64-encodes string content with btoa', async () => {
    let bodyStr: string | null = null
    ;(globalThis as any).fetch = async (_url: unknown, opts: { body?: string }) => {
      bodyStr = opts.body as string
      return { status: 201, ok: true, json: async () => ({ content: { sha: 's1' } }), text: async () => '{}' }
    }
    await ghPutFile(makeConfig(), 'notes/test.md.gpg', 'hello', 'msg')
    assert.equal(JSON.parse(bodyStr!).content, btoa('hello'))
  })
})

describe('ghDeleteFile', () => {
  it('sends DELETE with sha and branch', async () => {
    let captured: { url: string; method: string; body: Record<string, unknown> } | null = null
    ;(globalThis as any).fetch = async (url: string, opts: { method?: string; body?: string }) => {
      captured = { url, method: opts?.method as string, body: JSON.parse(opts?.body as string) }
      return { status: 200, ok: true, json: async () => ({}), text: async () => '{}' }
    }
    await ghDeleteFile(makeConfig(), 'notes/test.md.gpg', 'sha123', 'delete msg')
    assert.equal(captured!.method, 'DELETE')
    assert(captured!.url.includes(encodeURIComponent('notes/test.md.gpg')))
    assert.equal(captured!.body['sha'], 'sha123')
    assert.equal(captured!.body['message'], 'delete msg')
  })
})

describe('fetchAllNotesContent', () => {
  before(() => {
    contentCache.clear()
  })

  it('fetches content for notes without it', async () => {
    let callCount = 0
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = async (url: string) => {
      callCount++
      const name = url.includes('note1') ? 'note1.md.gpg' : 'note2.md.gpg'
      return {
        status: 200,
        ok: true,
        json: async () => ({ name, content: `${name}-content`, sha: `${name}-sha` }),
        text: async () => '{}',
      }
    }
    const notes = [
      makeNote({ name: 'note1.md.gpg', path: 'notes/note1.md.gpg', content: null }),
      makeNote({ name: 'note2.md.gpg', path: 'notes/note2.md.gpg', content: null }),
    ]
    const updated = await fetchAllNotesContent(makeConfig(), notes)
    assert.equal(callCount, 2)
    assert.equal(updated[0]!.content, 'note1.md.gpg-content')
    assert.equal(updated[1]!.content, 'note2.md.gpg-content')
    assert.equal(contentCache.get('notes/note1.md.gpg'), 'note1.md.gpg-content')
    globalThis.fetch = orig
  })

  it('skips notes that already have content', async () => {
    let callCount = 0
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = async () => {
      callCount++
      return { status: 200, ok: true, json: async () => ({}), text: async () => '{}' }
    }
    const notes = [makeNote({ name: 'cached.md.gpg', path: 'notes/cached.md.gpg', content: 'existing-content' })]
    const updated = await fetchAllNotesContent(makeConfig(), notes)
    assert.equal(callCount, 0)
    assert.equal(updated[0]!.content, 'existing-content')
    globalThis.fetch = orig
  })

  it('handles fetch failure gracefully', async () => {
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = async () => {
      throw new Error('network error')
    }
    const notes = [makeNote({ name: 'failing.md.gpg', path: 'notes/failing.md.gpg', content: null })]
    const updated = await fetchAllNotesContent(makeConfig(), notes)
    assert.equal(updated[0]!.content, null)
    globalThis.fetch = orig
  })
})

describe('walkAllDirsAndPrefetch', () => {
  before(() => {
    contentCache.clear()
    draftCache.clear()
  })

  function mockContentEndpoint(listings: Record<string, Array<Record<string, unknown>>>) {
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = async (url: string) => {
      const pathPart = decodeURIComponent(url.split('/contents/')[1]?.split('?ref=')[0] || '')
      const listing = listings[pathPart]
      if (listing) {
        return { status: 200, ok: true, json: async () => listing, text: async () => JSON.stringify(listing) }
      }
      const fileName = pathPart.split('/').pop() || ''
      const data = { name: fileName, content: `${fileName}-content`, sha: 'c-sha' }
      return { status: 200, ok: true, json: async () => data, text: async () => JSON.stringify(data) }
    }
    return orig
  }

  it('walks a single directory and caches notes', async () => {
    let requestIndex = 0
    const responses: unknown[] = [
      [{ type: 'file', name: 'a.md.gpg', path: 'notes/a.md.gpg', sha: 's1', size: 5 }],
      { name: 'a.md.gpg', content: 'a-content', sha: 's1' },
    ]
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = async () => {
      const resp = responses[requestIndex++]
      if (Array.isArray(resp)) {
        return { status: 200, ok: true, json: async () => resp, text: async () => JSON.stringify(resp) }
      }
      return { status: 200, ok: true, json: async () => resp, text: async () => JSON.stringify(resp) }
    }
    const totals = await walkAllDirsAndPrefetch(makeConfig(), 'notes', '.md.gpg')
    assert.equal(contentCache.get('notes/a.md.gpg'), 'a-content')
    assert.deepEqual(totals, { totalNotes: 1, totalDirs: 0 })
    globalThis.fetch = orig
  })

  it('counts notes and subdirectories across the whole tree', async () => {
    const orig = mockContentEndpoint({
      '': [
        { type: 'dir', name: 'sub', path: 'sub', sha: 'd1' },
        { type: 'dir', name: 'empty', path: 'empty', sha: 'd2' },
        { type: 'file', name: 'root.md.gpg', path: 'root.md.gpg', sha: 's1', size: 2 },
      ],
      sub: [
        { type: 'file', name: 'a.md.gpg', path: 'sub/a.md.gpg', sha: 's2', size: 2 },
        { type: 'file', name: 'b.md.gpg', path: 'sub/b.md.gpg', sha: 's3', size: 2 },
      ],
      empty: [],
    })
    const totals = await walkAllDirsAndPrefetch(makeConfig(), '', '.md.gpg')
    assert.deepEqual(totals, { totalNotes: 3, totalDirs: 2 })
    assert.equal(contentCache.get('root.md.gpg'), 'root.md.gpg-content')
    assert.equal(contentCache.get('sub/a.md.gpg'), 'a.md.gpg-content')
    assert.equal(contentCache.get('sub/b.md.gpg'), 'b.md.gpg-content')
    globalThis.fetch = orig
  })

  it('counts from a non-root starting directory', async () => {
    const orig = mockContentEndpoint({
      sub: [
        { type: 'file', name: 'a.md.gpg', path: 'sub/a.md.gpg', sha: 's1', size: 2 },
        { type: 'file', name: 'b.md.gpg', path: 'sub/b.md.gpg', sha: 's2', size: 2 },
      ],
    })
    const totals = await walkAllDirsAndPrefetch(makeConfig(), 'sub', '.md.gpg')
    assert.deepEqual(totals, { totalNotes: 2, totalDirs: 0 })
    globalThis.fetch = orig
  })

  it('ignores files that do not match the extension when counting', async () => {
    const orig = mockContentEndpoint({
      '': [
        { type: 'file', name: 'real.md.gpg', path: 'real.md.gpg', sha: 's1', size: 2 },
        { type: 'file', name: 'readme.md', path: 'readme.md', sha: 's2', size: 2 },
        { type: 'file', name: 'data.json', path: 'data.json', sha: 's3', size: 2 },
      ],
    })
    const totals = await walkAllDirsAndPrefetch(makeConfig(), '', '.md.gpg')
    assert.deepEqual(totals, { totalNotes: 1, totalDirs: 0 })
    globalThis.fetch = orig
  })

  it('handles directory listing failure gracefully', async () => {
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = async () => {
      throw new Error('network error')
    }
    let err: unknown
    let totals: { totalNotes: number; totalDirs: number } | null = null
    try {
      totals = await walkAllDirsAndPrefetch(makeConfig(), 'bad-dir', '.md.gpg')
    } catch (e) {
      err = e
    }
    assert.equal(err, undefined)
    assert.deepEqual(totals, { totalNotes: 0, totalDirs: 0 })
    globalThis.fetch = orig
  })

  it('continues counting other directories when one listing fails', async () => {
    const orig = globalThis.fetch
    const listings: Record<string, Array<Record<string, unknown>>> = {
      '': [
        { type: 'dir', name: 'bad', path: 'bad', sha: 'd1' },
        { type: 'dir', name: 'ok', path: 'ok', sha: 'd2' },
        { type: 'file', name: 'root.md.gpg', path: 'root.md.gpg', sha: 's1', size: 2 },
      ],
      ok: [{ type: 'file', name: 'nested.md.gpg', path: 'ok/nested.md.gpg', sha: 's2', size: 2 }],
    }
    ;(globalThis as any).fetch = async (url: string) => {
      const pathPart = decodeURIComponent(url.split('/contents/')[1]?.split('?ref=')[0] || '')
      if (pathPart === 'bad') throw new Error('network error')
      const listing = listings[pathPart]
      if (listing) {
        return { status: 200, ok: true, json: async () => listing, text: async () => JSON.stringify(listing) }
      }
      const fileName = pathPart.split('/').pop() || ''
      const data = { name: fileName, content: `${fileName}-content`, sha: 'c-sha' }
      return { status: 200, ok: true, json: async () => data, text: async () => JSON.stringify(data) }
    }
    const totals = await walkAllDirsAndPrefetch(makeConfig(), '', '.md.gpg')
    assert.deepEqual(totals, { totalNotes: 2, totalDirs: 2 })
    assert.equal(contentCache.get('ok/nested.md.gpg'), 'nested.md.gpg-content')
    globalThis.fetch = orig
  })
})
