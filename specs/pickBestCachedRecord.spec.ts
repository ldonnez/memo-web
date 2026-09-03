import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { pickBestCachedRecord } from '../lib/util.ts'
import type { CachedRecord, Note } from '../lib/types.ts'

function makeRecord(path: string, notes: Note[], timestamp: number): CachedRecord {
  return { notes, dirs: [], currentBrowsePath: path, timestamp }
}

function makeNote(path: string): Note {
  return { name: path, path, sha: 'sha', size: 0, date: '', dirty: false, content: null }
}

describe('pickBestCachedRecord — offline fallback selection', () => {
  it('returns null when there are no records', () => {
    assert.equal(pickBestCachedRecord([]), null)
    assert.equal(pickBestCachedRecord(null), null)
    assert.equal(pickBestCachedRecord(undefined), null)
  })

  it('returns null when no record has notes', () => {
    const records = [makeRecord('a', [], 100), makeRecord('b', [], 200)]
    assert.equal(pickBestCachedRecord(records), null)
  })

  it('returns the only usable record', () => {
    const good = makeRecord('notes', [makeNote('n.md.gpg')], 100)
    assert.equal(pickBestCachedRecord([good]), good)
  })

  it('returns the most recently cached record among usable ones', () => {
    const old = makeRecord('old', [makeNote('o.md.gpg')], 100)
    const recent = makeRecord('new', [makeNote('n.md.gpg')], 300)
    const oldest = makeRecord('older', [makeNote('x.md.gpg')], 50)
    assert.equal(pickBestCachedRecord([old, recent, oldest]), recent)
  })

  it('skips records with no notes regardless of timestamp', () => {
    const emptyRecent = makeRecord('empty', [], 999)
    const usable = makeRecord('notes', [makeNote('n.md.gpg')], 10)
    assert.equal(pickBestCachedRecord([emptyRecent, usable]), usable)
  })

  it('skips null/empty entries and picks the best usable one', () => {
    const best = makeRecord('best', [makeNote('b.md.gpg')], 500)
    const result = pickBestCachedRecord([
      null,
      undefined as unknown as CachedRecord | null,
      makeRecord('e', [], 999),
      best,
      makeRecord('o', [makeNote('o.md.gpg')], 100),
    ])
    assert.equal(result, best)
  })

  it('treats missing timestamp as 0 (loses to any timestamped record)', () => {
    const noTs = { notes: [makeNote('n.md.gpg')], dirs: [], currentBrowsePath: 'no-ts' } as unknown as CachedRecord
    const withTs = makeRecord('ts', [makeNote('t.md.gpg')], 1)
    assert.equal(pickBestCachedRecord([noTs, withTs]), withTs)
    assert.equal(pickBestCachedRecord([noTs]), noTs)
  })

  it('is stable when timestamps are equal (keeps first)', () => {
    const a = makeRecord('a', [makeNote('a.md.gpg')], 100)
    const b = makeRecord('b', [makeNote('b.md.gpg')], 100)
    assert.equal(pickBestCachedRecord([a, b]), a)
  })
})
