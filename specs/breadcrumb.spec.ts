import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { breadcrumbCrumbs, HOME_CRUMB, type Crumb } from '../lib/util.ts'

const shape = (crumbs: Crumb[]) => crumbs.map(c => [c.label, c.dir])
const links = (crumbs: Crumb[]) => crumbs.filter(c => c.dir !== null).map(c => c.dir)

describe('breadcrumbCrumbs', () => {
  describe('the home crumb', () => {
    it('is a word, so the trail stays a list of folder names', () => {
      assert.equal(HOME_CRUMB, 'root', 'not an icon: the crumb names the place it goes to')
      assert.deepEqual(
        breadcrumbCrumbs('notes/2024', 'notes')[0],
        { label: 'root', dir: 'notes' },
        'and it is the first crumb of the trail',
      )
    })

    it('is a link to the app root when browsing a subdirectory', () => {
      const crumbs = breadcrumbCrumbs('notes/2024', 'notes')
      assert.equal(crumbs[0]?.label, HOME_CRUMB)
      assert.equal(crumbs[0]?.dir, 'notes', 'one click back to the root, whatever the depth')
    })

    it('is a link to the repo root when no ghPath is configured', () => {
      assert.equal(breadcrumbCrumbs('2024/march', '')[0]?.dir, '')
      assert.equal(breadcrumbCrumbs('2024/march')[0]?.dir, '')
    })

    it('is inert once you are already at the root', () => {
      for (const root of ['', 'notes', 'notes/work']) {
        const crumbs = breadcrumbCrumbs(root, root)
        assert.equal(crumbs.length, 1, `nothing below the root (${root || '<repo>'})`)
        assert.equal(crumbs[0]?.dir, null, `the home crumb at the root is not a link (${root || '<repo>'})`)
      }
    })

    it('still reaches a configured root from the repo root above it', () => {
      // The app's root is `notes`, but a cached listing can put us at the repo root.
      const crumbs = breadcrumbCrumbs('', 'notes')
      assert.equal(crumbs[0]?.dir, 'notes', 'the home crumb goes down to the configured root')
    })

    it('is the only crumb that can escape a deeply nested path', () => {
      const crumbs = breadcrumbCrumbs('notes/work/2024/march', 'notes')
      assert.deepEqual(links(crumbs), ['notes', 'notes/work', 'notes/work/2024'])
      assert.equal(crumbs.at(-1)?.dir, null, 'and the last crumb is the current folder, not a link')
    })
  })

  describe('the folders below the root', () => {
    it('are links that accumulate the full path, including the root', () => {
      assert.deepEqual(shape(breadcrumbCrumbs('notes/work/2024/march', 'notes')), [
        [HOME_CRUMB, 'notes'],
        ['work', 'notes/work'],
        ['2024', 'notes/work/2024'],
        ['march', null],
      ])
    })

    it('start from the repo root when no ghPath is configured', () => {
      assert.deepEqual(shape(breadcrumbCrumbs('a/b/c', '')), [
        [HOME_CRUMB, ''],
        ['a', 'a'],
        ['b', 'a/b'],
        ['c', null],
      ])
    })

    it('are not duplicated by a root that has segments of its own', () => {
      assert.deepEqual(
        breadcrumbCrumbs('notes/2024', 'notes').map(c => c.label),
        [HOME_CRUMB, '2024'],
        'the root stands for `notes`, so the trail starts below it',
      )
    })

    it('render a deeper crumb as a link, not the current one', () => {
      // The one place the old trail was worst: the first segment below the root
      // was plain text, with no link above it.
      const crumbs = breadcrumbCrumbs('notes/2024/march', 'notes')
      assert.equal(crumbs[1]?.label, '2024')
      assert.equal(crumbs[1]?.dir, 'notes/2024')
    })
  })

  describe('a path outside the configured root', () => {
    it('is shown in full instead of being sliced as if it lived below the root', () => {
      // A record cached before ghPath changed: the segments must not be eaten.
      const crumbs = breadcrumbCrumbs('archive/2024', 'notes')
      assert.deepEqual(shape(crumbs), [
        [HOME_CRUMB, 'notes'],
        ['archive', 'archive'],
        ['2024', null],
      ])
    })

    it('does not mistake a shared prefix for being inside the root', () => {
      const crumbs = breadcrumbCrumbs('notebook/2024', 'notes')
      assert.deepEqual(
        crumbs.map(c => c.label),
        [HOME_CRUMB, 'notebook', '2024'],
        '`notebook` is not inside `notes`',
      )
      assert.deepEqual(links(crumbs), ['notes', 'notebook'], 'so the ancestor link keeps the real path')
      assert.equal(crumbs.at(-1)?.dir, null)
    })
  })

  describe('the ends of the path', () => {
    it('handles an empty path as the root', () => {
      assert.deepEqual(shape(breadcrumbCrumbs('')), [[HOME_CRUMB, null]])
      assert.deepEqual(shape(breadcrumbCrumbs('', '')), [[HOME_CRUMB, null]])
    })

    it('ignores empty segments and stray slashes', () => {
      assert.deepEqual(shape(breadcrumbCrumbs('/a//b/')), [
        [HOME_CRUMB, ''],
        ['a', 'a'],
        ['b', null],
      ])
    })
  })
})
