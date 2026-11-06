import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { nextTheme, normalizeTheme, resolveTheme, themeColor } from '../lib/theme.ts'

describe('theme helpers', () => {
  it('accepts only the known theme names', () => {
    assert.equal(normalizeTheme('light'), 'light')
    assert.equal(normalizeTheme('dark'), 'dark')
    assert.equal(normalizeTheme('system'), null)
    assert.equal(normalizeTheme(null), null)
  })

  it('prefers a stored choice over the system preference', () => {
    assert.equal(resolveTheme('light', true), 'light')
    assert.equal(resolveTheme('dark', false), 'dark')
  })

  it('falls back to the system preference', () => {
    assert.equal(resolveTheme(null, true), 'dark')
    assert.equal(resolveTheme(null, false), 'light')
    assert.equal(resolveTheme('nonsense', false), 'light')
  })

  it('toggles between the two themes', () => {
    assert.equal(nextTheme('dark'), 'light')
    assert.equal(nextTheme('light'), 'dark')
  })

  it('maps each theme to its status-bar color', () => {
    assert.equal(themeColor('dark'), '#161b22')
    assert.equal(themeColor('light'), '#f6f8fa')
  })
})
