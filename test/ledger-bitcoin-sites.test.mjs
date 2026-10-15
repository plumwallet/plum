// A Ledger wallet on Bitcoin sites: connecting gives both its addresses with their keys
// with walletType "ledger"; a legacy (ECDSA) message and a sendTransfer plum builds are signed on the device after the
// approval window; BIP-322 messages and a site's own PSBTs are turned down plainly, before any window, and only for a
// connected site (one that isn't learns nothing about the wallet).
import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Transaction } from 'bitcoinjs-lib';
import { concat, hex, u32le, u64le, utf8 } from '../src/shared/bytes.js';
import { recoverLegacy } from '../src/background/bip322.js';
import * as B from '../src/background/btc.js';
import { SIGHASH, sighashV0, sighashV1 } from '../src/background/btc-tx.js';
import { addressOf, hash160, secretAt, seedOf } from '../src/background/keys.js';
import { internalKey, outputKey, taprootAddress, taprootScript } from '../src/background/taproot.js';
import { fakeLedger } from './fake-ledger.mjs';
import { fakeNet } from './fake-net.mjs';
import { boot, sleep } from './redteam/helpers.mjs';

const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const seed = seedOf(LEGAL);
const BTC = addressOf('btc', secretAt(seed, 'btc', "m/84'/0'/0'/0/0"));
const PUB = secp256k1.getPublicKey(secretAt(seed, 'btc', "m/84'/0'/0'/0/0"), true);
const INTERNAL = internalKey(secretAt(seed, 'btc', "m/86'/0'/0'/0/0"));
const OUTPUT = outputKey(INTERNAL).x;
const TR = taprootAddress(OUTPUT);

const T = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
await T.setup();
const D = await import('../src/background/ledger/device.js');
const dev = fakeLedger({ mnemonic: LEGAL, app: 'Bitcoin' });
D._setOpener(dev.opener);
D._setWait(1500);
const scan = await T.ok('ledger.scan', { chains: ['btc'] });
const added = await T.ok('ledger.add', { id: scan.id, keys: ['plum:0'] });
const wallet = added.wallets.find((w) => w.scheme === 'ledger');
await T.ok('wallet.select', { id: wallet.id });
const ask = (page, method, params) => page.request('btc', { method, params });
async function waiting(kind) {
  const until = Date.now() + 2000;
  let r;
  while (!(r = [...T._test.pending.values()].find((x) => x.kind === kind)) && Date.now() < until) await sleep(5);
  if (!r) throw new Error(`no ${kind} approval`);
  return r;
}

test("a Ledger wallet's Bitcoin record carries both addresses and their keys, from the device's account keys", () => {
  assert.deepEqual(wallet.chains.btc, { address: BTC, path: "m/84'/0'/0'/0/0", publicKey: hex(PUB), taproot: { address: TR, path: "m/86'/0'/0'/0/0", publicKey: hex(INTERNAL) } });
});

test("an unconnected site learns nothing about the wallet: it's told to connect first", async () => {
  const page = T.fake.page('https://stranger.example/');
  assert.equal((await ask(page, 'signPsbt', { psbt: 'cHNidP8=' })).error.code, -32002);
  assert.equal((await ask(page, 'signMessage', { address: BTC, message: 'hi' })).error.code, -32002);
});

let page;
test('connecting: both addresses with their keys, walletType "ledger"', async () => {
  page = T.fake.page('https://ordinals.example/');
  const answer = ask(page, 'getAddresses', { purposes: ['payment', 'ordinals'] });
  const r = await waiting('btcConnect');
  await T.ok('approval.resolve', { id: r.id, approve: true });
  assert.deepEqual((await answer).result.addresses, [
    { address: BTC, publicKey: hex(PUB), purpose: 'payment', addressType: 'p2wpkh', walletType: 'ledger' },
    { address: TR, publicKey: hex(INTERNAL), purpose: 'ordinals', addressType: 'p2tr', walletType: 'ledger' },
  ]);
  assert.equal((await ask(page, 'getAddresses', { purposes: ['ordinals'] })).result.addresses[0].address, TR);
});

test("BIP-322 messages and a site's PSBTs are turned down before any window, with the reason", async () => {
  const bip322 = await ask(page, 'signMessage', { address: BTC, message: 'hello' });
  assert.equal(bip322.error.code, -32001);
  assert.match(bip322.error.message, /legacy format \(ECDSA\) only/);
  const psbt = await ask(page, 'signPsbt', { psbt: 'cHNidP8=' });
  assert.equal(psbt.error.code, -32001);
  assert.match(psbt.error.message, /PSBT with a Ledger/);
  assert.equal(T._test.pending.size, 0);
});

test('a legacy (ECDSA) message is signed on the Ledger and recovers to its key, with the native segwit header', async () => {
  const message = 'Sign this to prove you own the address';
  dev.btcMessage = utf8(message);
  const answer = ask(page, 'signMessage', { address: BTC, message, protocol: 'ECDSA' });
  const r = await waiting('btcMessage');
  const view = await T.ok('approval.get');
  assert.match(view.ledger.note, /legacy format/);
  await T.ok('approval.resolve', { id: r.id, approve: true });
  const { result } = await answer;
  const back = recoverLegacy(utf8(message), result.signature);
  assert.equal(hex(back.publicKey), hex(PUB));
  assert.ok(back.header >= 39 && back.header <= 42, `header ${back.header}`);
  // a device that signs another message is caught before the site sees it
  dev.btcMessage = utf8('something else');
  const again = ask(page, 'signMessage', { address: BTC, message, protocol: 'ECDSA' });
  const r2 = await waiting('btcMessage');
  const e = await T.ui('approval.resolve', { id: r2.id, approve: true });
  assert.equal(e.code, 'ledger-mismatch');
  await T.ok('approval.reject', { id: r2.id });
  // (4001 here: the page's provider says it as sats-connect's USER_REJECTION)
  assert.equal((await again).error.code, 4001);
});

test("sendTransfer: plum builds it, the Ledger signs it, every input by the wallet's one key", async () => {
  const own = concat(Uint8Array.of(0x00, 0x14), hash160(PUB));
  const coins = [40_000n, 70_000n].map((value, i) => {
    const raw = concat(u32le(2), Uint8Array.of(1), new Uint8Array(32).fill(60 + i), u32le(0), Uint8Array.of(0), u32le(0xffffffff), Uint8Array.of(1), u64le(value), Uint8Array.of(own.length), own, u32le(0));
    const txid = hex(sha256(sha256(raw)).reverse());
    net.btc.raw.set(txid, hex(raw));
    net.ord.utxos.set(`${txid}:0`, {});
    return { txid, vout: 0, value: Number(value), confirmed: true };
  });
  net.btc.utxos.set(BTC, coins);
  const answer = ask(page, 'sendTransfer', { recipients: [{ address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: 90_000 }] });
  const r = await waiting('btcSend');
  const view = await T.ok('approval.get');
  assert.match(view.ledger.note, /every output and the fee/);
  await T.ok('approval.preview', { id: r.id });
  const plan = T._test.pending.get(r.id).plan;
  dev.btcPlan = { index: 0, digests: B.sighashes({ inputs: plan.inputs, outputs: plan.outputs, locktime: 0 }, hash160(PUB)) };
  await T.ok('approval.resolve', { id: r.id, approve: true });
  const { result } = await answer;
  const tx = Transaction.fromHex(net.btc.broadcast.at(-1));
  assert.equal(tx.getId(), result.txid);
  assert.equal(tx.ins.length, plan.inputs.length);
  assert.deepEqual([...new Set(tx.ins.map((i) => hex(i.witness[1])))], [hex(PUB)]);
});

test("a send spending both addresses' coins: two passes on the device, each coin signed by its own key", async () => {
  const fund = (script, value, tag) => {
    const raw = concat(u32le(2), Uint8Array.of(1), new Uint8Array(32).fill(tag), u32le(0), Uint8Array.of(0), u32le(0xffffffff), Uint8Array.of(1), u64le(value), Uint8Array.of(script.length), script, u32le(0));
    const txid = hex(sha256(sha256(raw)).reverse());
    net.btc.raw.set(txid, hex(raw));
    net.ord.utxos.set(`${txid}:0`, {});
    return { txid, vout: 0, value: Number(value), confirmed: true };
  };
  const own = concat(Uint8Array.of(0x00, 0x14), hash160(PUB));
  net.btc.utxos.set(BTC, [fund(own, 30_000n, 80)]);
  net.btc.utxos.set(TR, [fund(taprootScript(OUTPUT), 60_000n, 81)]);
  const reviews = dev.reviews;
  const answer = ask(page, 'sendTransfer', { recipients: [{ address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: 80_000 }] });
  const r = await waiting('btcSend');
  await T.ok('approval.preview', { id: r.id });
  const plan = T._test.pending.get(r.id).plan;
  assert.deepEqual(plan.inputs.map((c) => c.kind).sort(), ['p2tr', 'p2wpkh']);
  // plum's own sighashes, as btc.js's signSpend works them out, for the device to sign
  const tx = { version: 2, locktime: 0, inputs: plan.inputs.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffd, scriptSig: new Uint8Array(0), witness: [] })), outputs: plan.outputs };
  const prevouts = plan.inputs.map((c) => ({ value: c.value, script: c.kind === 'p2tr' ? taprootScript(OUTPUT) : own }));
  const at = (kind) => plan.inputs.flatMap((c, i) => (c.kind === kind ? [i] : []));
  dev.btcPlan = {
    index: 0,
    segwit: at('p2wpkh').map((input) => ({ input, digest: sighashV0(tx, input, B.p2pkhCode(hash160(PUB)), plan.inputs[input].value, SIGHASH.ALL) })),
    taproot: at('p2tr').map((input) => ({ input, digest: sighashV1(tx, input, prevouts, SIGHASH.DEFAULT) })),
  };
  await T.ok('approval.resolve', { id: r.id, approve: true });
  const { result } = await answer;
  assert.equal(dev.reviews - reviews, 2, 'two passes on the device: one per address');
  const sent = Transaction.fromHex(net.btc.broadcast.at(-1));
  assert.equal(sent.getId(), result.txid);
  for (const [i, input] of sent.ins.entries()) {
    if (plan.inputs[i].kind === 'p2tr') {
      assert.equal(input.witness.length, 1);
      assert.ok(schnorr.verify(input.witness[0], dev.btcPlan.taproot[0].digest, OUTPUT));
    } else assert.equal(hex(input.witness[1]), hex(PUB));
  }
  D._setOpener(null);
});
