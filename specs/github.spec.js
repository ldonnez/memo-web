import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { contentCache, draftCache } from '../lib/draft.js';

let gh,
  parseEntries,
  buildStatusText,
  verifyRepo,
  ghGetFile,
  ghListDir,
  ghPutFile,
  ghDeleteFile,
  fetchAllNotesContent,
  walkAllDirsAndPrefetch;

before(async () => {
  const mod = await import('../lib/github.js');
  gh = mod.gh;
  parseEntries = mod.parseEntries;
  buildStatusText = mod.buildStatusText;
  verifyRepo = mod.verifyRepo;
  ghGetFile = mod.ghGetFile;
  ghListDir = mod.ghListDir;
  ghPutFile = mod.ghPutFile;
  ghDeleteFile = mod.ghDeleteFile;
  fetchAllNotesContent = mod.fetchAllNotesContent;
  walkAllDirsAndPrefetch = mod.walkAllDirsAndPrefetch;
});

after(() => {
  delete globalThis.fetch;
});

const makeConfig = (overrides = {}) => ({
  ghToken: 'test-token',
  ghOwner: 'test-owner',
  ghRepo: 'test-repo',
  ghBranch: 'main',
  ...overrides,
});

function mockFetch(status, body, ok) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const opts = { status, ok: ok ?? (status >= 200 && status < 300) };
  if (status === 204) opts.status = 204;
  globalThis.fetch = async () => ({
    status,
    ok: opts.ok,
    json: async () => (typeof body === 'string' ? JSON.parse(bodyStr) : body),
    text: async () => bodyStr,
  });
}

describe('parseEntries', () => {
  it('separates dirs and files by extension', () => {
    const entries = [
      { type: 'dir', name: 'sub', path: 'sub' },
      { type: 'file', name: 'a.md.gpg', path: 'a.md.gpg', sha: 's1', size: 10, last_modified: '2024-01-01' },
      { type: 'file', name: 'b.txt', path: 'b.txt', sha: 's2', size: 5 },
    ];
    const { dirs, notes } = parseEntries(entries, '.md.gpg');
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0].name, 'sub');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].name, 'a.md.gpg');
  });

  it('sorts dirs and notes alphabetically', () => {
    const entries = [
      { type: 'file', name: 'z.md.gpg', path: 'z.md.gpg', sha: 's1', size: 1 },
      { type: 'file', name: 'a.md.gpg', path: 'a.md.gpg', sha: 's2', size: 2 },
      { type: 'dir', name: 'beta', path: 'beta' },
      { type: 'dir', name: 'alpha', path: 'alpha' },
    ];
    const { dirs, notes } = parseEntries(entries, '.md.gpg');
    assert.equal(dirs[0].name, 'alpha');
    assert.equal(dirs[1].name, 'beta');
    assert.equal(notes[0].name, 'a.md.gpg');
    assert.equal(notes[1].name, 'z.md.gpg');
  });

  it('sets dirty=true when draft exists', () => {
    draftCache.set('drafty.md.gpg', 'draft content');
    const entries = [
      { type: 'file', name: 'drafty.md.gpg', path: 'drafty.md.gpg', sha: 's1', size: 1 },
      { type: 'file', name: 'clean.md.gpg', path: 'clean.md.gpg', sha: 's2', size: 2 },
    ];
    const { notes } = parseEntries(entries, '.md.gpg');
    assert.equal(notes.find(n => n.name === 'drafty.md.gpg').dirty, true);
    assert.equal(notes.find(n => n.name === 'clean.md.gpg').dirty, false);
    draftCache.clear();
  });

  it('skips files that do not match the extension', () => {
    const entries = [
      { type: 'file', name: 'a.md.gpg', path: 'a.md.gpg', sha: 's1', size: 1 },
      { type: 'file', name: 'notes.json', path: 'notes.json', sha: 's2', size: 2 },
    ];
    const { notes } = parseEntries(entries, '.md.gpg');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].name, 'a.md.gpg');
  });

  it('returns empty arrays for empty input', () => {
    const { dirs, notes } = parseEntries([], '.md.gpg');
    assert.deepEqual(dirs, []);
    assert.deepEqual(notes, []);
  });
});

describe('buildStatusText', () => {
  it('formats with notes and folders', () => {
    assert.equal(buildStatusText(5, 2), '5 notes · 2 folders');
  });

  it('omits folder count when zero', () => {
    assert.equal(buildStatusText(3, 0), '3 notes');
  });

  it('handles single note no folders', () => {
    assert.equal(buildStatusText(1, 0), '1 notes');
  });
});

describe('gh (raw API)', () => {
  it('sends GET request with auth headers and returns JSON', async () => {
    mockFetch(200, { id: 1, name: 'test' });
    const result = await gh(makeConfig(), 'GET', '/repos/o/r');
    assert.equal(result.id, 1);
    assert.equal(result.name, 'test');
  });

  it('sends POST with body as JSON', async () => {
    let sentBody = null;
    globalThis.fetch = async (url, opts) => {
      sentBody = opts.body;
      return { status: 201, ok: true, json: async () => ({ id: 1 }), text: async () => '{"id":1}' };
    };
    await gh(makeConfig(), 'POST', '/repos/o/r/issues', { title: 'bug' });
    assert.equal(JSON.parse(sentBody).title, 'bug');
  });

  it('throws on non-ok response with API error message', async () => {
    mockFetch(422, { message: 'Validation failed' }, false);
    await assert.rejects(() => gh(makeConfig(), 'GET', '/repos/o/r'), { message: /Validation failed/ });
  });

  it('throws with status code when no error message', async () => {
    mockFetch(500, {}, false);
    await assert.rejects(() => gh(makeConfig(), 'GET', '/repos/o/r'), { message: /GitHub API error 500/ });
  });

  it('returns null on 204', async () => {
    globalThis.fetch = async () => ({ status: 204, ok: true, json: async () => {}, text: async () => '' });
    const result = await gh(makeConfig(), 'DELETE', '/repos/o/r/contents/p');
    assert.equal(result, null);
  });
});

describe('verifyRepo', () => {
  it('returns repo data on success', async () => {
    mockFetch(200, { full_name: 'o/r', default_branch: 'main' });
    const data = await verifyRepo(makeConfig());
    assert.equal(data.full_name, 'o/r');
  });

  it('throws when repo is 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false);
    await assert.rejects(() => verifyRepo(makeConfig()), { message: /not found or no access/ });
  });

  it('throws on network error with offline hint', async () => {
    globalThis.fetch = async () => {
      throw new Error('Failed to fetch');
    };
    await assert.rejects(() => verifyRepo(makeConfig()), { message: /Cannot reach GitHub API/ });
  });

  it('re-throws other errors unchanged', async () => {
    globalThis.fetch = async () => {
      throw new Error('Something unexpected');
    };
    await assert.rejects(() => verifyRepo(makeConfig()), { message: /Something unexpected/ });
  });
});

describe('ghGetFile', () => {
  it('returns file data on success', async () => {
    mockFetch(200, { name: 'note.md.gpg', content: 'base64data' });
    const data = await ghGetFile(makeConfig(), 'notes/test.md.gpg');
    assert.equal(data.name, 'note.md.gpg');
    assert.equal(data.content, 'base64data');
  });

  it('returns null on 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false);
    const data = await ghGetFile(makeConfig(), 'nonexistent.md.gpg');
    assert.equal(data, null);
  });

  it('throws on other errors', async () => {
    mockFetch(500, { message: 'Internal Server Error' }, false);
    await assert.rejects(() => ghGetFile(makeConfig(), 'notes/test.md.gpg'));
  });
});

describe('ghListDir', () => {
  it('returns directory entries on success', async () => {
    const entries = [{ type: 'file', name: 'a.md.gpg' }];
    mockFetch(200, entries);
    const data = await ghListDir(makeConfig(), 'notes');
    assert.equal(data.length, 1);
    assert.equal(data[0].name, 'a.md.gpg');
  });

  it('returns empty array on 404', async () => {
    mockFetch(404, { message: 'Not Found' }, false);
    const data = await ghListDir(makeConfig(), 'missing');
    assert.deepEqual(data, []);
  });

  it('throws on other errors', async () => {
    mockFetch(500, {}, false);
    await assert.rejects(() => ghListDir(makeConfig(), 'notes'));
  });
});

describe('ghPutFile', () => {
  it('sends PUT with content and message', async () => {
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = { url, method: opts.method, body: JSON.parse(opts.body) };
      return { status: 201, ok: true, json: async () => ({ content: { sha: 'newsha' } }), text: async () => '{}' };
    };
    const result = await ghPutFile(makeConfig(), 'notes/test.md.gpg', 'hello', 'my message', 'oldsha');
    assert.equal(captured.method, 'PUT');
    assert(captured.url.includes(encodeURIComponent('notes/test.md.gpg')));
    assert.equal(captured.body.message, 'my message');
    assert.equal(captured.body.sha, 'oldsha');
    assert.equal(captured.body.branch, 'main');
    assert.equal(result.content.sha, 'newsha');
  });

  it('omits sha when not provided', async () => {
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.sha, undefined);
      return { status: 201, ok: true, json: async () => ({ content: { sha: 's1' } }), text: async () => '{}' };
    };
    await ghPutFile(makeConfig(), 'notes/new.md.gpg', 'content', 'create');
  });

  it('base64-encodes string content with btoa', async () => {
    let bodyStr = null;
    globalThis.fetch = async (url, opts) => {
      bodyStr = opts.body;
      return { status: 201, ok: true, json: async () => ({ content: { sha: 's1' } }), text: async () => '{}' };
    };
    await ghPutFile(makeConfig(), 'notes/test.md.gpg', 'hello', 'msg');
    assert.equal(JSON.parse(bodyStr).content, btoa('hello'));
  });
});

describe('ghDeleteFile', () => {
  it('sends DELETE with sha and branch', async () => {
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = { url, method: opts.method, body: JSON.parse(opts.body) };
      return { status: 200, ok: true, json: async () => ({}), text: async () => '{}' };
    };
    await ghDeleteFile(makeConfig(), 'notes/test.md.gpg', 'sha123', 'delete msg');
    assert.equal(captured.method, 'DELETE');
    assert(captured.url.includes(encodeURIComponent('notes/test.md.gpg')));
    assert.equal(captured.body.sha, 'sha123');
    assert.equal(captured.body.message, 'delete msg');
  });
});

describe('fetchAllNotesContent', () => {
  before(() => {
    contentCache.clear();
  });

  it('fetches content for notes without it', async () => {
    let callCount = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async url => {
      callCount++;
      const name = url.includes('note1') ? 'note1.md.gpg' : 'note2.md.gpg';
      return {
        status: 200,
        ok: true,
        json: async () => ({ name, content: `${name}-content`, sha: `${name}-sha` }),
        text: async () => '{}',
      };
    };
    const notes = [
      { name: 'note1.md.gpg', path: 'notes/note1.md.gpg', content: null },
      { name: 'note2.md.gpg', path: 'notes/note2.md.gpg', content: null },
    ];
    const updated = await fetchAllNotesContent(makeConfig(), notes);
    assert.equal(callCount, 2);
    assert.equal(updated[0].content, 'note1.md.gpg-content');
    assert.equal(updated[1].content, 'note2.md.gpg-content');
    assert.equal(contentCache.get('notes/note1.md.gpg'), 'note1.md.gpg-content');
    globalThis.fetch = orig;
  });

  it('skips notes that already have content', async () => {
    let callCount = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      callCount++;
      return { status: 200, ok: true, json: async () => ({}), text: async () => '{}' };
    };
    const notes = [{ name: 'cached.md.gpg', path: 'notes/cached.md.gpg', content: 'existing-content' }];
    const updated = await fetchAllNotesContent(makeConfig(), notes);
    assert.equal(callCount, 0);
    assert.equal(updated[0].content, 'existing-content');
    globalThis.fetch = orig;
  });

  it('handles fetch failure gracefully', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network error');
    };
    const notes = [{ name: 'failing.md.gpg', path: 'notes/failing.md.gpg', content: null }];
    const updated = await fetchAllNotesContent(makeConfig(), notes);
    assert.equal(updated[0].content, null);
    globalThis.fetch = orig;
  });
});

describe('walkAllDirsAndPrefetch', () => {
  before(() => {
    contentCache.clear();
    draftCache.clear();
  });

  it('walks a single directory and caches notes', async () => {
    let requestIndex = 0;
    const responses = [
      [{ type: 'file', name: 'a.md.gpg', path: 'notes/a.md.gpg', sha: 's1', size: 5 }],
      { name: 'a.md.gpg', content: 'a-content', sha: 's1' },
    ];
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      const resp = responses[requestIndex++];
      if (Array.isArray(resp)) {
        return { status: 200, ok: true, json: async () => resp, text: async () => JSON.stringify(resp) };
      }
      return { status: 200, ok: true, json: async () => resp, text: async () => JSON.stringify(resp) };
    };
    await walkAllDirsAndPrefetch(makeConfig(), 'notes', '.md.gpg');
    assert.equal(contentCache.get('notes/a.md.gpg'), 'a-content');
    globalThis.fetch = orig;
  });

  it('handles directory listing failure gracefully', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network error');
    };
    let err;
    try {
      await walkAllDirsAndPrefetch(makeConfig(), 'bad-dir', '.md.gpg');
    } catch (e) {
      err = e;
    }
    assert.equal(err, undefined);
    globalThis.fetch = orig;
  });
});
