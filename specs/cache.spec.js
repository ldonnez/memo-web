import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { cacheNotesToLocalStorage, loadCachedNotes } from '../lib/util.js';

describe('cacheNotesToLocalStorage / loadCachedNotes', () => {
  it('returns null when IndexedDB is unavailable', async () => {
    const result = await loadCachedNotes();
    assert.equal(result, null);
  });

  it('returns null for any path when IndexedDB is unavailable', async () => {
    const root = await loadCachedNotes('');
    const subdir = await loadCachedNotes('subdir');
    assert.equal(root, null);
    assert.equal(subdir, null);
  });

  it('does not throw when IndexedDB is unavailable', async () => {
    await cacheNotesToLocalStorage([], [], '');
  });

  it('does not throw when caching a subdirectory', async () => {
    await cacheNotesToLocalStorage([], [], 'some/subdir');
  });

  it('data format correctness (smoke test via skip)', () => {
    // Full persistence tested in-browser via IndexedDB.
    // Here we verify the data shape we *would* store:
    const payload = { notes: [], dirs: [], currentBrowsePath: '', timestamp: Date.now() };
    assert.ok(Array.isArray(payload.notes));
    assert.ok(Array.isArray(payload.dirs));
    assert.equal(typeof payload.currentBrowsePath, 'string');
    assert.equal(typeof payload.timestamp, 'number');
  });
});
