import type { Note } from './types.ts'

/**
 * Git-shaped sync primitives.
 *
 * The app used to decide "can I apply the remote copy?" from a single boolean
 * (`isDirty || hasDraft`). That is not a merge test: a draft is written on every
 * navigation (app.ts saves one when leaving a dirty note), so merely *visiting*
 * a note made it look locally modified, and any remote change then surfaced as
 * a ⚠️ "remote has changes" button instead of an automatic fast-forward.
 *
 * Git never asks "is there a draft?", it compares three texts:
 *
 *   base    = the last content known to exist on the remote (HEAD for the path)
 *   working = the local working copy
 *   remote  = what the remote has now
 *
 * This module owns that model. The base is stored on the note itself
 * (`baseText` / `baseSha`) so it rides along in the IndexedDB cache record and
 * survives reloads, and so there is exactly ONE source of truth — no side map
 * that can drift from the note the editor is actually showing.
 *
 * Two decision functions, split by what they need to look at:
 *
 *   planPull()  — sha-only. Answers the question from ciphertext (1 string
 *                 compare) so the common case never pays for a decryption.
 *   decidePull() — the full three-way plaintext decision, used once the remote
 *                 has been decrypted (and the entry point for the text merge
 *                 that replaces the ⚠️ button).
 */

/** The merge base for one path. `text`/`sha` are null when the base is unknown. */
export interface FileBase {
  text: string | null
  sha: string | null
}

export function baseOf(note: Note | null | undefined): FileBase {
  if (!note) return { text: null, sha: null }
  return { text: note.baseText ?? null, sha: note.baseSha ?? null }
}

export function withBase(note: Note, text: string | null, sha: string | null): Note {
  return { ...note, baseText: text, baseSha: sha }
}

/**
 * Adopt freshly decrypted text as both the merge base and the dirty-compare
 * baseline (`originalText`). Used when a note is opened so the editor's "unsaved
 * changes" test and the pull decision share one baseline — previously they were
 * separate, which is how a reopened draft ended up comparing against itself.
 */
export function adoptBase(note: Note, text: string, sha: string | null): Note {
  return { ...note, baseText: text, baseSha: sha, originalText: text }
}

/**
 * Copy the merge base from a previous listing onto freshly parsed notes, matched
 * by path. A listing refresh replaces every note object, and a base that is
 * dropped here silently degrades every later decision to "unknown base" (and
 * therefore to the ⚠️ button). The base is only ever advanced deliberately —
 * where we have decrypted the text — so a remote that moved on does NOT
 * invalidate it: a stale base is exactly the merge base we want.
 */
export function carryBases(fresh: Note[], prev: Note[]): Note[] {
  const byPath = new Map(prev.map(n => [n.path, n]))
  return fresh.map(n => {
    const old = byPath.get(n.path)
    if (!old) return n
    if (old.baseText == null && old.baseSha == null) return n
    return { ...n, baseText: old.baseText ?? null, baseSha: old.baseSha ?? null }
  })
}

/**
 * Hand a note back the blob the cache record still holds, when that blob IS the
 * one the fresh listing names (same SHA). Restoring it is indistinguishable from
 * a refetch — it saves a request and keeps the note readable with no network.
 *
 * This is what a subdirectory's offline copy is made of. The record is the only
 * place a blob survives a reload, so anything that overwrites the record with a
 * content-less listing (or with a prefetch that failed) must go through here first.
 * A blob whose SHA has moved is deliberately NOT restored: it is stale, and
 * presenting it as the note's content would hide a remote change.
 */
export function restoreStillCurrentBlobs(fresh: Note[], cached: Note[]): Note[] {
  const byPath = new Map(cached.map(n => [n.path, n]))
  return fresh.map(n => {
    if (n.content) return n
    const old = byPath.get(n.path)
    if (!old?.content || old.sha !== n.sha) return n
    return { ...n, content: old.content }
  })
}

export interface MergeDirOptions {
  /**
   * Whether the caller refetches every note's blob afterwards (the normal
   * directory refresh). `false` is the `openNoteByPath` path — opening a note in
   * another directory, which must NOT prefetch — and there a stale blob is kept
   * too: it is the last version we know of, the note stays openable offline, and
   * the pull advances it to the real remote (or flags a divergence) from there.
   */
  prefetch?: boolean
}

/**
 * Merge a freshly parsed listing with the cache record of the directory it belongs
 * to. Needed whenever the listing comes from a directory other than the one
 * currently in `state.notes` (navigating into a subdir): the merge base lives in
 * the target dir's own record, so carrying it from the notes being left behind
 * would silently drop it.
 *
 * The cached blob comes back with it, and that is what keeps a subdirectory
 * usable offline — the listing carries no content of its own, so dropping the blob
 * here would empty the directory's offline copy (and the record the caller writes
 * next would persist that emptiness for every sibling of the note being opened).
 * Two cases qualify:
 *   - a note with an active draft, which the prefetch deliberately skips, so its
 *     pre-edit blob is the only thing there is to decrypt a base from, for
 *     "discard" to revert to, and for the divergence to be detectable at all;
 *   - a note whose cached blob is still the remote's blob (see
 *     restoreStillCurrentBlobs), which needs no refetch to be right.
 */
export function mergeDirListing(
  listed: Note[],
  cached: Note[],
  hasDraft: (path: string) => boolean,
  opts: MergeDirOptions = {},
): Note[] {
  const keepStale = opts.prefetch === false
  const byPath = new Map(cached.map(n => [n.path, n]))
  return carryBases(restoreStillCurrentBlobs(listed, cached), cached).map(n => {
    const old = byPath.get(n.path)
    if (!old?.content) return n
    if (hasDraft(n.path) || (keepStale && old.sha !== n.sha)) {
      return { ...n, content: old.content, sha: old.sha ?? n.sha }
    }
    return n
  })
}

/**
 * The local working copy for a path, or null when there is nothing to protect.
 * A draft always wins (it is the persisted working copy); otherwise the open
 * editor counts only when it is dirty, i.e. when its text differs from the base
 * it was opened with.
 */
export function localWorkingText(opts: {
  draft?: string | undefined
  openText?: string | null | undefined
  isOpenDirty?: boolean | undefined
}): string | null {
  if (opts.draft !== undefined) return opts.draft
  if (opts.isOpenDirty && opts.openText != null) return opts.openText
  return null
}

/**
 * True when the working copy actually differs from the merge base — i.e. there
 * are real local edits to protect. `working === null` means "no local edits"
 * (nothing open, or open and clean); a draft byte-identical to the base counts as
 * no edits, which is what lets a merely-visited note fast-forward.
 */
export function isModified(base: FileBase, working: string | null): boolean {
  if (working === null) return false
  if (base.text === null) return true
  return working !== base.text
}

/**
 * Re-derive each note's `dirty` flag from the base comparison instead of from
 * "a draft exists". This is what stops a note that was merely opened and left
 * untouched from being badged "unsaved" forever.
 */
export function applyLocalStatus(notes: Note[], draft: (path: string) => string | undefined): Note[] {
  return notes.map(n => {
    if (!n.sha) return n // never committed (brand-new note) — always unsaved
    const d = draft(n.path)
    if (d === undefined) return n.dirty ? { ...n, dirty: false } : n
    return { ...n, dirty: isModified(baseOf(n), d) }
  })
}

export type PullAction = 'up-to-date' | 'fast-forward' | 'conflict'

/**
 * The three-way decision, on plaintext.
 *
 *   up-to-date   remote === base (nothing to pull) or remote === working
 *                (our change is already there; only the SHA needs reconciling)
 *   fast-forward working === base (no local divergence — safe to take remote
 *                wholesale; this is the auto-update path)
 *   conflict     both sides moved and there is nothing to merge them with
 */
export function decidePull(input: { base: string | null; working: string | null; remote: string }): PullAction {
  const { base, working, remote } = input
  if (base !== null && remote === base) return 'up-to-date'
  if (working !== null && working === remote) return 'up-to-date'
  if (working === null || working === base) return 'fast-forward'
  return 'conflict'
}

export type PullPlan =
  /** The remote blob is the one the base was taken from — nothing to pull. */
  | 'up-to-date'
  /** No local divergence: decrypt the remote and load it. */
  | 'apply'
  /** Local edits against a known base that the remote has moved past. */
  | 'conflict'
  /** Local edits but no base to compare against: decrypt, then decidePull(). */
  | 'decrypt'

/**
 * The cheap decision: blob SHAs plus the base comparison, no decryption.
 *
 * `up-to-date` is the single string compare git does to know a pull is a no-op.
 * `apply` is the auto fast-forward: it fires whenever the working copy has not
 * diverged from the base — including the "opened and left untouched" case,
 * where a draft exists but is byte-identical to the base. That case is the whole
 * point: the old boolean test flagged it as a conflict and demanded a button
 * click. `conflict` skips the decrypt entirely because a fully known base (text
 * *and* SHA) plus a differing remote SHA already proves the two sides diverged
 * — the remote text is only needed to *merge*, not to detect. A SHA without its
 * plaintext is not enough, so that falls through to `decrypt`.
 */
export function planPull(input: { base: FileBase; remoteSha: string; working: string | null }): PullPlan {
  const { base, remoteSha, working } = input
  if (base.sha !== null && base.sha === remoteSha) return 'up-to-date'
  if (!isModified(base, working)) return 'apply'
  if (base.sha !== null && base.text !== null) return 'conflict'
  return 'decrypt'
}
