// Taproot and the transaction model, checked against BIP-86's and BIP-341's own vectors and against bitcoinjs-lib:
// internal and output keys, bc1p addresses, the tweaked secret, BIP-341 signature hashes for every sighash type (with
// and without an annex), BIP-143 for every type, reading and writing transactions, ids and sizes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import { Transaction, initEccLib, payments } from 'bitcoinjs-lib';
import { hex } from '../src/shared/bytes.js';
import { seedOf } from '../src/background/keys.js';
import * as T from '../src/background/taproot.js';
import * as X from '../src/background/btc-tx.js';

const h2b = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const sha = (s) => createHash('sha256').update(s).digest();
const bytesOf = (label, n = 32) => {
  const out = [];
  for (let i = 0; out.length < n; i++) out.push(...sha(`${label}/${i}`));
  return Uint8Array.from(out.slice(0, n));
};
const N = secp256k1.Point.CURVE().n;
const ZERO_AUX = new Uint8Array(32);

// bitcoinjs needs an ECC library for taproot: two functions, on noble
initEccLib({
  isXOnlyPoint(x) {
    if (x.length !== 32) return false;
    try { secp256k1.Point.fromBytes(Uint8Array.from([2, ...x])); return true; } catch { return false; }
  },
  xOnlyPointAddTweak(x, tweak) {
    let P;
    try { P = secp256k1.Point.fromBytes(Uint8Array.from([2, ...x])); } catch { return null; }
    const t = BigInt(`0x${hex(tweak)}`);
    if (t >= N) return null;
    const Q = t === 0n ? P : P.add(secp256k1.Point.BASE.multiply(t));
    if (Q.is0()) return null;
    const q = Q.toBytes(true);
    return { parity: q[0] === 3 ? 1 : 0, xOnlyPubkey: q.subarray(1) };
  },
});

test("BIP-86's vectors: the 'abandon' phrase's keys, output keys and bc1p addresses", () => {
  const seed = seedOf('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const vectors = [
    ["m/86'/0'/0'/0/0", 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115', 'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'],
    ["m/86'/0'/0'/0/1", '83dfe85a3151d2517290da461fe2815591ef69f2b18a2ce63f01697a8b313145', 'a82f29944d65b86ae6b5e5cc75e294ead6c59391a1edc5e016e3498c67fc7bbb', 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'],
    ["m/86'/0'/0'/1/0", '399f1b2f4393f29a18c937859c5dd8a77350103157eb880f02e8c08214277cef', '882d74e5d0572d5a816cef0041a96b6c1de832f6f9676d9605c44d5e9a97d3dc', 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7'],
  ];
  for (const [path, internal, output, address] of vectors) {
    const secret = HDKey.fromMasterSeed(seed).derive(path).privateKey;
    assert.equal(hex(T.internalKey(secret)), internal, path);
    assert.equal(hex(T.outputKey(h2b(internal)).x), output, path);
    assert.equal(T.taprootAddress(h2b(output)), address, path);
    assert.equal(T.taprootAddressOf(secret), address, path);
    assert.equal(hex(T.taprootScript(h2b(output))), `5120${output}`);
    // the tweaked secret opens the output key
    assert.equal(hex(schnorr.getPublicKey(T.tweakSecret(secret))), output, path);
  }
});

const KEYPATH = JSON.parse(readFileSync(new URL('./vectors/bip341-keypath.json', import.meta.url)));

test("BIP-341's key path vectors: every input's signature hash; the BIP-86 one's tweak and signature, byte for byte", () => {
  const tx = X.parseTx(h2b(KEYPATH.rawUnsignedTx));
  assert.equal(hex(X.serializeTx(tx)), KEYPATH.rawUnsignedTx, 'written back the same');
  const prevouts = KEYPATH.utxosSpent.map(([value, script]) => ({ value: BigInt(value), script: h2b(script) }));
  let signed = 0;
  for (const [index, type, priv, merkleRoot, sigHash, tweaked, witness] of KEYPATH.inputs) {
    assert.equal(hex(X.sighashV1(tx, index, prevouts, type)), sigHash, `input ${index}, type ${type}`);
    if (merkleRoot !== null) continue; // a script tree: not a BIP-86 key, plum never makes one
    assert.equal(hex(T.tweakSecret(h2b(priv))), tweaked);
    const { outputKey, signatures } = T.signKeyPath([h2b(sigHash)], h2b(priv), ZERO_AUX);
    assert.equal(hex(prevouts[index].script.subarray(2)), hex(outputKey), 'it signs for the coin it spends');
    // a non-default type carries its byte after the 64-byte signature
    assert.equal(hex(signatures[0]) + (type ? type.toString(16).padStart(2, '0') : ''), witness);
    signed++;
  }
  assert.equal(signed, 1);
  // the fully signed transaction reads and writes back the same, with its witnesses
  const full = X.parseTx(h2b(KEYPATH.fullySignedTx));
  assert.equal(hex(X.serializeTx(full)), KEYPATH.fullySignedTx);
  assert.equal(X.txidOf(full), Transaction.fromHex(KEYPATH.fullySignedTx).getId());
});

/** A random transaction: inputs and outputs of every kind, bitcoinjs's and plum's views of it. */
function randomTx(label, nIn, nOut) {
  const t = new Transaction();
  t.version = 2;
  t.locktime = Number.parseInt(hex(bytesOf(`${label} lock`, 3)), 16);
  const prevouts = [];
  for (let i = 0; i < nIn; i++) {
    t.addInput(bytesOf(`${label} in ${i}`), i * 3 + 1, i % 2 ? 0xfffffffd : 0xffffffff - i);
    const kind = i % 3;
    const script = kind === 0 ? Uint8Array.from([0x51, 0x20, ...bytesOf(`${label} tr ${i}`)]) : kind === 1 ? Uint8Array.from([0x00, 0x14, ...bytesOf(`${label} wpkh ${i}`, 20)]) : Uint8Array.from([0x76, 0xa9, 0x14, ...bytesOf(`${label} pkh ${i}`, 20), 0x88, 0xac]);
    prevouts.push({ value: BigInt(1000 + i * 77_777), script });
  }
  for (let i = 0; i < nOut; i++) t.addOutput(Uint8Array.from([0x00, 0x14, ...bytesOf(`${label} out ${i}`, 20)]), BigInt(546 + i * 12_345));
  return { t, prevouts, tx: X.parseTx(h2b(t.toHex())) };
}

test('BIP-341 signature hashes match bitcoinjs for every type, every input, with and without an annex', () => {
  for (const [nIn, nOut] of [[1, 1], [3, 2], [5, 5], [2, 4], [7, 3]]) {
    const { t, prevouts, tx } = randomTx(`v1 ${nIn} ${nOut}`, nIn, nOut);
    for (let i = 0; i < nIn; i++) {
      // a taproot signature is only ever made for a taproot input (bitcoinjs assumes its 34-byte script)
      if (prevouts[i].script[0] !== 0x51) continue;
      for (const type of X.V1_TYPES) {
        if ((type & 3) === X.SIGHASH.SINGLE && i >= nOut) {
          assert.throws(() => X.sighashV1(tx, i, prevouts, type), /SINGLE/);
          continue;
        }
        const theirs = t.hashForWitnessV1(i, prevouts.map((p) => p.script), prevouts.map((p) => p.value), type);
        assert.equal(hex(X.sighashV1(tx, i, prevouts, type)), hex(theirs), `${nIn}x${nOut} input ${i} type ${type}`);
        const annex = Uint8Array.from([0x50, ...bytesOf(`annex ${i} ${type}`, 7)]);
        const withAnnex = t.hashForWitnessV1(i, prevouts.map((p) => p.script), prevouts.map((p) => p.value), type, undefined, annex);
        assert.equal(hex(X.sighashV1(tx, i, prevouts, type, { annex })), hex(withAnnex), `annex, input ${i} type ${type}`);
      }
    }
  }
  const { tx, prevouts } = randomTx('bad', 2, 2);
  for (const type of [0x04, 0x80, 0x84, 0xff, 0x41]) assert.throws(() => X.sighashV1(tx, 0, prevouts, type), /isn't one plum signs/);
  assert.throws(() => X.sighashV1(tx, 0, prevouts.slice(1), 1), /every input/);
});

test('BIP-143 signature hashes match bitcoinjs for every type (SINGLE past the last output signs no output)', () => {
  for (const [nIn, nOut] of [[1, 1], [3, 2], [4, 1]]) {
    const { t, prevouts, tx } = randomTx(`v0 ${nIn} ${nOut}`, nIn, nOut);
    for (let i = 0; i < nIn; i++) {
      const scriptCode = Uint8Array.from([0x76, 0xa9, 0x14, ...bytesOf(`code ${i}`, 20), 0x88, 0xac]);
      for (const type of X.V0_TYPES) {
        const theirs = t.hashForWitnessV0(i, scriptCode, prevouts[i].value, type);
        assert.equal(hex(X.sighashV0(tx, i, scriptCode, prevouts[i].value, type)), hex(theirs), `${nIn}x${nOut} input ${i} type ${type}`);
      }
    }
    for (const type of [0x00, 0x04, 0x80, 0x41]) assert.throws(() => X.sighashV0(tx, 0, new Uint8Array(25), 1n, type), /isn't one plum signs/);
  }
});

test('transactions read and write as bitcoinjs does: ids, sizes, witnesses, long compact sizes', () => {
  for (const [nIn, nOut] of [[1, 1], [2, 3], [300, 2], [1, 260]]) {
    const { t } = randomTx(`rw ${nIn} ${nOut}`, nIn, nOut);
    t.ins.forEach((input, i) => { if (i % 2 === 0) input.witness = [bytesOf(`w ${i}`, 64 + (i % 9)), bytesOf(`p ${i}`, 33)]; });
    const raw = t.toHex();
    const tx = X.parseTx(h2b(raw));
    assert.equal(hex(X.serializeTx(tx)), raw);
    assert.equal(X.txidOf(tx), t.getId());
    const size = X.sizeOf(tx);
    assert.equal(size.vsize, t.virtualSize());
    assert.equal(size.weight, t.weight());
    assert.equal(X.serializeTx(tx, { witness: false }).length, t.byteLength(false));
    assert.equal(hex(X.serializeTx(tx, { witness: false })), hex(X.serializeTx({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, witness: [] })) })));
  }
});

test('parseTx refuses what is not one transaction exactly', () => {
  const { t } = randomTx('refuse', 2, 2);
  const raw = h2b(t.toHex());
  assert.throws(() => X.parseTx(raw.subarray(0, raw.length - 1)), /too soon/);
  assert.throws(() => X.parseTx(Uint8Array.from([...raw, 0])), /after its end/);
  assert.throws(() => X.parseTx(Uint8Array.from([2, 0, 0, 0, 0, 2, 0])), /flag/);
  assert.throws(() => X.parseTx(Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /flag|no inputs/);
  // a count written the long way (0xfd 0x02 0x00 for 2)
  const long = Uint8Array.from([...raw.subarray(0, 4), 0xfd, 0x02, 0x00, ...raw.subarray(5)]);
  assert.throws(() => X.parseTx(long), /long way/);
  // an output worth more than every bitcoin
  const big = new Transaction();
  big.addInput(bytesOf('big'), 0);
  big.addOutput(Uint8Array.of(0x6a), X.MAX_MONEY + 1n);
  assert.throws(() => X.parseTx(h2b(big.toHex())), /all the bitcoin/);
});

test('bitcoinjs makes the same bc1p address from the internal key (150 random keys), and the tweak is the one BIP-341 adds', () => {
  for (let i = 0; i < 150; i++) {
    const secret = bytesOf(`tr key ${i}`);
    const internal = T.internalKey(secret);
    const { address, pubkey } = payments.p2tr({ internalPubkey: internal });
    assert.equal(T.taprootAddressOf(secret), address);
    assert.equal(hex(T.outputKey(internal).x), hex(pubkey));
    const k = T.tweakSecret(secret);
    assert.equal(hex(schnorr.getPublicKey(k)), hex(pubkey));
  }
  assert.throws(() => T.tweakSecret(new Uint8Array(32)), /range/);
  assert.throws(() => T.tweakSecret(h2b(N.toString(16))), /range/);
  assert.throws(() => T.outputKey(new Uint8Array(31)), /32 bytes/);
});

test('signKeyPath: BIP-340 signatures that verify for the output key, fresh randomness each time, nothing else', () => {
  const secret = bytesOf('signer');
  const digests = [bytesOf('d1'), bytesOf('d2')];
  const a = T.signKeyPath(digests, secret);
  const b = T.signKeyPath(digests, secret);
  assert.equal(hex(a.outputKey), hex(T.outputKey(T.internalKey(secret)).x));
  a.signatures.forEach((s, i) => {
    assert.equal(s.length, 64);
    assert.ok(schnorr.verify(s, digests[i], a.outputKey));
    assert.ok(T.verifyKeyPath(s, digests[i], a.outputKey));
    assert.ok(!T.verifyKeyPath(s, digests[1 - i], a.outputKey));
    // the internal key is not the one that signs
    assert.ok(!T.verifyKeyPath(s, digests[i], T.internalKey(secret)));
  });
  assert.notEqual(hex(a.signatures[0]), hex(b.signatures[0]), 'auxiliary randomness differs between calls');
  assert.throws(() => T.signKeyPath([new Uint8Array(31)], secret), /32-byte/);
});
