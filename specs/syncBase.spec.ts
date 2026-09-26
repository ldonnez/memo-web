import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  baseOf,
  withBase,
  adoptBase,
  carryBases,
  mergeDirListing,
  localWorkingText,
  isModified,
  applyLocalStatus,
  planPull,
  decidePull,
  type FileBase,
} from '../lib/sync.ts'
import { markNoteClean, saveNoteClean, applyRemoteContent, revertNote } from '../lib/util.ts'
import { makeNote } from './helpers.ts'
import type { Note } from '../lib/types.ts'

// =====================================================================
// The merge-base model that replaced the `isDirty || hasDraft` boolean.
//
// Every pull decision is base / working / remote, exactly as git compares
// HEAD / working tree / origin. The tests below pin the truth tables, because
// the bug being fixed was a *silent* one: a note that had merely been opened
// looked locally modified (a draft is written on every navigation) and every
// remote change then demanded a ⚠️ button click instead of fast-forwarding.
// =====================================================================

const B = 'base text' // what we last know to be on the remote
const LOCAL = 'locally edited' // the user's unsaved work
const REMOTE = 'changed on another device' // what origin has now

const known: FileBase = { text: B, sha: 'sha-base' }
const unknown: FileBase = { text: null, sha: null }

// ============= BASE ACCESSORS =============

describe('baseOf', () => {
  it('reads the base off the note', () => {
    assert.deepEqual(baseOf(makeNote({ baseText: B, baseSha: 'sha-1' })), { text: B, sha: 'sha-1' })
  })

  it('is unknown for a note written before the base was tracked', () => {
    assert.deepEqual(baseOf(makeNote()), { text: null, sha: null })
  })

  it('is unknown for a missing note', () => {
    assert.deepEqual(baseOf(null), { text: null, sha: null })
    assert.deepEqual(baseOf(undefined), { text: null, sha: null })
  })

  it('normalizes absent fields to null rather than undefined', () => {
    const note = makeNote({ baseText: 'only text' })
    assert.deepEqual(baseOf(note), { text: 'only text', sha: null })
    assert.deepEqual(baseOf(makeNote({ baseSha: 'only sha' })), { text: null, sha: 'only sha' })
  })
})

describe('withBase / adoptBase', () => {
  it('withBase sets the base without touching anything else', () => {
    const note = makeNote({ content: 'b64', originalText: 'previous' })
    const next = withBase(note, B, 'sha-1')
    assert.equal(next.baseText, B)
    assert.equal(next.baseSha, 'sha-1')
    assert.equal(next.content, 'b64', 'payload untouched')
    assert.equal(next.originalText, 'previous', 'baseline untouched')
  })

  it('withBase can record an unknown base', () => {
    const next = withBase(makeNote({ baseText: B, baseSha: 'sha-1' }), null, null)
    assert.deepEqual(baseOf(next), { text: null, sha: null })
  })

  it('adoptBase also re-points the dirty-compare baseline at the base', () => {
    const next = adoptBase(makeNote({ originalText: 'stale baseline' }), B, 'sha-1')
    assert.equal(next.baseText, B)
    assert.equal(next.baseSha, 'sha-1')
    assert.equal(next.originalText, B, 'the editor must compare against the base, not a stale text')
  })

  it('adoptBase keeps an empty text as a real base (not "unknown")', () => {
    assert.deepEqual(baseOf(adoptBase(makeNote(), '', 'sha-empty')), { text: '', sha: 'sha-empty' })
  })
})

// ============= CARRYING THE BASE ACROSS A LISTING REFRESH =============

describe('carryBases', () => {
  const prev = [
    makeNote({ path: 'a.md.gpg', baseText: B, baseSha: 'sha-a' }),
    makeNote({ path: 'b.md.gpg' }), // cache from before the base existed
  ]
  // A fresh listing: new objects, fresh remote SHAs, no base of their own.
  const fresh = [
    makeNote({ path: 'a.md.gpg', sha: 'sha-a2' }),
    makeNote({ path: 'b.md.gpg', sha: 'sha-b' }),
    makeNote({ path: 'c.md.gpg', sha: 'sha-c' }), // created on the remote
  ]

  it('carries the base onto the matching path', () => {
    const carried = carryBases(fresh, prev)
    assert.deepEqual(baseOf(carried[0]!), { text: B, sha: 'sha-a' })
  })

  it('keeps the OLD base even though the remote SHA moved on — that is the merge base', () => {
    const carried = carryBases(fresh, prev)
    assert.equal(carried[0]!.sha, 'sha-a2', 'the listing SHA is adopted')
    assert.equal(carried[0]!.baseSha, 'sha-a', 'the base stays at the last synced SHA')
  })

  it('leaves a note with no previous base alone', () => {
    const carried = carryBases(fresh, prev)
    assert.deepEqual(baseOf(carried[1]!), { text: null, sha: null })
  })

  it('leaves a brand-new path alone', () => {
    const carried = carryBases(fresh, prev)
    assert.deepEqual(baseOf(carried[2]!), { text: null, sha: null })
  })

  it('preserves order and length', () => {
    const carried = carryBases(fresh, prev)
    assert.equal(carried.length, 3)
    assert.deepEqual(
      carried.map(n => n.path),
      ['a.md.gpg', 'b.md.gpg', 'c.md.gpg'],
    )
  })

  it('carries a half-known base faithfully', () => {
    const halfPrev = [makeNote({ path: 'x.md.gpg', baseText: B })]
    const carried = carryBases([makeNote({ path: 'x.md.gpg' })], halfPrev)
    assert.deepEqual(baseOf(carried[0]!), { text: B, sha: null })
  })

  it('does not mutate the inputs', () => {
    const snapshot = JSON.stringify(fresh)
    carryBases(fresh, prev)
    assert.equal(JSON.stringify(fresh), snapshot)
  })

  it('an empty previous listing leaves every base unknown', () => {
    const carried = carryBases(fresh, [])
    assert.ok(carried.every(n => baseOf(n).sha === null))
  })
})

// ============= NAVIGATING INTO A DIRECTORY =============

describe('mergeDirListing', () => {
  // Navigating into a subdir parses a fresh listing for THAT directory while
  // `state.notes` still holds the directory being left, so the base has to come
  // from the target dir's own cache record.
  const cached = [
    makeNote({ path: 'sub/a.md.gpg', content: 'b64-pre-edit', sha: 'sha-old', baseText: B, baseSha: 'sha-old' }),
    makeNote({ path: 'sub/b.md.gpg', content: 'b64-b', sha: 'sha-b', baseText: B, baseSha: 'sha-b' }),
  ]
  const listed = [
    makeNote({ path: 'sub/a.md.gpg', sha: 'sha-new', content: null }),
    makeNote({ path: 'sub/b.md.gpg', sha: 'sha-b2', content: null }),
  ]
  const drafted = (p: string) => p === 'sub/a.md.gpg'

  it('carries the base from the target dir record', () => {
    const merged = mergeDirListing(listed, cached, () => false)
    assert.deepEqual(baseOf(merged[0]!), { text: B, sha: 'sha-old' })
  })

  it('takes the fresh listing SHA while the base stays at the last synced one', () => {
    const merged = mergeDirListing(listed, cached, () => false)
    assert.equal(merged[0]!.sha, 'sha-new', 'the listing moves forward')
    assert.equal(merged[0]!.baseSha, 'sha-old', 'the merge base does not')
  })

  it('restores the pre-edit blob for a drafted note the prefetch would skip', () => {
    const merged = mergeDirListing(listed, cached, drafted)
    assert.equal(merged[0]!.content, 'b64-pre-edit', 'otherwise there is nothing to decrypt a base from')
    assert.equal(merged[0]!.sha, 'sha-old', 'and nothing for discard to revert to')
  })

  it('leaves a note with no draft to the prefetch', () => {
    const merged = mergeDirListing(listed, cached, drafted)
    assert.equal(merged[1]!.content, null, 'the prefetch fetches it fresh')
    assert.equal(merged[1]!.sha, 'sha-b2')
  })

  it('is a no-op when the directory has no cached record yet', () => {
    const merged = mergeDirListing(listed, [], () => true)
    assert.deepEqual(merged, listed, 'no cached record means no base and no blob to restore')
  })

  it('the restored blob is what makes the divergence detectable', () => {
    const merged = mergeDirListing(listed, cached, drafted)
    const note = merged[0]!
    assert.notEqual(note.content, null, 'a note the prefetch skipped must not stay content-less')
    // With content + base + draft, the pull can reach a verdict without guessing.
    assert.equal(planPull({ base: baseOf(note), remoteSha: 'sha-new', working: LOCAL }), 'conflict')
  })
})

// ============= THE LOCAL WORKING COPY =============

describe('localWorkingText', () => {
  it('is null when the note is not open and has no draft', () => {
    assert.equal(localWorkingText({}), null)
  })

  it('a draft is the working copy even for a closed note', () => {
    assert.equal(localWorkingText({ draft: LOCAL }), LOCAL)
  })

  it('a draft wins over the open editor text', () => {
    assert.equal(localWorkingText({ draft: LOCAL, openText: 'editor', isOpenDirty: true }), LOCAL)
  })

  it('an empty draft is still a working copy, not "no draft"', () => {
    // `draft: ''` must not collapse to null: a draft exists and has content.
    assert.equal(localWorkingText({ draft: '' }), '')
  })

  it('an open, dirty editor counts as the working copy', () => {
    assert.equal(localWorkingText({ openText: LOCAL, isOpenDirty: true }), LOCAL)
  })

  it('an open, clean editor does not — there is nothing to protect', () => {
    assert.equal(localWorkingText({ openText: B, isOpenDirty: false }), null)
  })

  it('dirty with no text available is treated as no working copy', () => {
    assert.equal(localWorkingText({ openText: null, isOpenDirty: true }), null)
  })
})

// ============= MODIFIED =============

describe('isModified', () => {
  it('no working copy → not modified', () => {
    assert.equal(isModified(known, null), false)
  })

  it('working identical to the base → not modified', () => {
    assert.equal(isModified(known, B), false)
  })

  it('working different from the base → modified', () => {
    assert.equal(isModified(known, LOCAL), true)
  })

  it('unknown base + any working copy → modified (cannot prove otherwise)', () => {
    assert.equal(isModified(unknown, B), true)
    assert.equal(isModified(unknown, ''), true)
  })

  it('handles empty texts as real content', () => {
    assert.equal(isModified({ text: '', sha: 's' }, ''), false)
    assert.equal(isModified({ text: '', sha: 's' }, 'x'), true)
  })
})

// ============= THE DIRTY BADGE =============

describe('applyLocalStatus', () => {
  it('a draft identical to the base is NOT badged as unsaved (the false positive)', () => {
    const notes = [makeNote({ path: 'a.md.gpg', baseText: B, baseSha: 'sha-a' })]
    const statused = applyLocalStatus(notes, () => B)
    assert.equal(statused[0]!.dirty, false, 'opened and left alone → clean')
  })

  it('a draft that differs from the base is badged as unsaved', () => {
    const notes = [makeNote({ path: 'a.md.gpg', baseText: B, baseSha: 'sha-a' })]
    const statused = applyLocalStatus(notes, () => LOCAL)
    assert.equal(statused[0]!.dirty, true)
  })

  it('clears a persisted dirty flag once the draft is gone', () => {
    const notes = [makeNote({ path: 'a.md.gpg', dirty: true, baseText: B, baseSha: 'sha-a' })]
    const statused = applyLocalStatus(notes, () => undefined)
    assert.equal(statused[0]!.dirty, false)
  })

  it('a draft with an unknown base stays badged (never silently clean)', () => {
    const notes = [makeNote({ path: 'a.md.gpg' })]
    const statused = applyLocalStatus(notes, () => LOCAL)
    assert.equal(statused[0]!.dirty, true)
  })

  it('leaves an uncommitted new note alone — it is always unsaved', () => {
    const notes = [makeNote({ path: 'new.md.gpg', sha: null, dirty: true, baseText: '', baseSha: null })]
    const statused = applyLocalStatus(notes, () => undefined)
    assert.equal(statused[0]!.dirty, true, 'a note that was never pushed stays dirty')
  })

  it('keeps object identity for a note that is already clean', () => {
    const note = makeNote({ path: 'a.md.gpg', dirty: false })
    const statused = applyLocalStatus([note], () => undefined)
    assert.strictEqual(statused[0], note, 'no needless re-render')
  })

  it('handles each path independently', () => {
    const notes = [
      makeNote({ path: 'a.md.gpg', baseText: B, baseSha: 's' }),
      makeNote({ path: 'b.md.gpg', baseText: B, baseSha: 's' }),
    ]
    const drafts: Record<string, string> = { 'a.md.gpg': LOCAL }
    const statused = applyLocalStatus(notes, p => drafts[p])
    assert.equal(statused[0]!.dirty, true)
    assert.equal(statused[1]!.dirty, false)
  })

  it('is idempotent', () => {
    const notes = [makeNote({ path: 'a.md.gpg', baseText: B, baseSha: 's' })]
    const once = applyLocalStatus(notes, () => LOCAL)
    assert.deepEqual(
      applyLocalStatus(once, () => LOCAL),
      once,
    )
  })
})

// ============= planPull — the cheap (no decryption) decision =============

describe('planPull', () => {
  it('remote SHA === base SHA → up-to-date (nothing to pull)', () => {
    assert.equal(planPull({ base: known, remoteSha: 'sha-base', working: null }), 'up-to-date')
  })

  it('up-to-date even with local edits — the pull is a no-op, the edit is just unpushed', () => {
    assert.equal(planPull({ base: known, remoteSha: 'sha-base', working: LOCAL }), 'up-to-date')
  })

  it('remote moved + no local edits → apply (auto fast-forward)', () => {
    assert.equal(planPull({ base: known, remoteSha: 'sha-new', working: null }), 'apply')
  })

  it('remote moved + working identical to the base → apply (opened and left alone)', () => {
    // The regression this whole change exists for: a draft exists, but it is
    // byte-identical to the base, so there is nothing to lose.
    assert.equal(planPull({ base: known, remoteSha: 'sha-new', working: B }), 'apply')
  })

  it('remote moved + genuinely edited on both sides → conflict, no decryption', () => {
    assert.equal(planPull({ base: known, remoteSha: 'sha-new', working: LOCAL }), 'conflict')
  })

  it('unknown base + no local edits → apply', () => {
    assert.equal(planPull({ base: unknown, remoteSha: 'sha-new', working: null }), 'apply')
  })

  it('unknown base + local edits → decrypt (the plaintext may still match)', () => {
    assert.equal(planPull({ base: unknown, remoteSha: 'sha-new', working: LOCAL }), 'decrypt')
  })

  it('SHA without plaintext is not enough to declare a conflict → decrypt', () => {
    const halfBase: FileBase = { text: null, sha: 'sha-base' }
    assert.equal(planPull({ base: halfBase, remoteSha: 'sha-new', working: LOCAL }), 'decrypt')
  })

  it('never treats an unknown base as up-to-date', () => {
    assert.equal(planPull({ base: unknown, remoteSha: 'sha-new', working: null }), 'apply')
  })

  it('empty working copy that matches an empty base is not a divergence', () => {
    const emptyBase: FileBase = { text: '', sha: 'sha-empty' }
    assert.equal(planPull({ base: emptyBase, remoteSha: 'sha-new', working: '' }), 'apply')
  })
})

// ============= decidePull — the full three-way decision =============

describe('decidePull', () => {
  it('remote === base → up-to-date', () => {
    assert.equal(decidePull({ base: B, working: LOCAL, remote: B }), 'up-to-date')
  })

  it('remote === working → up-to-date (origin already carries our edit)', () => {
    assert.equal(decidePull({ base: B, working: LOCAL, remote: LOCAL }), 'up-to-date')
  })

  it('no local edits + remote moved → fast-forward', () => {
    assert.equal(decidePull({ base: B, working: null, remote: REMOTE }), 'fast-forward')
  })

  it('working === base + remote moved → fast-forward', () => {
    assert.equal(decidePull({ base: B, working: B, remote: REMOTE }), 'fast-forward')
  })

  it('edited on both sides → conflict', () => {
    assert.equal(decidePull({ base: B, working: LOCAL, remote: REMOTE }), 'conflict')
  })

  it('unknown base + local edits + differing remote → conflict (nothing to merge with)', () => {
    assert.equal(decidePull({ base: null, working: LOCAL, remote: REMOTE }), 'conflict')
  })

  it('unknown base + local edits + identical remote → up-to-date', () => {
    assert.equal(decidePull({ base: null, working: LOCAL, remote: LOCAL }), 'up-to-date')
  })

  it('unknown base + no local edits → fast-forward', () => {
    assert.equal(decidePull({ base: null, working: null, remote: REMOTE }), 'fast-forward')
  })

  it('all three identical → up-to-date', () => {
    assert.equal(decidePull({ base: B, working: B, remote: B }), 'up-to-date')
  })

  it('empty base and empty working with a changed remote → fast-forward', () => {
    assert.equal(decidePull({ base: '', working: '', remote: REMOTE }), 'fast-forward')
  })

  it('empty base, empty working, empty remote → up-to-date', () => {
    assert.equal(decidePull({ base: '', working: '', remote: '' }), 'up-to-date')
  })
})

// The two decision functions must never contradict each other: whatever
// planPull calls an auto-apply, decidePull must not call a conflict. That
// mismatch is what would silently strand a clean note behind the ⚠️ button.
describe('planPull and decidePull agree', () => {
  const BASES: Array<[string, FileBase]> = [
    ['known', known],
    ['unknown', unknown],
    ['text only', { text: B, sha: null }],
    ['sha only', { text: null, sha: 'sha-base' }],
    ['empty', { text: '', sha: 'sha-empty' }],
  ]
  const WORKINGS: Array<[string, string | null]> = [
    ['none', null],
    ['equals base', B],
    ['edited', LOCAL],
    ['empty', ''],
  ]
  const REMOTES: Array<[string, string]> = [
    ['equals base', B],
    ['equals working', LOCAL],
    ['changed', REMOTE],
    ['empty', ''],
  ]

  it('a plan of "apply" never becomes a conflict once the plaintext is known', () => {
    for (const [baseLabel, base] of BASES) {
      for (const [workingLabel, working] of WORKINGS) {
        for (const [, remote] of REMOTES) {
          if (planPull({ base, remoteSha: 'sha-remote', working }) !== 'apply') continue
          const action = decidePull({ base: base.text, working, remote })
          assert.notEqual(
            action,
            'conflict',
            `base=${baseLabel} working=${workingLabel} remote=${JSON.stringify(remote)}: ` +
              `planPull said apply but decidePull said conflict`,
          )
        }
      }
    }
  })

  it('a plan of "conflict" always has a fully known base and a divergent working copy', () => {
    for (const [baseLabel, base] of BASES) {
      for (const [workingLabel, working] of WORKINGS) {
        if (planPull({ base, remoteSha: 'sha-remote', working }) !== 'conflict') continue
        assert.notEqual(base.sha, null, `${baseLabel}: conflict without a base SHA`)
        assert.notEqual(base.text, null, `${baseLabel}: conflict without a base text`)
        assert.equal(isModified(base, working), true, `${baseLabel}/${workingLabel}: not a divergence`)
      }
    }
  })

  it('"up-to-date" is only ever reported when the remote SHA matches the base', () => {
    for (const [baseLabel, base] of BASES) {
      for (const [workingLabel, working] of WORKINGS) {
        if (planPull({ base, remoteSha: 'sha-remote', working }) !== 'up-to-date') continue
        assert.equal(base.sha, 'sha-remote', `${baseLabel}/${workingLabel}: false up-to-date`)
      }
    }
  })
})

// ============= EVERY WRITE MUST MOVE THE BASE =============

describe('the base follows every write', () => {
  it('opening a note adopts the decrypted text as the base', () => {
    const note = makeNote({ sha: 'sha-1', content: 'b64' })
    const clean = markNoteClean(note, [note], B)
    assert.deepEqual(baseOf(clean.currentFile), { text: B, sha: 'sha-1' })
    assert.equal(clean.originalContent, B, 'the editor baseline is the base')
  })

  it('opening without the plaintext leaves the base honestly unknown', () => {
    const note = makeNote({ sha: 'sha-1', content: 'b64' })
    const clean = markNoteClean(note, [note])
    assert.deepEqual(baseOf(clean.currentFile), { text: null, sha: 'sha-1' })
  })

  it('a save moves the base to the pushed text and the returned SHA', () => {
    const note = makeNote({ sha: 'sha-1', baseText: B, baseSha: 'sha-1' })
    const saved = saveNoteClean(note, [note], 'b64-2', 'sha-2', LOCAL)
    assert.deepEqual(baseOf(saved.currentFile), { text: LOCAL, sha: 'sha-2' })
    assert.deepEqual(baseOf(saved.notes[0]!), { text: LOCAL, sha: 'sha-2' }, 'the cached copy too')
  })

  it('a save makes the next pull a no-op (origin is exactly what we pushed)', () => {
    const note = makeNote({ sha: 'sha-1', baseText: B, baseSha: 'sha-1' })
    const saved = saveNoteClean(note, [note], 'b64-2', 'sha-2', LOCAL)
    assert.equal(planPull({ base: baseOf(saved.currentFile), remoteSha: 'sha-2', working: null }), 'up-to-date')
  })

  it('a save without the plaintext does not pair a new SHA with a stale text', () => {
    const note = makeNote({ sha: 'sha-1', baseText: B, baseSha: 'sha-1' })
    const saved = saveNoteClean(note, [note], 'b64-2', 'sha-2')
    assert.deepEqual(baseOf(saved.currentFile), { text: null, sha: 'sha-2' })
  })

  it('fast-forwarding to the remote moves the base to the remote', () => {
    const note = makeNote({ sha: 'sha-1', content: 'b64-1', baseText: B, baseSha: 'sha-1' })
    const applied = applyRemoteContent(note, [note], 'b64-2', REMOTE, 'sha-2')
    assert.deepEqual(baseOf(applied.currentFile), { text: REMOTE, sha: 'sha-2' })
    assert.deepEqual(baseOf(applied.notes[0]!), { text: REMOTE, sha: 'sha-2' })
  })

  it('a second pull after a fast-forward is a no-op', () => {
    const note = makeNote({ sha: 'sha-1', content: 'b64-1', baseText: B, baseSha: 'sha-1' })
    const applied = applyRemoteContent(note, [note], 'b64-2', REMOTE, 'sha-2')
    assert.equal(planPull({ base: baseOf(applied.currentFile), remoteSha: 'sha-2', working: null }), 'up-to-date')
  })

  it('discarding edits restores the base (and adopts it, healing old caches)', () => {
    const note = makeNote({ sha: 'sha-1', originalText: B, baseText: null, baseSha: null })
    const reverted = revertNote(note, [note])
    assert.deepEqual(baseOf(reverted.currentFile), { text: B, sha: 'sha-1' })
    assert.equal(reverted.currentContent, B)
  })

  it('a full open → edit → save cycle leaves the note clean and pullable', () => {
    let note: Note = makeNote({ sha: 'sha-1', content: 'b64-1' })
    let notes = [note]

    const opened = markNoteClean(note, notes, B)
    note = opened.currentFile
    notes = opened.notes

    const edited = applyLocalStatus(notes, () => LOCAL)
    assert.equal(edited[0]!.dirty, true, 'edited → unsaved')

    const saved = saveNoteClean(note, edited, 'b64-2', 'sha-2', LOCAL)
    note = saved.currentFile
    notes = applyLocalStatus(saved.notes, () => undefined)
    assert.equal(notes[0]!.dirty, false, 'saved → clean')
    assert.equal(planPull({ base: baseOf(note), remoteSha: 'sha-2', working: null }), 'up-to-date')
  })
})
