// Sends that spend from both of a wallet's addresses: bc1q coins signed with BIP-143, bc1p coins on the taproot key
// path with BIP-341, change back to bc1q, the fee covering p2tr inputs' real size. Checked with bitcoinjs-lib (it reads
// the transaction, recomputes every sighash) and noble (every signature verifies for the coin it spends), and every
// input's signer counted: the wallet's own key, nobody else's, and nothing signed before plum.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction, address as baddress, initEccLib, payments } from 'bitcoinjs-lib';
import { hex } from '../src/shared/bytes.js';
import { addressOf, btcPublicKey, hash160, signBtcDigest } from '../src/background/keys.js';
import { signKeyPath, taprootAddressOf } from '../src/background/taproot.js';
import * as B from '../src/background/btc.js';

const N = secp256k1.Point.CURVE().n;
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

const sha = (s) => createHash('sha256').update(s).digest();
const bytesOf = (label, n = 32) => Uint8Array.from(sha(label)).subarray(0, n);
const SEG_KEY = bytesOf('segwit key'), TR_KEY = bytesOf('taproot key');
const OWNER = { segwit: addressOf('btc', SEG_KEY), taproot: taprootAddressOf(TR_KEY) };
const SEG_SCRIPT = B.addressScript(OWNER.segwit).script, TR_SCRIPT = B.addressScript(OWNER.taproot).script;
const DEST = {
  p2wpkh: payments.p2wpkh({ hash: bytesOf('to wpkh', 20) }).address,
  p2tr: baddress.toBech32(btcPublicKey(bytesOf('to tr')).subarray(1), 1, 'bc'),
  p2pkh: payments.p2pkh({ hash: bytesOf('to pkh', 20) }).address,
  p2sh: payments.p2sh({ hash: bytesOf('to sh', 20) }).address,
  p2wsh: payments.p2wsh({ hash: bytesOf('to wsh') }).address,
};
const coin = (label, value, kind, { confirmed = true, vout = 0 } = {}) => ({ txid: hex(bytesOf(`coin ${label}`)), vout, value: BigInt(value), confirmed, kind, address: kind === 'p2tr' ? OWNER.taproot : OWNER.segwit });

/** The wallet's signBitcoinAs for this test's two keys. */
function wallet() {
  const calls = [];
  const sign = async (address, digests) => {
    calls.push(address);
    if (address === OWNER.segwit) return { publicKey: btcPublicKey(SEG_KEY), signatures: digests.map((d) => signBtcDigest(d, SEG_KEY)) };
    if (address === OWNER.taproot) return signKeyPath(digests, TR_KEY);
    throw new Error('not ours');
  };
  return { sign, calls };
}

/** Everything a signed send must be. Returns the bitcoinjs transaction. */
async function checkSpend(p, feeRate, label) {
  const w = wallet();
  const out = await B.signSpend(p, OWNER, w.sign);
  const tx = Transaction.fromHex(out.raw);
  assert.equal(tx.getId(), out.txid, label);
  assert.equal(tx.virtualSize(), out.vsize, label);
  const prevScripts = p.inputs.map((c) => (c.kind === 'p2tr' ? TR_SCRIPT : SEG_SCRIPT));
  const values = p.inputs.map((c) => c.value);
  const trOutputKey = TR_SCRIPT.subarray(2);
  tx.ins.forEach((input, i) => {
    const c = p.inputs[i];
    assert.equal(hex(Buffer.from(input.hash).reverse()), c.txid);
    assert.equal(input.sequence, 0xfffffffd);
    assert.equal(input.script.length, 0);
    // the signer of every input: the wallet's own key for that coin, and only it
    if (c.kind === 'p2tr') {
      assert.equal(input.witness.length, 1, `${label}: a key-path spend is one 64-byte signature`);
      assert.equal(input.witness[0].length, 64);
      const digest = tx.hashForWitnessV1(i, prevScripts, values, Transaction.SIGHASH_DEFAULT);
      assert.ok(schnorr.verify(input.witness[0], digest, trOutputKey), `${label}: input ${i} verifies for the bc1p output key`);
    } else {
      assert.equal(input.witness.length, 2);
      assert.equal(hex(hash160(input.witness[1])), hex(SEG_SCRIPT.subarray(2)), `${label}: input ${i} is signed by the bc1q key`);
      const digest = tx.hashForWitnessV0(i, B.p2pkhCode(SEG_SCRIPT.subarray(2)), c.value, Transaction.SIGHASH_ALL);
      assert.equal(input.witness[0].at(-1), Transaction.SIGHASH_ALL);
      assert.ok(secp256k1.verify(input.witness[0].subarray(0, -1), digest, input.witness[1], { prehash: false, format: 'der' }), `${label}: input ${i}`);
    }
  });
  // one signer: the wallet (asked once per kind of coin it spends), nothing signed before it
  const kinds = new Set(p.inputs.map((c) => c.kind));
  assert.deepEqual(w.calls, [kinds.has('p2wpkh') ? OWNER.segwit : null, kinds.has('p2tr') ? OWNER.taproot : null].filter(Boolean));
  // outputs as planned; change only ever to bc1q
  tx.outs.forEach((o, i) => { assert.equal(hex(o.script), hex(p.outputs[i].script)); assert.equal(o.value, p.outputs[i].value); });
  for (const o of p.outputs.filter((x) => x.mine)) assert.equal(hex(o.script), hex(SEG_SCRIPT), 'change goes back to bc1q');
  // the planned size is the real one or a little over (DER signatures are 71 or 72 bytes; plum plans for 72)
  const diff = p.vsize - tx.virtualSize();
  assert.ok(diff >= 0 && diff <= Math.max(2, Math.ceil(p.inputs.length / 2)), `${label}: planned ${p.vsize}, real ${tx.virtualSize()}`);
  assert.ok(p.fee >= BigInt(Math.ceil(tx.virtualSize() * feeRate)), `${label}: the fee covers the real size`);
  return tx;
}

test('vsizeOf counts a taproot key-path input as 57.5 vB and a native segwit one as 68', () => {
  assert.equal(B.vsizeOf(['p2tr'], ['p2wpkh']), Math.ceil(10.5 + 57.5 + 31));
  assert.equal(B.vsizeOf(['p2tr', 'p2tr'], ['p2tr', 'p2wpkh']), Math.ceil(10.5 + 115 + 43 + 31));
  assert.equal(B.vsizeOf(['p2wpkh', 'p2tr'], ['p2wpkh']), Math.ceil(10.5 + 68 + 57.5 + 31));
  assert.equal(B.vsizeOf(3, ['p2wpkh']), B.vsizeOf(['p2wpkh', 'p2wpkh', 'p2wpkh'], ['p2wpkh']));
});

test('sends from bc1p coins only, from both kinds mixed, to every kind of address: signed, verified, sized', async () => {
  const sets = {
    taproot: [coin('t1', 150_000, 'p2tr'), coin('t2', 90_000, 'p2tr', { vout: 2 })],
    mixed: [coin('m1', 120_000, 'p2wpkh', { vout: 1 }), coin('m2', 100_000, 'p2tr'), coin('m3', 60_000, 'p2wpkh'), coin('m4', 40_000, 'p2tr', { confirmed: false, vout: 5 })],
  };
  for (const [name, utxos] of Object.entries(sets)) {
    for (const [kind, to] of Object.entries(DEST)) {
      for (const args of [{ amount: 30_000n, feeRate: 3 }, { amount: 200_000n, feeRate: 11.5 }, { amount: 0n, feeRate: 6, max: true }]) {
        const total = utxos.reduce((n, c) => n + c.value, 0n);
        if (!args.max && args.amount + 5_000n > total) continue;
        const p = B.plan({ utxos, to, change: OWNER.segwit, ...args });
        await checkSpend(p, args.feeRate, `${name} to ${kind} ${args.max ? 'max' : args.amount}`);
      }
    }
  }
});

test('several recipients (a site\'s sendTransfer): every one paid exactly, change to bc1q, one signer', async () => {
  const utxos = [coin('r1', 500_000, 'p2tr'), coin('r2', 300_000, 'p2wpkh')];
  const recipients = [{ to: DEST.p2tr, amount: 100_000n }, { to: DEST.p2wpkh, amount: 250_000n }, { to: DEST.p2pkh, amount: 1_000n }];
  const p = B.plan({ utxos, recipients, feeRate: 4, change: OWNER.segwit });
  assert.equal(p.amount, 351_000n);
  assert.deepEqual(p.outputs.slice(0, 3).map((o) => o.value), [100_000n, 250_000n, 1_000n]);
  await checkSpend(p, 4, 'three recipients');
  assert.throws(() => B.plan({ utxos, recipients: [], feeRate: 4, change: OWNER.segwit }), /1 to 20/);
  assert.throws(() => B.plan({ utxos, recipients: Array(21).fill({ to: DEST.p2tr, amount: 1000n }), feeRate: 4, change: OWNER.segwit }), /1 to 20/);
  assert.throws(() => B.plan({ utxos, recipients, feeRate: 4, change: OWNER.segwit, max: true }), /one address/);
  assert.throws(() => B.plan({ utxos, recipients: [{ to: DEST.p2tr, amount: 545n }], feeRate: 4, change: OWNER.segwit }), /at least 546/);
});

test("signSpend refuses a key that isn't the coin's, change that isn't bc1q, and a bc1p owner that isn't taproot", async () => {
  const p = B.plan({ utxos: [coin('x1', 80_000, 'p2tr'), coin('x2', 70_000, 'p2wpkh')], to: DEST.p2wpkh, amount: 100_000n, feeRate: 2, change: OWNER.segwit });
  const other = taprootAddressOf(bytesOf('someone else'));
  const liar = async (address, digests) => (address === OWNER.taproot ? signKeyPath(digests, bytesOf('someone else')) : wallet().sign(address, digests));
  await assert.rejects(B.signSpend(p, OWNER, liar), /isn't this wallet's/);
  await assert.rejects(B.signSpend(p, { ...OWNER, taproot: OWNER.segwit }, wallet().sign), /bc1p/);
  await assert.rejects(B.signSpend(p, { ...OWNER, taproot: other }, wallet().sign), /isn't this wallet's|not ours/);
  // a signature that doesn't verify is caught before anything is written
  const broken = async (address, digests) => {
    const r = await wallet().sign(address, digests);
    if (address === OWNER.taproot) r.signatures = r.signatures.map((s) => Uint8Array.from(s, (b, i) => (i === 10 ? b ^ 1 : b)));
    return r;
  };
  await assert.rejects(B.signSpend(p, OWNER, broken), /did not verify/);
  assert.throws(() => B.plan({ utxos: [coin('y', 50_000, 'p2tr')], to: DEST.p2wpkh, amount: 1000n, feeRate: 2, change: OWNER.taproot }), /native segwit/);
});
