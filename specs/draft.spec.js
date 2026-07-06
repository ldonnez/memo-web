import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { contentCache, draftCache, persistDrafts, restoreDrafts, saveDraft, removeDraft } from '../lib/draft.js';

describe('contentCache', () => {
  before(() => contentCache.clear());
  after(() => contentCache.clear());

  it('starts empty', () => {
    assert.equal(contentCache.size, 0);
  });

  it('stores and retrieves values', () => {
    contentCache.set('notes/test.md.gpg', 'base64content');
    assert.equal(contentCache.get('notes/test.md.gpg'), 'base64content');
    assert.equal(contentCache.size, 1);
  });

  it('overwrites existing key', () => {
    contentCache.set('notes/test.md.gpg', 'updated');
    assert.equal(contentCache.get('notes/test.md.gpg'), 'updated');
  });

  it('deletes a key', () => {
    contentCache.delete('notes/test.md.gpg');
    assert.equal(contentCache.get('notes/test.md.gpg'), undefined);
    assert.equal(contentCache.size, 0);
  });
});

describe('draftCache', () => {
  before(() => draftCache.clear());
  after(() => draftCache.clear());

  it('starts empty', () => {
    assert.equal(draftCache.size, 0);
  });

  it('stores and retrieves drafts', () => {
    draftCache.set('notes/a.md.gpg', '# Draft text');
    assert.equal(draftCache.get('notes/a.md.gpg'), '# Draft text');
  });

  it('checks existence with has()', () => {
    assert.equal(draftCache.has('notes/a.md.gpg'), true);
    assert.equal(draftCache.has('notes/missing.md.gpg'), false);
  });

  it('removes a draft', () => {
    draftCache.delete('notes/a.md.gpg');
    assert.equal(draftCache.has('notes/a.md.gpg'), false);
  });
});

describe('saveDraft / removeDraft', () => {
  before(() => draftCache.clear());
  after(() => draftCache.clear());

  it('saveDraft adds to cache', () => {
    saveDraft('notes/drafty.md.gpg', 'draft content');
    assert.equal(draftCache.get('notes/drafty.md.gpg'), 'draft content');
  });

  it('removeDraft deletes from cache', () => {
    removeDraft('notes/drafty.md.gpg');
    assert.equal(draftCache.has('notes/drafty.md.gpg'), false);
  });

  it('saveDraft updates existing draft', () => {
    saveDraft('notes/existing.md.gpg', 'v1');
    saveDraft('notes/existing.md.gpg', 'v2');
    assert.equal(draftCache.get('notes/existing.md.gpg'), 'v2');
    removeDraft('notes/existing.md.gpg');
  });
});

describe('persistDrafts / restoreDrafts', () => {
  let ls;

  before(() => {
    ls = {};
    globalThis.localStorage = {
      getItem: k => ls[k] ?? null,
      setItem: (k, v) => {
        ls[k] = v;
      },
      removeItem: k => {
        delete ls[k];
      },
    };
  });

  beforeEach(() => {
    ls = {};
    draftCache.clear();
  });

  after(() => {
    draftCache.clear();
  });

  it('persists drafts to localStorage and restores them', () => {
    saveDraft('notes/a.md.gpg', '# Note A');
    saveDraft('notes/b.md.gpg', '# Note B');

    persistDrafts();
    const raw = localStorage.getItem('memoweb_drafts');
    const parsed = JSON.parse(raw);
    assert.equal(parsed['notes/a.md.gpg'], '# Note A');
    assert.equal(parsed['notes/b.md.gpg'], '# Note B');
  });

  it('restoreDrafts hydrates the draft cache', () => {
    const data = { 'notes/x.md.gpg': '# X', 'notes/y.md.gpg': '# Y' };
    localStorage.setItem('memoweb_drafts', JSON.stringify(data));

    restoreDrafts();
    assert.equal(draftCache.get('notes/x.md.gpg'), '# X');
    assert.equal(draftCache.get('notes/y.md.gpg'), '# Y');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('memoweb_drafts', 'not-json{{{');
    restoreDrafts();
    assert.equal(draftCache.size, 0);
  });

  it('handles missing localStorage gracefully', () => {
    const saved = globalThis.localStorage;
    delete globalThis.localStorage;
    restoreDrafts();
    assert.equal(draftCache.size, 0);
    globalThis.localStorage = saved;
  });
});
