import { strict as assert } from 'node:assert'
import { describe, it, beforeEach } from 'node:test'
import {
  setNotePassphrase,
  getNotePassphrase,
  clearNotePassphrase,
  clearAllPassphrases,
  resolveNotePassphrase,
  unlockWithPassphrase,
  validatePassphrasePair,
  effectiveCryptoConfig,
} from '../lib/passphrase.ts'
import { encryptContent, decryptContent } from '../lib/crypto.ts'
import { makeConfig } from './helpers.ts'

const PATH = 'notes/hello.md.asc'
const KEY_CONFIG = makeConfig({ cryptoMode: 'key', publicKey: '', privateKey: '', keyPassphrase: '' })

function fakeDecrypt(right: string, calls: string[] = []) {
  return async (passphrase: string): Promise<string> => {
    calls.push(passphrase)
    if (passphrase === right) return 'note text'
    throw new Error('Wrong passphrase for this note')
  }
}

beforeEach(() => clearAllPassphrases())

describe('session passphrase store', () => {
  it('round-trips a passphrase per path', () => {
    setNotePassphrase(PATH, 'pw')
    assert.equal(getNotePassphrase(PATH), 'pw')
  })

  it('keeps paths isolated', () => {
    setNotePassphrase('a.asc', 'one')
    setNotePassphrase('b.asc', 'two')
    assert.equal(getNotePassphrase('a.asc'), 'one')
    assert.equal(getNotePassphrase('b.asc'), 'two')
  })

  it('clears a single path without touching the others', () => {
    setNotePassphrase('a.asc', 'one')
    setNotePassphrase('b.asc', 'two')
    clearNotePassphrase('a.asc')
    assert.equal(getNotePassphrase('a.asc'), undefined)
    assert.equal(getNotePassphrase('b.asc'), 'two')
  })

  it('clears everything at once (reload / tests)', () => {
    setNotePassphrase('a.asc', 'one')
    clearAllPassphrases()
    assert.equal(getNotePassphrase('a.asc'), undefined)
  })
})

describe('resolveNotePassphrase', () => {
  it('prefers the session passphrase over the settings one, without prompting', () => {
    setNotePassphrase(PATH, 'session-pw')
    let prompted = false
    const result = resolveNotePassphrase(PATH, makeConfig({ cryptoMode: 'password', cryptoPassword: 'settings-pw' }), {
      prompt: () => {
        prompted = true
        return 'typed'
      },
    })
    assert.equal(result, 'session-pw')
    assert.equal(prompted, false)
  })

  it('falls back to the settings passphrase and remembers it for the session', () => {
    const result = resolveNotePassphrase(PATH, makeConfig({ cryptoMode: 'password', cryptoPassword: 'settings-pw' }))
    assert.equal(result, 'settings-pw')
    assert.equal(getNotePassphrase(PATH), 'settings-pw')
  })

  it('prompts when nothing is configured and the caller is interactive', () => {
    const result = resolveNotePassphrase(PATH, makeConfig(), { prompt: () => 'typed' })
    assert.equal(result, 'typed')
    assert.equal(getNotePassphrase(PATH), 'typed')
  })

  it('treats a cancelled or empty prompt as no passphrase', () => {
    assert.equal(resolveNotePassphrase(PATH, makeConfig(), { prompt: () => null }), null)
    assert.equal(resolveNotePassphrase(PATH, makeConfig(), { prompt: () => '' }), null)
    assert.equal(getNotePassphrase(PATH), undefined, 'nothing to remember')
  })

  it('never prompts a background caller', () => {
    assert.equal(resolveNotePassphrase(PATH, makeConfig()), null)
  })
})

describe('unlockWithPassphrase', () => {
  it('opens the note with the session passphrase and returns the plaintext', async () => {
    setNotePassphrase(PATH, 'right')
    const calls: string[] = []
    const text = await unlockWithPassphrase(PATH, KEY_CONFIG, fakeDecrypt('right', calls))
    assert.equal(text, 'note text')
    assert.deepEqual(calls, ['right'])
  })

  it('falls from a stale session guess to the settings passphrase', async () => {
    setNotePassphrase(PATH, 'stale')
    const calls: string[] = []
    const config = makeConfig({ cryptoMode: 'password', cryptoPassword: 'right' })
    const text = await unlockWithPassphrase(PATH, config, fakeDecrypt('right', calls))
    assert.equal(text, 'note text')
    assert.deepEqual(calls, ['stale', 'right'], 'candidates are tried in order')
    assert.equal(getNotePassphrase(PATH), 'right', 'the proven passphrase replaces the stale one')
  })

  it('evicts a wrong session passphrase when every candidate fails', async () => {
    setNotePassphrase(PATH, 'wrong')
    const config = makeConfig({ cryptoMode: 'password', cryptoPassword: 'also-wrong' })
    await assert.rejects(() => unlockWithPassphrase(PATH, config, fakeDecrypt('right')), /Wrong passphrase/)
    assert.equal(getNotePassphrase(PATH), undefined, 'a failed guess must not stick')
  })

  it('prompts after the built-in candidates fail and remembers what worked', async () => {
    setNotePassphrase(PATH, 'wrong')
    const text = await unlockWithPassphrase(PATH, KEY_CONFIG, fakeDecrypt('right'), { prompt: () => 'right' })
    assert.equal(text, 'note text')
    assert.equal(getNotePassphrase(PATH), 'right')
  })

  it('does not prompt when a candidate already works', async () => {
    setNotePassphrase(PATH, 'right')
    let prompted = false
    await unlockWithPassphrase(PATH, KEY_CONFIG, fakeDecrypt('right'), {
      prompt: () => {
        prompted = true
        return 'typed'
      },
    })
    assert.equal(prompted, false)
  })

  it('does not retry the exact value it just failed on', async () => {
    setNotePassphrase(PATH, 'stale')
    const config = makeConfig({ cryptoMode: 'password', cryptoPassword: 'stale' })
    const calls: string[] = []
    await assert.rejects(() =>
      unlockWithPassphrase(PATH, config, fakeDecrypt('right', calls), { prompt: () => 'stale' }),
    )
    assert.deepEqual(calls, ['stale'], 'same wrong passphrase twice would be pointless')
  })

  it('reports "Passphrase is not configured" when there is nothing to try', async () => {
    await assert.rejects(
      () => unlockWithPassphrase(PATH, KEY_CONFIG, fakeDecrypt('right')),
      /Passphrase is not configured/,
    )
  })

  it('reports the same when the only chance was a cancelled prompt', async () => {
    await assert.rejects(
      () => unlockWithPassphrase(PATH, KEY_CONFIG, fakeDecrypt('right'), { prompt: () => null }),
      /Passphrase is not configured/,
    )
  })
})

describe('validatePassphrasePair', () => {
  it('accepts a matching pair', () => {
    assert.equal(validatePassphrasePair('hunter2', 'hunter2'), null)
    assert.equal(validatePassphrasePair('with spaces', 'with spaces'), null, 'passphrases are not trimmed')
  })

  it('rejects an empty passphrase', () => {
    assert.equal(validatePassphrasePair('', ''), 'Passphrase cannot be empty')
  })

  it('rejects a mismatch with a message the modal can show verbatim', () => {
    assert.equal(validatePassphrasePair('one', 'two'), 'Passphrases do not match')
    assert.equal(validatePassphrasePair('one', ''), 'Passphrases do not match', 'empty confirmation is a mismatch')
  })
})

describe('effectiveCryptoConfig', () => {
  it('a note without its own mode follows the app-wide one', () => {
    assert.equal(effectiveCryptoConfig(makeConfig({ cryptoMode: 'key' }), undefined).cryptoMode, 'key')
    assert.equal(effectiveCryptoConfig(makeConfig({ cryptoMode: 'password' }), undefined).cryptoMode, 'password')
    assert.equal(effectiveCryptoConfig(makeConfig(), undefined).cryptoMode, 'key', 'no config either → key')
  })

  it("the note's own mode wins over the app-wide one, both ways", () => {
    assert.equal(effectiveCryptoConfig(makeConfig({ cryptoMode: 'password' }), 'key').cryptoMode, 'key')
    assert.equal(effectiveCryptoConfig(makeConfig({ cryptoMode: 'key' }), 'password').cryptoMode, 'password')
  })

  it('injects the per-note passphrase over the settings one', () => {
    const cfg = effectiveCryptoConfig(
      makeConfig({ cryptoMode: 'password', cryptoPassword: 'settings' }),
      'password',
      'note-pw',
    )
    assert.equal(cfg.cryptoPassword, 'note-pw')
  })

  it('keeps the settings passphrase when no per-note one was resolved', () => {
    const settings = makeConfig({ cryptoMode: 'password', cryptoPassword: 'settings' })
    assert.equal(effectiveCryptoConfig(settings, 'password', null).cryptoPassword, 'settings')
    assert.equal(effectiveCryptoConfig(settings, 'password', '').cryptoPassword, 'settings')
  })

  it('leaves key material untouched', () => {
    const cfg = effectiveCryptoConfig(KEY_CONFIG, 'key')
    assert.equal(cfg.privateKey, KEY_CONFIG.privateKey)
    assert.equal(cfg.keyPassphrase, KEY_CONFIG.keyPassphrase)
  })
})

describe('end-to-end: create with a passphrase, reload, open', () => {
  // The app is configured for GPG keys — the note's own mode is what makes the
  // symmetric round-trip work, exactly as createNewNote stamps it.
  const unlock = (bytes: Uint8Array, opts: { prompt?: () => string | null } = {}) =>
    unlockWithPassphrase(
      PATH,
      KEY_CONFIG,
      passphrase => decryptContent(effectiveCryptoConfig(KEY_CONFIG, 'password', passphrase), bytes),
      opts,
    )

  it('encrypts with the chosen passphrase and opens it again after a reload', async () => {
    // Creation: the modal validated the pair, the session remembers the winner.
    assert.equal(validatePassphrasePair('note-pw', 'note-pw'), null)
    setNotePassphrase(PATH, 'note-pw')
    const armored = await encryptContent(
      effectiveCryptoConfig(KEY_CONFIG, 'password', getNotePassphrase(PATH)),
      'hello secret',
    )
    const bytes = new TextEncoder().encode(armored)

    // A background refresh right after a reload must not block on a dialog.
    clearAllPassphrases()
    await assert.rejects(() => unlock(bytes), /Passphrase is not configured/)

    // A wrong guess is reported in words the user understands and never sticks.
    await assert.rejects(() => unlock(bytes, { prompt: () => 'wrong' }), /Wrong passphrase for this note/)
    assert.equal(getNotePassphrase(PATH), undefined)

    // The right one opens the note and is remembered for the rest of the session.
    assert.equal(await unlock(bytes, { prompt: () => 'note-pw' }), 'hello secret')
    assert.equal(getNotePassphrase(PATH), 'note-pw')
    assert.equal(await unlock(bytes), 'hello secret', 'a second open needs no prompt')
  })
})
