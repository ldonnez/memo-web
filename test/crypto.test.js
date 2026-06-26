import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import * as openpgp from 'openpgp';

let encryptContent, decryptContent;
let keyConfig;
let armoredBytes; // valid armored message bytes for config-missing tests

before(async () => {
  globalThis.openpgp = openpgp;
  const mod = await import('../lib/crypto.js');
  encryptContent = mod.encryptContent;
  decryptContent = mod.decryptContent;

  const key = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'Test', email: 'test@test.dev' }],
    passphrase: 'key-pass',
  });
  keyConfig = {
    cryptoMode: 'key',
    publicKey: key.publicKey,
    privateKey: key.privateKey,
    keyPassphrase: 'key-pass',
  };

  // Cache real armored bytes for config-missing tests
  const pwArmored = await encryptContent({ cryptoMode: 'password', cryptoPassword: 'pw' }, 'x');
  armoredBytes = new TextEncoder().encode(pwArmored);
});

describe('encryptContent', () => {
  it('returns an armored string in password mode (not an object)', async () => {
    const result = await encryptContent({ cryptoMode: 'password', cryptoPassword: 'hunter2' }, 'hello');
    assert.equal(typeof result, 'string');
    assert.ok(result.startsWith('-----BEGIN PGP MESSAGE-----'));
  });

  it('returns an armored string in key mode', async () => {
    const result = await encryptContent(keyConfig, 'hello');
    assert.equal(typeof result, 'string');
    assert.ok(result.startsWith('-----BEGIN PGP MESSAGE-----'));
  });

  it('throws when password mode but no password configured', async () => {
    await assert.rejects(
      () => encryptContent({ cryptoMode: 'password', cryptoPassword: '' }, 'hello'),
      /Passphrase is not configured/,
    );
  });

  it('throws when key mode but no public key configured', async () => {
    await assert.rejects(
      () => encryptContent({ cryptoMode: 'key', publicKey: '' }, 'hello'),
      /Public key is not configured/,
    );
  });
});

describe('decryptContent', () => {
  it('decrypts armored content in password mode', async () => {
    const armored = await encryptContent({ cryptoMode: 'password', cryptoPassword: 'hunter2' }, 'secret message');
    const bytes = new TextEncoder().encode(armored);
    const result = await decryptContent({ cryptoMode: 'password', cryptoPassword: 'hunter2' }, bytes);
    assert.equal(result, 'secret message');
  });

  it('decrypts armored content in key mode', async () => {
    const armored = await encryptContent(keyConfig, 'key mode secret');
    const bytes = new TextEncoder().encode(armored);
    const result = await decryptContent(keyConfig, bytes);
    assert.equal(result, 'key mode secret');
  });

  it('throws when password mode but no password configured', async () => {
    await assert.rejects(
      () => decryptContent({ cryptoMode: 'password', cryptoPassword: '' }, armoredBytes),
      /Passphrase is not configured/,
    );
  });

  it('throws when key mode but no private key configured', async () => {
    await assert.rejects(
      () => decryptContent({ cryptoMode: 'key', privateKey: '', keyPassphrase: '' }, armoredBytes),
      /Private key is not configured/,
    );
  });
});

describe('full round-trip (save → cache → selectNote path)', () => {
  it('encrypt → btoa → atob → Uint8Array → decrypt produces original text (password mode)', async () => {
    const original = 'hello world';
    const armored = await encryptContent({ cryptoMode: 'password', cryptoPassword: 'hunter2' }, original);
    // saveNote caches: btoa(encrypted)
    const b64 = btoa(armored);
    // selectNote reads: atob(b64) → Uint8Array → decrypt
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const decrypted = await decryptContent({ cryptoMode: 'password', cryptoPassword: 'hunter2' }, bytes);
    assert.equal(decrypted, original);
  });

  it('encrypt → btoa → atob → Uint8Array → decrypt produces original text (key mode)', async () => {
    const original = 'key mode content';
    const armored = await encryptContent(keyConfig, original);
    const b64 = btoa(armored);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const decrypted = await decryptContent(keyConfig, bytes);
    assert.equal(decrypted, original);
  });

  it('encryptContent returns string that can be base64 round-tripped', async () => {
    const pwCfg = { cryptoMode: 'password', cryptoPassword: 'hunter2' };
    for (const cfg of [pwCfg, keyConfig]) {
      const armored = await encryptContent(cfg, 'test content');
      assert.equal(typeof armored, 'string');
      const b64 = btoa(armored);
      assert.equal(atob(b64), armored);
    }
  });
});
