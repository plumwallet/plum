// Every wallet's taproot address, in plum's real background on the fake browser: made beside the bc1q one from the
// phrase's BIP-86 key (or an imported key itself), shown before an import, filled in for wallets made before taproot,
// put right when the profile on disk is edited, and signing with the tweaked key only for the address it opens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '../src/shared/bytes.js';
import { secretAt, seedOf } from '../src/background/keys.js';
import { outputKey, taprootAddressOf } from '../src/background/taproot.js';
import { ABANDON, PASSWORD, boot } from './redteam/helpers.mjs';

const TR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'; // BIP-86's m/86'/0'/0'/0/0
const TR2 = 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh';
const SEGWIT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

const ctx = await boot();
const { ok, fake } = ctx;
const W = await import('../src/background/wallet.js');

test('a restored phrase: wallet 1 has its bc1q address and its BIP-86 bc1p one, with their public keys', async () => {
  const s = await ctx.setup();
  const btc = s.wallets[0].chains.btc;
  assert.equal(btc.address, SEGWIT);
  assert.equal(btc.path, "m/84'/0'/0'/0/0");
  assert.equal(btc.publicKey, '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c');
  assert.deepEqual(btc.taproot, { address: TR, path: "m/86'/0'/0'/0/0", publicKey: 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115' });
  // + new wallet: wallet 2's taproot address is BIP-86's second
  const after = await ok('wallet.add', { account: s.accounts[0].id });
  const w2 = after.wallets.find((w) => w.index === 1);
  assert.equal(w2.chains.btc.taproot.address, TR2);
  assert.equal(w2.chains.btc.taproot.path, "m/86'/0'/0'/0/1");
  await ok('wallet.remove', { id: w2.id });
  await ok('wallet.select', { id: s.wallets[0].id });
});

test('a wallet from before taproot gets its bc1p address at the next unlock; a planted one is put right', async () => {
  const list = await fake.browser.storage.local.get('wallets').then((x) => x.wallets);
  const { taproot, publicKey, ...old } = list[0].chains.btc;
  await fake.browser.storage.local.set({ wallets: [{ ...list[0], chains: { ...list[0].chains, btc: old } }, ...list.slice(1)] });
  await ok('lock');
  await ok('unlock', { password: PASSWORD });
  let w = (await ok('state')).wallets[0];
  assert.equal(w.chains.btc.taproot.address, TR);
  assert.equal(w.chains.btc.publicKey, publicKey);
  // someone who can edit the profile swaps in their own taproot address and key, to receive what sites send there
  const attacker = taprootAddressOf(new Uint8Array(32).fill(9));
  const now = await fake.browser.storage.local.get('wallets').then((x) => x.wallets);
  await fake.browser.storage.local.set({ wallets: [{ ...now[0], chains: { ...now[0].chains, btc: { ...now[0].chains.btc, taproot: { address: attacker, path: "m/86'/0'/0'/0/0", publicKey: 'ab'.repeat(32) } } } }, ...now.slice(1)] });
  // while it's on disk, plum refuses to sign for it
  await assert.rejects(W.signBitcoinAs(attacker, [new Uint8Array(32)]), /doesn't match its recovery phrase/);
  await ok('lock');
  await ok('unlock', { password: PASSWORD });
  w = (await ok('state')).wallets[0];
  assert.equal(w.chains.btc.taproot.address, TR);
  assert.equal(w.chains.btc.taproot.publicKey, 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115');
});

test('signBitcoinAs: Schnorr by the tweaked key for the bc1p address, ECDSA by the segwit key for the bc1q one, nothing for others', async () => {
  const digest = Uint8Array.from(sha256(new TextEncoder().encode('a sighash')));
  const tr = await W.signBitcoinAs(TR, [digest]);
  const secret = secretAt(seedOf(ABANDON), 'btc', "m/86'/0'/0'/0/0");
  const q = outputKey(schnorr.getPublicKey(secret)).x;
  assert.equal(hex(tr.outputKey), hex(q));
  assert.equal(tr.signatures[0].length, 64);
  assert.ok(schnorr.verify(tr.signatures[0], digest, q));
  const sw = await W.signBitcoinAs(SEGWIT, [digest]);
  assert.equal(hex(sw.publicKey), '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c');
  assert.equal(sw.signatures[0][0], 0x30, 'DER');
  const compact = await W.signBitcoinAs(TR, [digest], { compact: true });
  assert.equal(hex(compact.publicKey), hex(secp256k1.getPublicKey(secret, true)), 'the taproot key itself, not the tweaked one');
  const { recovery, r, s } = compact.signatures[0];
  assert.ok(recovery === 0 || recovery === 1);
  const sig = new secp256k1.Signature(BigInt(`0x${hex(r)}`), BigInt(`0x${hex(s)}`)).addRecoveryBit(recovery);
  assert.equal(sig.recoverPublicKey(digest).toHex(true), hex(compact.publicKey));
  for (const nope of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', taprootAddressOf(new Uint8Array(32).fill(3)), '', null, { toString: () => TR }]) {
    await assert.rejects(W.signBitcoinAs(nope, [digest]), /isn't one of your wallets/, String(nope));
  }
  await ok('lock');
  await assert.rejects(W.signBitcoinAs(TR, [digest]), /locked/);
  await ok('unlock', { password: PASSWORD });
});

test('an imported Bitcoin key: its bc1q and bc1p addresses (the key itself on the key path), shown first, both signed for', async () => {
  const key = Uint8Array.from(sha256(new TextEncoder().encode('an electrum key')));
  const wif = createBase58check(sha256).encode(Uint8Array.from([0x80, ...key, 1]));
  const info = await ok('checkKey', { secret: wif });
  assert.equal(info.taproot, taprootAddressOf(key));
  const s = await ok('importKey', { secret: wif, name: 'electrum' });
  const w = s.wallets.find((x) => x.name === 'electrum');
  assert.equal(w.chains.btc.taproot.address, taprootAddressOf(key));
  assert.equal(w.chains.btc.taproot.path, null);
  const digest = new Uint8Array(32).fill(5);
  const r = await W.signBitcoinAs(w.chains.btc.taproot.address, [digest]);
  assert.ok(schnorr.verify(r.signatures[0], digest, outputKey(schnorr.getPublicKey(key)).x));
  // it survives a lock and unlock unchanged
  await ok('lock');
  await ok('unlock', { password: PASSWORD });
  assert.deepEqual((await ok('state')).wallets.find((x) => x.id === w.id).chains.btc, w.chains.btc);
  await ok('wallet.remove', { id: w.id });
});

test("sending to the wallet's own bc1p address: a warning, and the address counts as one plum knows", async () => {
  const { fakeNet } = await import('./fake-net.mjs');
  const net = fakeNet();
  const real = globalThis.fetch;
  globalThis.fetch = net.fetch;
  try {
    net.btc.utxos.set(SEGWIT, [{ txid: '77'.repeat(32), vout: 0, value: 90_000 }]);
    const own = await ok('send.prepare', { chain: 'btc', to: TR, amount: '0.0001' });
    assert.ok(own.warnings.some((w) => w.level === 'warn' && /own taproot address/.test(w.text)), JSON.stringify(own.warnings));
    assert.ok(!own.warnings.some((w) => /haven't sent to this address/.test(w.text)), 'its own address is known');
  } finally { globalThis.fetch = real; }
});
