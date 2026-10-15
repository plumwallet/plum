// One signer: every Bitcoin transaction plum builds needs the wallet's signature and nobody else's, and nothing in it
// is signed before plum signs it. Counted here for each kind plum makes, in its real background: a send from the
// popup (bc1q and bc1p coins together), a site's sendTransfer, a BIP-322 message's to_sign transaction; and for a
// site's PSBT, plum adds signatures to the wallet's own inputs only and leaves everyone else's as they came.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { b64decode, hex, utf8 } from '../src/shared/bytes.js';
import { bip322Digest, toSign } from '../src/background/bip322.js';
import { addressScript } from '../src/background/btc.js';
import { serializeTx, txidOf } from '../src/background/btc-tx.js';
import { hash160 } from '../src/background/keys.js';
import { fakeNet } from './fake-net.mjs';
import { boot, sleep } from './redteam/helpers.mjs';
import { buildPsbt, p2wpkhAddress, stranger, txidOf as txidLabel } from './btc-helpers.mjs';

const SEGWIT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const SEG_SCRIPT = addressScript(SEGWIT).script, TR_SCRIPT = addressScript(TAPROOT).script;
const WALLET_KEYS = new Set([hex(SEG_SCRIPT.subarray(2)), hex(TR_SCRIPT.subarray(2))]);

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, fake, _test } = ctx;

/**
 * Who signed each input of a network transaction: a native segwit input by the key in its witness (as its hash), a
 * taproot one by the output key its signature verifies for. Returns the set of signers, 'wallet' for the wallet's.
 */
function signersOf(tx, prevouts) {
  const out = new Set();
  tx.ins.forEach((input, i) => {
    const script = prevouts[i].script;
    if (script[0] === 0x00) {
      assert.equal(input.witness.length, 2, `input ${i}: one signature and its key`);
      const who = hex(hash160(input.witness[1]));
      assert.equal(who, hex(script.subarray(2)), `input ${i} is signed by the key it pays to`);
      const digest = tx.hashForWitnessV0(i, Uint8Array.from([0x76, 0xa9, 0x14, ...script.subarray(2), 0x88, 0xac]), prevouts[i].value, input.witness[0].at(-1));
      assert.ok(secp256k1.verify(input.witness[0].subarray(0, -1), digest, input.witness[1], { prehash: false, format: 'der' }));
      out.add(WALLET_KEYS.has(who) ? 'wallet' : who);
    } else {
      assert.equal(input.witness.length, 1, `input ${i}: one key-path signature`);
      const sig = input.witness[0];
      const digest = tx.hashForWitnessV1(i, prevouts.map((p) => p.script), prevouts.map((p) => p.value), sig.length === 65 ? sig[64] : 0);
      const key = script.subarray(2);
      assert.ok(schnorr.verify(sig.subarray(0, 64), digest, key), `input ${i} verifies for its output key`);
      out.add(WALLET_KEYS.has(hex(key)) ? 'wallet' : hex(key));
    }
  });
  return out;
}

async function approve(kind) {
  const until = Date.now() + 2000;
  let r;
  while (!(r = [..._test.pending.values()].find((x) => x.kind === kind)) && Date.now() < until) await sleep(5);
  if ((await ok('approval.get')).txCount) await ok('approval.preview', { id: r.id });
  await ok('approval.resolve', { id: r.id, approve: true });
}

test('setup', async () => { await ctx.setup(); });

test("plum's own send, from bc1q and bc1p coins together: one signer, the wallet", async () => {
  net.btc.utxos.set(SEGWIT, [{ txid: 'd1'.repeat(32), vout: 0, value: 30_000 }]);
  net.btc.utxos.set(TAPROOT, [{ txid: 'd2'.repeat(32), vout: 2, value: 45_000 }]);
  const prep = await ok('send.prepare', { chain: 'btc', to: p2wpkhAddress('friend'), amount: '0.0006' });
  assert.equal(prep.preview.inputs, 2);
  await ok('send.submit', { id: prep.id });
  const tx = Transaction.fromHex(net.btc.broadcast.at(-1));
  const prevouts = tx.ins.map((i) => (hex(Buffer.from(i.hash).reverse()) === 'd2'.repeat(32) ? { script: TR_SCRIPT, value: 45_000n } : { script: SEG_SCRIPT, value: 30_000n }));
  assert.deepEqual([...signersOf(tx, prevouts)], ['wallet']);
});

test("a site's sendTransfer: one signer, the wallet", async () => {
  const page = fake.page('https://signers.example/');
  const c = page.request('btc', { method: 'getAddresses', params: {} });
  await approve('btcConnect');
  await c;
  net.btc.utxos.set(SEGWIT, [{ txid: 'e1'.repeat(32), vout: 1, value: 25_000 }]);
  net.btc.utxos.set(TAPROOT, [{ txid: 'e2'.repeat(32), vout: 0, value: 25_000 }]);
  const answer = page.request('btc', { method: 'sendTransfer', params: { recipients: [{ address: stranger('payee').address, amount: 40_000 }] } });
  await approve('btcSend');
  const { result } = await answer;
  const tx = Transaction.fromHex(net.btc.broadcast.at(-1));
  assert.equal(tx.getId(), result.txid);
  const prevouts = tx.ins.map((i) => (hex(Buffer.from(i.hash).reverse()) === 'e2'.repeat(32) ? { script: TR_SCRIPT, value: 25_000n } : { script: SEG_SCRIPT, value: 25_000n }));
  assert.deepEqual([...signersOf(tx, prevouts)], ['wallet']);
});

test("a BIP-322 message: its to_sign transaction has one input, the wallet's signature, and can't be sent", async () => {
  const page = fake.page('https://signers.example/');
  for (const address of [SEGWIT, TAPROOT]) {
    const answer = page.request('btc', { method: 'signMessage', params: { address, message: 'one signer' } });
    await approve('btcMessage');
    const { result } = await answer;
    const { spend, script } = bip322Digest(address, utf8('one signer'));
    const w = b64decode(result.signature);
    // the witness, read back into the to_sign transaction
    const items = [];
    for (let at = 1, n = w[0]; n; n--) { items.push(w.subarray(at + 1, at + 1 + w[at])); at += 1 + w[at]; }
    const t = toSign(spend, items);
    const tx = Transaction.fromHex(hex(serializeTx(t)));
    assert.equal(tx.ins.length, 1);
    assert.deepEqual([...signersOf(tx, [{ script, value: 0n }])], ['wallet']);
    assert.equal(hex(Buffer.from(tx.ins[0].hash).reverse()), txidOf(spend), 'it spends to_spend, which spends nothing that exists');
    assert.equal(spend.inputs[0].txid, '00'.repeat(32));
  }
});

test("a site's PSBT: plum signs the wallet's inputs only; the seller's signature and every other input come back untouched", async () => {
  const page = fake.page('https://signers.example/');
  const seller = stranger('signer seller');
  const built = buildPsbt({
    inputs: [
      { txid: txidLabel('sg pay'), vout: 0, value: 200_000n, script: SEG_SCRIPT },
      { txid: txidLabel('sg insc'), vout: 1, value: 546n, script: seller.script, sighashType: 0x83 },
      { txid: txidLabel('sg other'), vout: 2, value: 10_000n, script: stranger('third').script },
    ],
    outputs: [{ address: TAPROOT, value: 546n }, { address: seller.address, value: 150_000n }, { address: SEGWIT, value: 59_000n }],
  });
  built.psbt.updateInput(1, { tapKeySig: Buffer.from([...new Uint8Array(64).fill(7), 0x83]) });
  // the coins on the chain, so plum can check what each input spends
  for (const [op, prev] of built.chain) {
    const [txid, vout] = op.split(':');
    const outs = [];
    outs[Number(vout)] = { scriptpubkey: hex(prev.script), value: Number(prev.value) };
    for (let i = 0; i < outs.length; i++) outs[i] ??= { scriptpubkey: '6a', value: 0 };
    net.btc.txs.set(txid, outs);
  }
  const before = Psbt.fromBase64(built.psbt.toBase64());
  const answer = page.request('btc', { method: 'signPsbt', params: { psbt: built.psbt.toBase64(), signInputs: { [SEGWIT]: [0] } } });
  await approve('btcPsbt');
  const after = Psbt.fromBase64((await answer).result.psbt);
  assert.equal(after.data.inputs[0].partialSig.length, 1);
  assert.equal(hex(hash160(after.data.inputs[0].partialSig[0].pubkey)), hex(SEG_SCRIPT.subarray(2)), "the one signature added is the wallet's");
  assert.equal(hex(after.data.inputs[1].tapKeySig), hex(before.data.inputs[1].tapKeySig), "the seller's signature is as it came");
  assert.deepEqual(after.data.inputs[2], before.data.inputs[2], 'the third input is as it came');
  assert.equal(after.data.inputs[1].partialSig, undefined);
  assert.equal(after.data.inputs[2].tapKeySig, undefined);
});
