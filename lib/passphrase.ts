import type { Config } from './types.ts'

/**
 * Per-note passphrases live in memory for the session only — never in
 * localStorage. Opening a passphrase note after a reload asks for the
 * passphrase again, which is the whole point of a per-note passphrase over
 * the app-wide one in settings.
 *
 * An entry is only ever written for a passphrase that has been proven against
 * the note (a successful decrypt) or just chosen at creation, so a wrong guess
 * can never stick and skip the prompt on the next attempt.
 */
const sessionPassphrases = new Map<string, string>()

export function setNotePassphrase(path: string, passphrase: string): void {
  sessionPassphrases.set(path, passphrase)
}

export function getNotePassphrase(path: string): string | undefined {
  return sessionPassphrases.get(path)
}

export function clearNotePassphrase(path: string): void {
  sessionPassphrases.delete(path)
}

export function clearAllPassphrases(): void {
  sessionPassphrases.clear()
}

export interface PassphrasePromptOptions {
  /**
   * Interactive prompt, omitted by background syncs so they can never block on
   * a dialog. Returns the entered passphrase, or null when the user cancels.
   * Async because the app shows a modal (`#passphraseModal`, masked input)
   * instead of a plain-text `window.prompt`.
   */
  prompt?: () => string | null | Promise<string | null>
}

/**
 * Find the passphrase for a note without verifying it: this session's memory
 * first, then the app-wide passphrase from settings, then an interactive
 * prompt. For encryption — there is nothing to verify against until the bytes
 * come back. Anything found is cached, and a later decrypt either confirms it
 * or evicts it (see `unlockWithPassphrase`).
 */
export async function resolveNotePassphrase(
  path: string,
  config: Config,
  opts: PassphrasePromptOptions = {},
): Promise<string | null> {
  const cached = sessionPassphrases.get(path)
  if (cached) return cached
  const configured = config.cryptoPassword
  if (configured) {
    sessionPassphrases.set(path, configured)
    return configured
  }
  if (opts.prompt) {
    const entered = await opts.prompt()
    if (entered) {
      sessionPassphrases.set(path, entered)
      return entered
    }
  }
  return null
}

/**
 * Decrypt with verification, trying every passphrase that could belong to the
 * note: the session's copy, the settings passphrase, then — only when the
 * caller is interactive — a prompt. Each failure evicts that candidate, so a
 * stale session guess falls through to the prompt instead of replaying itself
 * forever. The passphrase that opens the note is cached for the rest of the
 * session.
 *
 * Throws the last decrypt error when every candidate failed, or
 * "Passphrase is not configured" when there was nothing to try.
 */
export async function unlockWithPassphrase(
  path: string,
  config: Config,
  decrypt: (passphrase: string) => Promise<string>,
  opts: PassphrasePromptOptions = {},
): Promise<string> {
  const candidates: string[] = []
  const cached = sessionPassphrases.get(path)
  if (cached) candidates.push(cached)
  if (config.cryptoPassword && config.cryptoPassword !== cached) candidates.push(config.cryptoPassword)

  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      const text = await decrypt(candidate)
      sessionPassphrases.set(path, candidate)
      return text
    } catch (e) {
      if (sessionPassphrases.get(path) === candidate) sessionPassphrases.delete(path)
      lastError = e
    }
  }

  if (opts.prompt) {
    const entered = await opts.prompt()
    if (entered && !candidates.includes(entered)) {
      try {
        const text = await decrypt(entered)
        sessionPassphrases.set(path, entered)
        return text
      } catch (e) {
        lastError = e
      }
    }
  }

  if (lastError) throw lastError
  throw new Error('Passphrase is not configured')
}

/**
 * Single-shot validation for the new-note modal. Returns an error message for
 * the inline error element, or null when the pair is acceptable.
 */
export function validatePassphrasePair(passphrase: string, confirmation: string): string | null {
  if (!passphrase) return 'Passphrase cannot be empty'
  if (passphrase !== confirmation) return 'Passphrases do not match'
  return null
}

/**
 * The Config a note's crypto operations actually run with: the note's own mode
 * wins over the app-wide one, and a resolved per-note passphrase is injected.
 * A note without `cryptoMode` (created before per-note crypto existed) follows
 * `config.cryptoMode`; with no passphrase resolved the settings passphrase
 * stays in place, and `encryptContent`/`decryptContent` raise the canonical
 * "Passphrase is not configured" when there is nothing left to use.
 */
export function effectiveCryptoConfig(
  config: Config,
  mode: 'key' | 'password' | undefined,
  passphrase?: string | null,
): Config {
  const resolved = mode ?? config.cryptoMode ?? 'key'
  if (resolved === 'password') {
    return { ...config, cryptoMode: 'password', ...(passphrase ? { cryptoPassword: passphrase } : {}) }
  }
  return { ...config, cryptoMode: 'key' }
}
