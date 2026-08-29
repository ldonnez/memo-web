import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickBestCachedRecord } from '../lib/util.js';

function makeRecord(path, notes, timestamp) {
  return { notes, dirs: [], currentBrowsePath: path, timestamp };
}

describe('pickBestCachedRecord — offline fallback selection', () => {
  it('returns null when there are no records', () => {
    assert.equal(pickBestCachedRecord([]), null);
    assert.equal(pickBestCachedRecord(null), null);
    assert.equal(pickBestCachedRecord(undefined), null);
  });

  it('returns null when no record has notes', () => {
    const records = [makeRecord('a', [], 100), makeRecord('b', [], 200)];
    assert.equal(pickBestCachedRecord(records), null);
  });

  it('returns the only usable record', () => {
    const good = makeRecord('notes', [{ path: 'n.md.gpg' }], 100);
    assert.equal(pickBestCachedRecord([good]), good);
  });

  it('returns the most recently cached record among usable ones', () => {
    const old = makeRecord('old', [{ path: 'o.md.gpg' }], 100);
    const recent = makeRecord('new', [{ path: 'n.md.gpg' }], 300);
    const oldest = makeRecord('older', [{ path: 'x.md.gpg' }], 50);
    assert.equal(pickBestCachedRecord([old, recent, oldest]), recent);
  });

  it('skips records with no notes regardless of timestamp', () => {
    const emptyRecent = makeRecord('empty', [], 999);
    const usable = makeRecord('notes', [{ path: 'n.md.gpg' }], 10);
    assert.equal(pickBestCachedRecord([emptyRecent, usable]), usable);
  });

  it('skips null/empty entries and picks the best usable one', () => {
    const best = makeRecord('best', [{ path: 'b.md.gpg' }], 500);
    const result = pickBestCachedRecord([
      null,
      undefined,
      makeRecord('e', [], 999),
      best,
      makeRecord('o', [{ path: 'o.md.gpg' }], 100),
    ]);
    assert.equal(result, best);
  });

  it('treats missing timestamp as 0 (loses to any timestamped record)', () => {
    const noTs = { notes: [{ path: 'n.md.gpg' }], dirs: [], currentBrowsePath: 'no-ts' };
    const withTs = makeRecord('ts', [{ path: 't.md.gpg' }], 1);
    assert.equal(pickBestCachedRecord([noTs, withTs]), withTs);
    assert.equal(pickBestCachedRecord([noTs]), noTs);
  });

  it('is stable when timestamps are equal (keeps first)', () => {
    const a = makeRecord('a', [{ path: 'a.md.gpg' }], 100);
    const b = makeRecord('b', [{ path: 'b.md.gpg' }], 100);
    assert.equal(pickBestCachedRecord([a, b]), a);
  });
});
