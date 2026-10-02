import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NOTE_EXT,
  LEGACY_NOTE_EXTS,
  formatNoteItem,
  isNoteName,
  noteDisplayName,
  noteExtensions,
  noteNameFromInput,
  noteFileName,
} from '../lib/util.ts'
import { parseEntries } from '../lib/github.ts'
import type { Note } from '../lib/types.ts'

const file = (name: string, sha = 's1') => ({ type: 'file', name, path: name, sha, size: 1 })
const names = (ext?: string) =>
  parseEntries([file('a.md.asc'), file('b.md.gpg'), file('c.md.sec')], ext).notes.map(n => n.name)

describe('note extensions', () => {
  it('writes .asc by default and still knows the legacy .md.* suffixes', () => {
    assert.equal(DEFAULT_NOTE_EXT, '.asc')
    assert.deepEqual(LEGACY_NOTE_EXTS, ['.md.asc', '.md.gpg'])
    assert.deepEqual(noteExtensions(), ['.asc', '.gpg', '.md.asc', '.md.gpg'])
  })

  it('honours a configured suffix without dropping the built-in ones', () => {
    assert.deepEqual(noteExtensions('.md.sec'), ['.md.sec', '.asc', '.gpg', '.md.asc', '.md.gpg'])
    assert.deepEqual(noteExtensions('  .asc  '), ['.asc', '.gpg', '.md.asc', '.md.gpg'], 'trimmed and de-duplicated')
  })
})

describe('isNoteName', () => {
  it('recognises every suffix with no configuration at all', () => {
    assert.equal(isNoteName('a.asc'), true, 'what a new note is written with')
    assert.equal(isNoteName('a.gpg'), true)
    assert.equal(isNoteName('a.md.asc'), true)
    assert.equal(isNoteName('a.md.gpg'), true, 'a repo full of legacy notes must not go blank')
  })

  it('recognises a configured suffix alongside the built-in ones', () => {
    assert.equal(isNoteName('a.md.sec', '.md.sec'), true)
    assert.equal(isNoteName('a.asc', '.md.sec'), true)
    assert.equal(isNoteName('a.md.gpg', '.md.sec'), true)
  })

  it('cannot tell an exported key from a note, so it lists it as a candidate', () => {
    // `gpg --export -a KEYID` writes KEYID.asc / KEYID.gpg — the same armored
    // tails a note uses. A listing has no content, so the suffix is the only
    // signal there is; opening one is what rejects it, in isArmoredKey().
    assert.equal(isNoteName('0xDEADBEEF.asc'), true, 'listed, then refused on open')
  })

  it('ignores anything else in the directory', () => {
    for (const name of ['notes.json', 'README.md', 'a.md', 'a.md.gpg.bak', 'gpg', 'a.asc.txt']) {
      assert.equal(isNoteName(name), false, `bug: ${name} would be offered as a note`)
    }
  })
})

describe('a directory listing', () => {
  it('shows notes of every suffix side by side', () => {
    assert.deepEqual(names(), ['a.md.asc', 'b.md.gpg'], 'both in one directory, mixed repo')
    assert.deepEqual(names('.md.sec'), ['a.md.asc', 'b.md.gpg', 'c.md.sec'])
  })

  it('shows a legacy repo alongside the new naming', () => {
    // The upgrade case: the default moved from .md.asc to .asc, which must not
    // hide every note written before it.
    const entries = [file('old.md.gpg'), file('new.asc'), file('older.md.asc')]
    assert.deepEqual(
      parseEntries(entries, '.asc')
        .notes.map(n => n.name)
        .sort(),
      ['new.asc', 'old.md.gpg', 'older.md.asc'],
      'every suffix listed',
    )
  })

  it('leaves other files out', () => {
    const entries = [file('notes.json'), file('README.md'), file('real.asc')]
    assert.deepEqual(
      parseEntries(entries, '.asc').notes.map(n => n.name),
      ['real.asc'],
    )
  })
})

describe('noteDisplayName', () => {
  it('strips every suffix', () => {
    assert.equal(noteDisplayName('my-note.asc'), 'my-note')
    assert.equal(noteDisplayName('my-note.gpg'), 'my-note')
    assert.equal(noteDisplayName('my-note.md.asc'), 'my-note')
    assert.equal(noteDisplayName('my-note.md.gpg'), 'my-note')
    assert.equal(noteDisplayName('my-note.md.sec', '.md.sec'), 'my-note')
  })

  it('strips the longest suffix first, so no `.md` is left behind', () => {
    assert.equal(noteDisplayName('my-note.md.asc', '.asc'), 'my-note')
    assert.equal(noteDisplayName('my-note.md.gpg'), 'my-note')
  })

  it('leaves a name it does not recognise alone', () => {
    assert.equal(noteDisplayName('README.md'), 'README.md')
    assert.equal(noteDisplayName('a.md.gpg.bak'), 'a.md.gpg.bak')
    assert.equal(noteDisplayName('.asc'), '.asc', 'a file that is nothing but the suffix keeps its name')
  })

  it('is how a new note drops a typed suffix: `test.asc` is the note `test`', () => {
    // newNote seeds the body with `# <name>`, so a typed suffix must not reach
    // the heading — or be appended a second time to the file name.
    for (const typed of ['test.asc', 'test.gpg', 'test.md.asc', 'test.md.gpg']) {
      assert.equal(noteDisplayName(typed), 'test')
    }
    assert.equal(noteDisplayName('test'), 'test', 'a bare name is untouched')
    assert.equal(noteDisplayName('2024.report.asc'), '2024.report', 'dots in the name are kept')
  })
})

describe('noteNameFromInput', () => {
  it('drops a typed suffix, so the seeded heading is `# test`', () => {
    for (const typed of ['test.asc', 'test.gpg', 'test.md.asc', 'test.md.gpg']) {
      assert.equal(noteNameFromInput(typed), 'test')
    }
  })

  it('drops a typed .md too — it only marked the old .md.asc naming', () => {
    assert.equal(noteNameFromInput('test.md'), 'test')
    assert.equal(noteNameFromInput('test.MD'), 'test')
    assert.equal(noteNameFromInput('test.md.asc'), 'test', 'and not twice')
  })

  it('leaves a name it does not recognise alone', () => {
    assert.equal(noteNameFromInput('test'), 'test')
    assert.equal(noteNameFromInput('  spaced  '), 'spaced')
    assert.equal(noteNameFromInput('2024.report.md'), '2024.report')
    assert.equal(noteNameFromInput('draft.md.asc.txt'), 'draft.md.asc.txt')
    assert.equal(noteNameFromInput('.md'), '.md', 'never returns an empty name')
  })
})

describe('noteFileName', () => {
  it('keeps a typed .md and appends the configured suffix once', () => {
    // The two names are deliberately different: the file is what was typed, the
    // heading (noteNameFromInput) is the bare note name.
    assert.equal(noteFileName('test.md', '.asc'), 'test.md.asc')
    assert.equal(noteFileName('test', '.asc'), 'test.asc')
  })

  it('does not append a suffix that is already there', () => {
    assert.equal(noteFileName('test.asc', '.asc'), 'test.asc', 'not test.asc.asc')
    assert.equal(noteFileName('test.gpg', '.gpg'), 'test.gpg')
  })

  it('appends for a different suffix, and honours a configured one', () => {
    assert.equal(noteFileName('test.gpg', '.asc'), 'test.gpg.asc')
    assert.equal(noteFileName('test.md.asc', '.md.sec'), 'test.md.asc.md.sec')
    assert.equal(noteFileName('  test  ', '.asc'), 'test.asc')
  })

  it('is what the sidebar shows, so both namings look alike', () => {
    const note = (name: string): Note =>
      ({
        name,
        path: `dir/${name}`,
        sha: 's1',
        size: 1,
        date: '',
        dirty: false,
        content: null,
        decrypted: null,
        originalText: '',
        isDir: false,
      }) as Note
    for (const name of ['my-note.asc', 'my-note.gpg', 'my-note.md.asc', 'my-note.md.gpg']) {
      const html = formatNoteItem(note(name), undefined, DEFAULT_NOTE_EXT)
      assert.match(html, />📄 my-note</, 'the suffix never reaches the sidebar')
      // The full path stays in data-path — that is what the note is opened by.
      assert.match(html, new RegExp(`data-path="dir/${name.replace('.', '\\.')}"`))
    }
  })
})
