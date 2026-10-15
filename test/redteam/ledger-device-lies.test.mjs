// Red team: a Ledger that lies. A device is outside plum, so everything it says is checked: another device (another
// recovery phrase), a signature by another key or over something else, a malformed or out-of-range signature, an
// address that isn't its own key's, a Bitcoin signature for an input it wasn't asked about, a provider handing over the
// wrong previous transaction. Nothing a lying device returns is ever sent or handed to a site; plum says plainly why.
import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, hex, u32le, u64le } from '../../src/shared/bytes.js';
import * as B from '../../src/background/btc.js';
import { addressOf, hash160, secretAt, seedOf, signSol } from '../../src/background/keys.js';
import { fakeLedger } from '../fake-ledger.mjs';
import { fakeNet } from '../fake-net.mjs';
import { PK, boot, legacyB64, pk, transferIx } from './helpers.mjs';

const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OTHER = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const seed = seedOf(LEGAL);
const L = { sol: addressOf('sol', secretAt(seed, 'sol', "m/44'/501'/0'/0'")), eth: addressOf('eth', secretAt(seed, 'eth', "m/44'/60'/0'/0/0")), btc: addressOf('btc', secretAt(seed, 'btc', "m/84'/0'/0'/0/0")) };
const otherSol = secretAt(seedOf(OTHER), 'sol', "m/44'/501'/0'/0'");

const T = await boot({ balances: { [L.sol]: 5_000_000_000n } });
const net = fakeNet();
globalThis.fetch = net.fetch;
await T.setup();
const D = await import('../../src/background/ledger/device.js');
const dev = fakeLedger({ mnemonic: LEGAL, app: 'Solana' });
D._setOpener(dev.opener);
D._setWait(1500);

const scan = await T.ok('ledger.scan', { chains: ['sol', 'eth', 'btc'] });
const added = await T.ok('ledger.add', { id: scan.id, keys: ['plum:0'] });
const wallet = added.wallets.find((w) => w.scheme === 'ledger');
await T.ok('wallet.select', { id: wallet.id });
const page = await T.connectSite('https://dapp.example.org');

/** A site asks for a Solana signature; returns { view, answer }. */
async function solRequest() {
  const answer = page.request('signTransaction', { account: L.sol, transactions: [legacyB64(PK(L.sol), [transferIx(PK(L.sol), pk(), 1)])] });
  return { view: await T.nextApproval(), answer };
}

test('another Ledger (another recovery phrase) is caught before it shows you anything', async () => {
  const other = fakeLedger({ mnemonic: OTHER, app: 'Solana' });
  D._setOpener(other.opener);
  const { view, answer } = await solRequest();
  const r = await T.ui('approval.resolve', { id: view.id, approve: true });
  assert.equal(r.code, 'ledger-mismatch');
  assert.match(r.error, /isn't the Ledger this wallet is on/);
  assert.equal(other.reviews, 0, 'the other device never showed a review');
  // the request waits for the right one
  D._setOpener(dev.opener);
  await T.ok('approval.resolve', { id: view.id, approve: true });
  assert.ok((await answer).result);
});

test("a Solana signature by another key, or one that isn't 64 bytes, never reaches the site", async () => {
  for (const lie of [(sig, msg) => signSol(msg, otherSol), (sig) => sig.slice(0, 63), (sig) => { const s = sig.slice(); s[5] ^= 1; return s; }]) {
    dev.lie.solSig = lie;
    const { view, answer } = await solRequest();
    const r = await T.ui('approval.resolve', { id: view.id, approve: true });
    assert.equal(r.code, 'ledger-mismatch', r.error);
    assert.ok(T._test.pending.has(view.id), 'nothing was handed over; the request is still yours to answer');
    dev.lie = {};
    await T.ok('approval.reject', { id: view.id });
    assert.equal((await answer).error.code, 4001);
  }
});

test('an Ethereum signature over something else, out of range or with a made-up v is never sent', async () => {
  await T.ok('wallet.select', { id: wallet.id });
  const conn = page.request('evm', { method: 'eth_requestAccounts', params: [] });
  await T.approveNext();
  await conn;
  net.eth.balances.set(L.eth.toLowerCase(), 10n ** 18n);
  const N = secp256k1.Point.CURVE().n;
  const word = (n) => Uint8Array.from(n.toString(16).padStart(64, '0').match(/../g), (b) => Number.parseInt(b, 16));
  const lies = [
    (s) => { const o = s.slice(); o[10] ^= 1; return o; },
    (s) => concat(s.subarray(0, 1), word(0n), s.subarray(33)),
    (s) => concat(s.subarray(0, 33), word(N)),
    (s) => concat(Uint8Array.of(99), s.subarray(1)),
  ];
  for (const lie of lies) {
    dev.lie.ethSig = lie;
    const sent = net.eth.sent.length;
    const send = page.request('evm', { method: 'eth_sendTransaction', params: [{ from: L.eth, to: '0x000000000000000000000000000000000000dEaD', value: '0x1' }] });
    const v = await T.nextApproval();
    await T.ok('approval.preview', { id: v.id });
    const r = await T.ui('approval.resolve', { id: v.id, approve: true, ignoreRisk: true });
    assert.equal(r.code, 'ledger-mismatch', r.error);
    assert.equal(net.eth.sent.length, sent, 'nothing went out');
    dev.lie = {};
    await T.ok('approval.reject', { id: v.id });
    assert.equal((await send).error.code, 4001);
  }
});

test("a high-s Ethereum signature is the same signature: it's sent with a low s", async () => {
  const N = secp256k1.Point.CURVE().n;
  dev.lie.ethSig = (s) => {
    const sv = BigInt(`0x${hex(s.subarray(33, 65))}`);
    const flipped = Uint8Array.from((N - sv).toString(16).padStart(64, '0').match(/../g), (b) => Number.parseInt(b, 16));
    return concat(Uint8Array.of(s[0] ^ 1), s.subarray(1, 33), flipped);
  };
  const send = page.request('evm', { method: 'eth_sendTransaction', params: [{ from: L.eth, to: '0x000000000000000000000000000000000000dEaD', value: '0x2' }] });
  const v = await T.nextApproval();
  await T.ok('approval.preview', { id: v.id });
  await T.ok('approval.resolve', { id: v.id, approve: true, ignoreRisk: true });
  assert.ok((await send).result);
  const { recoverTransactionAddress, parseTransaction } = await import('viem');
  const raw = net.eth.sent.at(-1);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), L.eth);
  assert.ok(BigInt(parseTransaction(raw).s) <= N / 2n);
  dev.lie = {};
});

test("adding a Ledger whose Ethereum address isn't its own key's, or whose Bitcoin address isn't its account's, fails", async () => {
  dev.lie.ethAddressText = () => '000000000000000000000000000000000000dead';
  assert.equal((await T.ui('ledger.scan', { chains: ['eth'] })).code, 'ledger-mismatch');
  dev.lie = { btcAddress: () => 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };
  assert.equal((await T.ui('ledger.scan', { chains: ['btc'] })).code, 'ledger-mismatch');
  dev.lie = { solAddress: () => new Uint8Array(32).fill(0xff).map((b, i) => (i === 31 ? 0x7f : b)) };
  const r = await T.ui('ledger.scan', { chains: ['sol'] });
  assert.equal(r.code, 'ledger-mismatch');
  dev.lie = {};
});

/* ------------------------------------------------------------ Bitcoin */

const own = concat(Uint8Array.of(0x00, 0x14), hash160(secp256k1.getPublicKey(secretAt(seed, 'btc', "m/84'/0'/0'/0/0"), true)));
function fund(values, tag) {
  const coins = values.map((value, i) => {
    const raw = concat(u32le(2), Uint8Array.of(1), new Uint8Array(32).fill(tag + i), u32le(0), Uint8Array.of(0), u32le(0xffffffff), Uint8Array.of(1), u64le(value), Uint8Array.of(own.length), own, u32le(0));
    const txid = hex(sha256(sha256(raw)).reverse());
    net.btc.raw.set(txid, hex(raw));
    return { txid, vout: 0, value: Number(value), confirmed: true };
  });
  net.btc.utxos.set(L.btc, coins);
  net.btc.stats.set(L.btc, { funded: values.reduce((n, v) => n + Number(v), 0), spent: 0, txs: values.length });
  return coins;
}
async function btcSend() {
  const prep = await T.ok('send.prepare', { chain: 'btc', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0006', speed: 'normal' });
  const plan = T._test.prepared.get(prep.id).plan;
  dev.btcPlan = { index: 0, digests: B.sighashes({ inputs: plan.inputs, outputs: plan.outputs, locktime: 0 }, own.subarray(2)) };
  return prep;
}

test('Bitcoin signatures that are wrong in any way are refused, and nothing is broadcast', async () => {
  await T.ok('wallet.select', { id: wallet.id });
  fund([30_000n, 50_000n], 20);
  const other = secretAt(seedOf(OTHER), 'btc', "m/84'/0'/0'/0/0");
  const lies = [
    // an input that doesn't exist
    (list) => [...list, concat(Uint8Array.of(7), list[0].subarray(1))],
    // the same input twice, the other one missing
    (list) => [list[0], list[0]],
    // another key, signing over the right sighash
    (list) => list.map((y, i) => { const pub = secp256k1.getPublicKey(other, true); return concat(Uint8Array.of(i, 33), pub, secp256k1.sign(dev.btcPlan.digests[i], other, { prehash: false, format: 'der' }), Uint8Array.of(1)); }),
    // the right key over another sighash
    (list, { pub, key }) => list.map((y, i) => concat(Uint8Array.of(i, 33), pub, secp256k1.sign(new Uint8Array(32).fill(i + 1), key, { prehash: false, format: 'der' }), Uint8Array.of(1))),
    // SIGHASH_NONE instead of ALL
    (list) => list.map((y) => concat(y.subarray(0, -1), Uint8Array.of(2))),
    // not DER
    (list) => list.map((y) => concat(y.subarray(0, 35), new Uint8Array(70).fill(1))),
  ];
  for (const lie of lies) {
    const before = net.btc.broadcast.length;
    const prep = await btcSend();
    dev.lie.btcYield = lie;
    const r = await T.ui('send.submit', { id: prep.id });
    assert.equal(r.code, 'ledger-mismatch', r.error);
    assert.equal(net.btc.broadcast.length, before);
    dev.lie = {};
  }
  // and the honest device's send goes through
  const prep = await btcSend();
  await T.ok('send.submit', { id: prep.id });
});

test("another Ledger is caught by its fingerprint; a provider's wrong previous transaction stops the send before the device", async () => {
  const other = fakeLedger({ mnemonic: OTHER, app: 'Bitcoin' });
  D._setOpener(other.opener);
  fund([90_000n], 40);
  let prep = await btcSend();
  const r = await T.ui('send.submit', { id: prep.id });
  assert.equal(r.code, 'ledger-mismatch');
  assert.equal(other.reviews, 0);
  D._setOpener(dev.opener);
  const [coin] = fund([90_000n], 41);
  net.btc.raw.set(coin.txid, net.btc.raw.get(coin.txid).replace(/00000000$/, '01000000'));
  const reviews = dev.reviews;
  prep = await btcSend();
  const r2 = await T.ui('send.submit', { id: prep.id });
  assert.match(r2.error, /isn't the one asked for/);
  assert.equal(dev.reviews, reviews, 'the device never saw it');
});

test('an answer the device cuts short, or one that is not an answer at all, is an error, not a signature', async () => {
  const LS = await import('../../src/background/ledger/solana.js');
  const short = { exchange: async () => Uint8Array.of(0x90) };
  await assert.rejects(LS.address(short, "m/44'/501'/0'/0'"), /nothing plum can read/);
  const wrongLength = { exchange: async () => concat(new Uint8Array(31), Uint8Array.of(0x90, 0)) };
  await assert.rejects(LS.address(wrongLength, "m/44'/501'/0'/0'"), (e) => e.state === 'mismatch');
  const notAKey = { exchange: async () => concat(new Uint8Array(32).fill(0xff), Uint8Array.of(0x90, 0)) };
  await assert.rejects(LS.address(notAKey, "m/44'/501'/0'/0'"), (e) => e.state === 'mismatch');
});
