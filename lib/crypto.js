export async function encryptContent(config, plaintext) {
  const { openpgp } = globalThis;
  const message = await openpgp.createMessage({ text: plaintext });
  const opts = { message, format: 'armored' };
  if (config.cryptoMode === 'password') {
    const pw = config.cryptoPassword;
    if (!pw) throw new Error('Passphrase is not configured');
    opts.passwords = [pw];
  } else {
    const armoredPubKey = config.publicKey;
    if (!armoredPubKey) throw new Error('Public key is not configured');
    opts.encryptionKeys = await openpgp.readKey({ armoredKey: armoredPubKey });
  }
  const result = await openpgp.encrypt(opts);
  return result && result.data !== undefined ? result.data : result;
}

export async function decryptContent(config, encryptedBytes) {
  const { openpgp } = globalThis;
  const asArmored = new TextDecoder().decode(encryptedBytes);
  const message = await openpgp.readMessage({ armoredMessage: asArmored });

  if (config.cryptoMode === 'password') {
    const pw = config.cryptoPassword;
    if (!pw) throw new Error('Passphrase is not configured');
    const { data } = await openpgp.decrypt({ message, passwords: [pw] });
    return data;
  } else {
    const armoredPrivKey = config.privateKey;
    const passphrase = config.keyPassphrase;
    if (!armoredPrivKey) throw new Error('Private key is not configured');
    const privKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivKey }),
      passphrase,
    });
    const { data } = await openpgp.decrypt({ message, decryptionKeys: privKey });
    return data;
  }
}
