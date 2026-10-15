// Signed messages, checked against BIP-322's own vectors (message hashes, the two virtual transactions' ids, simple
// signatures for bc1q and bc1p addresses, the error cases) and against signatures plum makes; the legacy format checked
// by recovering the key it was made with.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { b64decode, hex, utf8 } from '../src/shared/bytes.js';
import { addressOf, btcPublicKey, parsePrivateKey, signBtcCompact, signBtcDigest } from '../src/background/keys.js';
import { signKeyPath, taprootAddressOf } from '../src/background/taproot.js';
import { txidOf } from '../src/background/btc-tx.js';
import * as M from '../src/background/bip322.js';

const V = JSON.parse(readFileSync(new URL('./vectors/bip322.json', import.meta.url)));
const keyOf = (wif) => parsePrivateKey(wif).secret;

/** The wallet's signBitcoinAs, for one key: its bc1q address, or its bc1p one (BIP-86 key path). */
function signerFor(secret, aux = null) {
  const segwit = addressOf('btc', secret), taproot = taprootAddressOf(secret);
  const calls = [];
  const sign = async (address, digests, { compact = false } = {}) => {
    calls.push({ address, digests, compact });
    if (address !== segwit && address !== taproot) throw new Error("that address isn't one of your wallets");
    if (compact) return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcCompact(d, secret)) };
    if (address === taproot) return signKeyPath(digests, secret, aux);
    return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcDigest(d, secret)) };
  };
  return { segwit, taproot, sign, calls };
}

test("BIP-322's message hashes and the ids of its two virtual transactions", () => {
  for (const v of V.tx_hashes) {
    const { spend } = M.bip322Digest(v.address, utf8(v.message));
    assert.equal(hex(M.messageHash(utf8(v.message))), v.message_hash, v.message);
    assert.equal(txidOf(spend), v.to_spend_tx_hash, v.message);
    assert.equal(txidOf(M.toSign(spend)), v.to_sign_tx_hash, v.message);
  }
});

test("BIP-322's simple signatures verify (with or without the smp prefix); plum's own match them or verify", async () => {
  for (const v of V.simple) {
    const secret = keyOf(v.key);
    const s = signerFor(secret);
    assert.equal(v.type === 'p2tr' ? s.taproot : s.segwit, v.address, 'the vector key opens its address');
    for (const sig of v.signatures) {
      assert.equal(M.verifyBip322(v.address, utf8(v.message), sig), true, `${v.type} ${v.message}`);
      assert.equal(M.verifyBip322(v.address, utf8(v.message), sig.replace(/^smp/, '')), true);
      assert.equal(M.verifyBip322(v.address, utf8(`${v.message}!`), sig), false, 'another message');
    }
    const mine = await M.signBip322(v.address, utf8(v.message), s.sign);
    assert.ok(!mine.startsWith('smp'));
    assert.equal(M.verifyBip322(v.address, utf8(v.message), mine), true);
    // ECDSA is deterministic (RFC 6979): plum's bc1q signature is one of the BIP's own
    if (v.type === 'p2wpkh') assert.ok(v.signatures.map((x) => x.replace(/^smp/, '')).includes(mine), `${v.message}: ${mine}`);
    else assert.equal(b64decode(mine).length, 66, 'one 64-byte item');
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].address, v.address);
  }
});

test("BIP-322's error cases don't verify, and neither does a signature for the other address of the same key", async () => {
  for (const e of V.error) assert.equal(M.verifyBip322(e.address, utf8(e.message), e.signature), false, e.description);
  const secret = keyOf(V.simple[0].key);
  const s = signerFor(secret);
  const sig = await M.signBip322(s.segwit, utf8('hi'), s.sign);
  assert.equal(M.verifyBip322(s.taproot, utf8('hi'), sig), false);
  const tr = await M.signBip322(s.taproot, utf8('hi'), s.sign);
  assert.equal(M.verifyBip322(s.segwit, utf8('hi'), tr), false);
  // only native segwit and taproot addresses
  for (const a of ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3']) {
    await assert.rejects(M.signBip322(a, utf8('hi'), s.sign), /bc1q and bc1p/);
  }
});

test('the to_spend transaction spends nothing that exists, so no signature here can move a coin', () => {
  const { spend } = M.bip322Digest(V.simple[0].address, utf8('send me 1 BTC'));
  assert.equal(spend.inputs[0].txid, '00'.repeat(32));
  assert.equal(spend.inputs[0].vout, 0xffffffff);
  assert.equal(spend.outputs[0].value, 0n);
  const sign = M.toSign(spend);
  assert.deepEqual(sign.outputs, [{ value: 0n, script: Uint8Array.of(0x6a) }]);
});

test('legacy signed messages: BIP-137 headers, recovering the key that made them, for both addresses', async () => {
  const secret = keyOf(V.simple[0].key);
  const s = signerFor(secret);
  for (const [address, lo] of [[s.segwit, 39], [s.taproot, 31]]) {
    for (const message of ['', 'Hello World', 'UTF-8: öäü 测试 😄', 'x'.repeat(300)]) {
      const sig = await M.signLegacy(address, utf8(message), s.sign);
      const r = M.recoverLegacy(utf8(message), sig);
      assert.ok(r, message);
      assert.equal(hex(r.publicKey), hex(secp256k1.getPublicKey(secret, true)));
      assert.ok(r.header >= lo && r.header <= lo + 3, `header ${r.header}`);
      assert.notEqual(hex(M.recoverLegacy(utf8(`${message}.`), sig)?.publicKey ?? new Uint8Array(0)), hex(r.publicKey));
    }
  }
  // the digest is Bitcoin's: sha256d of the varint-prefixed magic and message (a 300-byte message takes a 3-byte varint)
  const { createHash } = await import('node:crypto');
  const dsha = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest('hex');
  assert.equal(hex(M.legacyDigest(utf8('hi'))), dsha(Buffer.concat([Buffer.from([24]), Buffer.from('Bitcoin Signed Message:\n'), Buffer.from([2]), Buffer.from('hi')])));
  assert.equal(hex(M.legacyDigest(utf8('x'.repeat(300)))), dsha(Buffer.concat([Buffer.from([24]), Buffer.from('Bitcoin Signed Message:\n'), Buffer.from([0xfd, 0x2c, 0x01]), Buffer.from('x'.repeat(300))])));
});
