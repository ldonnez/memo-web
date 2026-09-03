import * as openpgp from 'openpgp'
import type { Config } from './types.ts'

export interface EncryptArgs {
  message: openpgp.Message<string>
  format: 'armored'
  passwords?: string[]
  encryptionKeys?: openpgp.Key | openpgp.Key[]
}

export async function encryptContent(config: Config, plaintext: string): Promise<string> {
  const message = await openpgp.createMessage({ text: plaintext })
  const opts: EncryptArgs = { message, format: 'armored' }
  if (config.cryptoMode === 'password') {
    const pw = config.cryptoPassword
    if (!pw) throw new Error('Passphrase is not configured')
    opts.passwords = [pw]
  } else {
    const armoredPubKey = config.publicKey
    if (!armoredPubKey) throw new Error('Public key is not configured')
    opts.encryptionKeys = await openpgp.readKey({ armoredKey: armoredPubKey })
  }
  const result = await openpgp.encrypt(opts)
  return typeof result === 'string' ? result : result.data
}

export async function decryptContent(config: Config, encryptedBytes: Uint8Array): Promise<string> {
  const asArmored = new TextDecoder().decode(encryptedBytes)
  const message = await openpgp.readMessage({ armoredMessage: asArmored })

  if (config.cryptoMode === 'password') {
    const pw = config.cryptoPassword
    if (!pw) throw new Error('Passphrase is not configured')
    const result = await openpgp.decrypt({ message, passwords: [pw] })
    return result.data
  } else {
    const armoredPrivKey = config.privateKey
    const passphrase = config.keyPassphrase
    if (!armoredPrivKey) throw new Error('Private key is not configured')
    const privKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivKey }),
      ...(passphrase ? { passphrase } : {}),
    })
    const result = await openpgp.decrypt({ message, decryptionKeys: privKey })
    return result.data
  }
}
