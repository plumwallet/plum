// The vault: sealed under the password, opened only by it, tamper-evident, and re-sealable under a new password.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { b64decode, b64encode } from '../src/shared/bytes.js';
import { KDF, changePassword, createVault, passwordOpens, readVault, unlockVault, writeVault } from '../src/background/vault.js';

const DATA = { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', keys: { a1: 'AAAA' } };

test('seals with scrypt (N=2^17, r=8) + AES-GCM; opens with the password and nothing else', async () => {
  assert.deepEqual({ N: KDF.N, r: KDF.r, p: KDF.p }, { N: 131072, r: 8, p: 1 });
  const { vault, dataKey } = await createVault('correct horse battery', DATA);
  assert.equal(vault.v, 1);
  assert.equal(b64decode(vault.kdf.salt).length, 16);
  assert.ok(!JSON.stringify(vault).includes('abandon'), 'no plaintext on disk');
  const opened = await unlockVault(vault, 'correct horse battery');
  assert.deepEqual(opened.data, DATA);
  assert.deepEqual(opened.dataKey, dataKey);
  await assert.rejects(unlockVault(vault, 'correct horse batterY'), /wrong password/);
  assert.equal(await passwordOpens(vault, 'nope nope nope'), false);
});

test('any password seals the vault, a blank or short one included; only text is taken', async () => {
  const blank = await createVault('', DATA);
  assert.deepEqual((await unlockVault(blank.vault, '')).data, DATA);
  await assert.rejects(unlockVault(blank.vault, ' '), /wrong password/);
  const short = await createVault('ab', DATA);
  assert.deepEqual((await unlockVault(short.vault, 'ab')).data, DATA);
  await assert.rejects(createVault(undefined, DATA), /has to be text/);
});

test('any change to the sealed bytes is caught (AES-GCM), and the parts cannot be swapped', async () => {
  const { vault, dataKey } = await createVault('correct horse battery', DATA);
  const ct = b64decode(vault.data.ct);
  ct[5] ^= 1;
  await assert.rejects(readVault({ ...vault, data: { ...vault.data, ct: b64encode(ct) } }, dataKey));
  // the data box sealed under the data key can't stand in for the key box
  await assert.rejects(unlockVault({ ...vault, key: vault.data }, 'correct horse battery'));
});

test('a vault asking for weak settings is refused before the password is tried', async () => {
  const { vault } = await createVault('correct horse battery', DATA);
  await assert.rejects(unlockVault({ ...vault, kdf: { ...vault.kdf, N: 1024 } }, 'correct horse battery'), /weaker/);
});

test('new data keeps the password; a new password keeps the data', async () => {
  const { vault, dataKey } = await createVault('correct horse battery', DATA);
  const more = { ...DATA, keys: { a1: 'AAAA', b2: 'BBBB' } };
  const v2 = await writeVault(vault, dataKey, more);
  assert.notEqual(v2.data.iv, vault.data.iv, 'a fresh nonce for every write');
  assert.deepEqual((await unlockVault(v2, 'correct horse battery')).data, more);
  const { vault: v3, dataKey: newKey } = await changePassword(v2, 'correct horse battery', 'a brand new password');
  await assert.rejects(unlockVault(v3, 'correct horse battery'), /wrong password/);
  assert.deepEqual((await unlockVault(v3, 'a brand new password')).data, more);
  assert.notDeepEqual(newKey, dataKey, 'a new password brings a new data key');
  await assert.rejects(readVault(v3, dataKey), undefined, 'the old data key opens nothing');
  await assert.rejects(changePassword(v3, 'wrong old password', 'whatever else'), /wrong password/);
});
