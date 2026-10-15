// PSBTs: plum's hand-written BIP-174 reader and writer against bitcoinjs-lib's, and the review and signatures for a
// site's PSBT: which inputs are the wallet's, what leaves and what comes back, the fee, each sighash type, finalizing
// and extracting. bitcoinjs checks every signature plum puts in and finalizes and extracts the same transaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { hex } from '../src/shared/bytes.js';
import { SIGHASH } from '../src/background/btc-tx.js';
import { decodePsbt, encodePsbt, extractTx } from '../src/background/psbt.js';
import { reviewPsbt, signPsbt } from '../src/background/btc-psbt.js';
import { buildPsbt, makeWallet, p2trAddress, p2wpkhAddress, prevTx, stranger, txidOf, validator } from './btc-helpers.mjs';

const me = makeWallet('psbt me');
const MERCHANT = p2wpkhAddress('merchant');

test("plum reads bitcoinjs's PSBTs and writes them back byte for byte, every record kept", async () => {
  const prev = await prevTx('rt', [{ script: me.segScript, value: 70_000n }, { script: me.trScript, value: 5_000n }]);
  const { bytes, decoded } = buildPsbt({
    inputs: [
      { txid: txidOf('a'), vout: 1, value: 100_000n, script: me.segScript, sighashType: 1 },
      { txid: prev.txid, vout: 0, value: 70_000n, script: me.segScript, nonWitness: prev.raw },
      { txid: txidOf('b'), vout: 3, value: 40_000n, script: me.trScript, tapInternalKey: Buffer.from(me.owner.taprootKey, 'hex') },
    ],
    outputs: [{ address: MERCHANT, value: 150_000n }, { address: me.owner.segwit, value: 55_000n }],
  });
  assert.equal(hex(encodePsbt(decoded)), hex(bytes));
  assert.equal(decoded.tx.inputs.length, 3);
  assert.equal(decoded.inputs[0].sighashType, 1);
  assert.equal(decoded.inputs[1].nonWitnessUtxo.outputs[0].value, 70_000n);
  assert.equal(hex(decoded.inputs[2].tapInternalKey), me.owner.taprootKey);
  assert.equal(decoded.tx.outputs[0].value, 150_000n);
});

test('a payment from both addresses: reviewed (leaves, back, fee), signed, checked by bitcoinjs, finalized, extracted', async () => {
  const built = buildPsbt({
    inputs: [
      { txid: txidOf('p1'), vout: 0, value: 120_000n, script: me.segScript },
      { txid: txidOf('p2'), vout: 2, value: 80_000n, script: me.trScript },
    ],
    outputs: [{ address: MERCHANT, value: 150_000n }, { address: me.owner.segwit, value: 49_000n }],
  });
  const r = reviewPsbt(built.decoded, { owner: me.owner, chain: built.chain, rates: { fast: 10, normal: 5, slow: 2 } });
  assert.deepEqual(r.inputs.map((x) => [x.mine, x.sign, x.verified, x.sighash]), [['p2wpkh', true, 'chain', SIGHASH.ALL], ['p2tr', true, 'chain', SIGHASH.DEFAULT]]);
  assert.equal(r.leaves, 200_000n);
  assert.equal(r.arrives, 49_000n);
  assert.equal(r.net, -151_000n);
  assert.equal(r.fee, 1_000n);
  assert.equal(r.toOthers, 150_000n);
  assert.ok(r.complete);
  assert.deepEqual(r.warnings, []);
  const signed = await signPsbt(built.decoded, r, me.owner, me.sign);
  const theirs = Psbt.fromBase64(Buffer.from(signed).toString('base64'));
  assert.ok(theirs.validateSignaturesOfInput(0, validator));
  assert.ok(theirs.validateSignaturesOfInput(1, validator));
  theirs.finalizeAllInputs();
  const tx = theirs.extractTransaction();
  // plum's own finalizer and extractor give the same transaction
  const again = decodePsbt(await signPsbt(decodePsbt(built.bytes), reviewPsbt(decodePsbt(built.bytes), { owner: me.owner, chain: built.chain }), me.owner, me.sign, { finalize: true }));
  const mine = extractTx(again);
  assert.equal(mine.txid, tx.getId());
  assert.equal(Transaction.fromHex(mine.raw).getId(), tx.getId());
  // one signer: the wallet, once per kind of coin
  assert.deepEqual(me.calls.slice(-2).map((c) => c.address), [me.owner.segwit, me.owner.taproot]);
});

test('only the inputs asked for, each for the address named; every sighash type signed as asked and named', async () => {
  for (const type of [0x01, 0x02, 0x03, 0x81, 0x82, 0x83]) {
    for (const kind of ['p2wpkh', 'p2tr']) {
      const script = kind === 'p2tr' ? me.trScript : me.segScript;
      const built = buildPsbt({
        inputs: [{ txid: txidOf(`t${type}${kind}`), vout: 0, value: 50_000n, script, sighashType: type }, { txid: txidOf('other'), vout: 0, value: 10_000n, script: stranger('o').script }],
        outputs: [{ address: MERCHANT, value: 20_000n }, { address: me.owner.segwit, value: 39_000n }],
      });
      const address = kind === 'p2tr' ? me.owner.taproot : me.owner.segwit;
      const r = reviewPsbt(built.decoded, { owner: me.owner, toSign: [{ index: 0, address }], chain: built.chain });
      assert.equal(r.inputs[0].sighash, type);
      assert.equal(r.inputs[1].sign, false);
      assert.equal(r.warnings.some((w) => w.level === 'danger'), type !== 0x01, `type ${type}`);
      const signed = Psbt.fromBase64(Buffer.from(await signPsbt(built.decoded, r, me.owner, me.sign)).toString('base64'));
      assert.ok(signed.validateSignaturesOfInput(0, validator), `${kind} type ${type}`);
      const sig = kind === 'p2tr' ? signed.data.inputs[0].tapKeySig : signed.data.inputs[0].partialSig[0].signature;
      assert.equal(sig.at(-1), type, 'the sighash byte is the one asked for');
    }
  }
});

test('a marketplace listing (SINGLE|ANYONECANPAY): the coin and its inscription leave, the price comes back, named as a sale', async () => {
  const built = buildPsbt({
    inputs: [{ txid: txidOf('listing'), vout: 0, value: 546n, script: me.trScript, sighashType: 0x83 }],
    outputs: [{ address: me.owner.segwit, value: 2_500_000n }],
  });
  const contents = new Map([[`${txidOf('listing')}:0`, { inscriptions: [{ id: `${'ab'.repeat(32)}i0`, offset: 0 }], runes: [] }]]);
  const r = reviewPsbt(built.decoded, { owner: me.owner, chain: built.chain, contents });
  assert.equal(r.fixed, false);
  assert.equal(r.leaves, 546n);
  assert.equal(r.arrives, 2_500_000n);
  assert.ok(r.warnings.some((w) => w.level === 'danger' && /SINGLE\|ANYONECANPAY/.test(w.text) && /sell/.test(w.text)));
  assert.ok(r.warnings.some((w) => w.level === 'danger' && /inscription/.test(w.text) && /leave/.test(w.text)));
  assert.ok(!r.warnings.some((w) => /outputs are worth more/.test(w.text)), "a listing isn't meant to balance");
});

test("a buy: the seller's input already signed and left untouched, the wallet's payment input signed", async () => {
  const seller = stranger('seller');
  const built = buildPsbt({
    inputs: [
      { txid: txidOf('buy pay'), vout: 1, value: 3_000_000n, script: me.segScript },
      { txid: txidOf('buy insc'), vout: 0, value: 546n, script: seller.script, sighashType: 0x83 },
    ],
    outputs: [{ address: me.owner.taproot, value: 546n }, { address: seller.address, value: 2_500_000n }, { address: me.owner.segwit, value: 495_000n }],
  });
  // the seller signed theirs (as the marketplace hands it over)
  const sigOf = async () => {
    const { sighashV1 } = await import('../src/background/btc-tx.js');
    const { schnorr } = await import('@noble/curves/secp256k1.js');
    const d = sighashV1(built.decoded.tx, 1, [...built.chain.values()], 0x83);
    return Uint8Array.from([...schnorr.sign(d, seller.tweaked), 0x83]);
  };
  built.psbt.updateInput(1, { tapKeySig: Buffer.from(await sigOf()) });
  const bytes = Uint8Array.from(Buffer.from(built.psbt.toBase64(), 'base64'));
  const p = decodePsbt(bytes);
  const r = reviewPsbt(p, { owner: me.owner, chain: built.chain });
  assert.deepEqual(r.inputs.map((x) => [x.mine, x.sign, x.signed]), [['p2wpkh', true, false], [null, false, true]]);
  assert.equal(r.leaves, 3_000_000n);
  assert.equal(r.arrives, 495_546n);
  assert.equal(r.fee, 3_000_546n - 2_995_546n);
  assert.ok(r.complete);
  const signed = Psbt.fromBase64(Buffer.from(await signPsbt(p, r, me.owner, me.sign)).toString('base64'));
  assert.ok(signed.validateSignaturesOfInput(0, validator));
  assert.ok(signed.validateSignaturesOfInput(1, validator, Uint8Array.from([2, ...seller.script.subarray(2)])), "the seller's signature is untouched");
  signed.finalizeAllInputs();
  assert.ok(signed.extractTransaction().getId());
});

test('inscriptions are followed by ordinal theory: to the wallet, to someone else, into the fee', async () => {
  const insc = (offset) => new Map([[`${txidOf('flow')}:0`, { inscriptions: [{ id: `${'cd'.repeat(32)}i0`, offset }], runes: [] }]]);
  const make = (outputs) => buildPsbt({ inputs: [{ txid: txidOf('flow'), vout: 0, value: 10_000n, script: me.trScript }], outputs });
  const stay = make([{ address: me.owner.taproot, value: 546n }, { address: MERCHANT, value: 9_000n }]);
  assert.match(reviewPsbt(stay.decoded, { owner: me.owner, chain: stay.chain, contents: insc(0) }).warnings.find((w) => /inscription/.test(w.text)).text, /stays with you/);
  const away = make([{ address: me.owner.taproot, value: 546n }, { address: MERCHANT, value: 9_000n }]);
  assert.match(reviewPsbt(away.decoded, { owner: me.owner, chain: away.chain, contents: insc(600) }).warnings.find((w) => /inscription/.test(w.text)).text, new RegExp(`goes to ${MERCHANT}`));
  const burnt = make([{ address: MERCHANT, value: 5_000n }]);
  assert.match(reviewPsbt(burnt.decoded, { owner: me.owner, chain: burnt.chain, contents: insc(9_999) }).warnings.find((w) => /inscription/.test(w.text)).text, /network fee \(lost/);
});

test('version 2 PSBTs and malformed bytes are refused in plain words', () => {
  const { bytes } = buildPsbt({ inputs: [{ txid: txidOf('m'), vout: 0, value: 1000n, script: me.segScript }], outputs: [{ address: MERCHANT, value: 500n }] });
  assert.throws(() => decodePsbt(bytes.subarray(0, bytes.length - 3)), /malformed/);
  assert.throws(() => decodePsbt(Uint8Array.from([...bytes, 0])), /after its last map/);
  assert.throws(() => decodePsbt(Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0x00, 0])), /magic/);
  assert.throws(() => decodePsbt(new Uint8Array(0)), /empty/);
  assert.throws(() => decodePsbt(new Uint8Array(1_000_001)), /more than plum reads/);
  // a duplicate key in the global map
  const dup = Uint8Array.from([...bytes.subarray(0, 5), 0x02, 0xfc, 0x00, 0x01, 0x01, 0x02, 0xfc, 0x00, 0x01, 0x02, ...bytes.subarray(5)]);
  assert.throws(() => decodePsbt(dup), /same key twice/);
  // a version 2 PSBT (PSBT_GLOBAL_TX_VERSION) and a version record that isn't 0
  const v2 = Uint8Array.from([...bytes.subarray(0, 5), 0x01, 0x02, 0x04, 2, 0, 0, 0, ...bytes.subarray(5)]);
  assert.throws(() => decodePsbt(v2), /version 2/);
  const v1 = Uint8Array.from([...bytes.subarray(0, 5), 0x01, 0xfb, 0x04, 1, 0, 0, 0, ...bytes.subarray(5)]);
  assert.throws(() => decodePsbt(v1), /version 1/);
});
