// A Bitcoin site, end to end in plum's real background (fake browser, stand-in chain): sats-connect's methods, the
// approval for each, and what comes back: both addresses with their keys, BIP-322 and legacy signatures, a PSBT
// reviewed against the chain, signed by the wallet's keys only (and sent when asked), a sendTransfer built and signed
// by plum alone. bitcoinjs-lib checks every signature.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { hex, utf8 } from '../src/shared/bytes.js';
import { recoverLegacy, verifyBip322 } from '../src/background/bip322.js';
import { addressScript } from '../src/background/btc.js';
import { fakeNet } from './fake-net.mjs';
import { boot, sleep } from './redteam/helpers.mjs';
import { buildPsbt, p2wpkhAddress, stranger, txidOf, validator } from './btc-helpers.mjs';

const SEGWIT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const SEG_SCRIPT = addressScript(SEGWIT).script, TR_SCRIPT = addressScript(TAPROOT).script;
const SITE = 'https://ordinals.example';

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, fake, _test } = ctx;

/** A request from the site's page to plum's Bitcoin provider: { result } or { error }. */
const ask = (page, method, params) => page.request('btc', { method, params });
/** The first waiting approval (and its preview, when it has one). */
async function waiting(kind) {
  const until = Date.now() + 2000;
  let r;
  while (!(r = [..._test.pending.values()].find((x) => x.kind === kind)) && Date.now() < until) await sleep(5);
  if (!r) throw new Error(`no ${kind} approval`);
  return r;
}
async function approveIt(kind, { ignoreRisk = false } = {}) {
  const r = await waiting(kind);
  const view = await ok('approval.get');
  const previews = view.txCount ? await ok('approval.preview', { id: r.id }) : null;
  await ok('approval.resolve', { id: r.id, approve: true, ignoreRisk });
  return { view, previews };
}
/** Record the coins of a PSBT on the stand-in chain (and as plain coins on the indexer), so plum can check them. */
function onChain(built) {
  for (const [op, prev] of built.chain) {
    if (!prev) continue;
    net.ord.utxos.set(op, {});
    const [txid, vout] = op.split(':');
    const outs = net.btc.txs.get(txid) ?? [];
    outs[Number(vout)] = { scriptpubkey: hex(prev.script), value: Number(prev.value) };
    for (let i = 0; i < outs.length; i++) outs[i] ??= { scriptpubkey: '6a', value: 0 };
    net.btc.txs.set(txid, outs);
  }
}

let page;

test('setup, and what a site may ask before it connects', async () => {
  await ctx.setup();
  page = fake.page(`${SITE}/mint`);
  const info = await ask(page, 'getInfo', null);
  assert.equal(info.result.version, (await ok('state')).version);
  assert.ok(info.result.methods.includes('signPsbt'));
  assert.deepEqual((await ask(page, 'wallet_getNetwork')).result.bitcoin, { name: 'Mainnet' });
  assert.equal((await ask(page, 'wallet_getAccount')).error.code, -32002);
  assert.equal((await ask(page, 'signMessage', { address: SEGWIT, message: 'hi' })).error.code, -32002);
  assert.equal((await ask(page, 'getBalance')).error.code, -32002);
  assert.match((await ask(page, 'wallet_changeNetwork', { name: 'Testnet' })).error.message, /mainnet only/);
  assert.equal((await ask(page, 'ord_getInscriptions')).error.code, -32601);
});

test('getAddresses: approved in the window, both addresses with the keys sites build for; later asks need no approval', async () => {
  const answer = ask(page, 'getAddresses', { purposes: ['payment', 'ordinals', 'stacks'], message: 'connect to mint' });
  const { view } = await approveIt('btcConnect');
  assert.equal(view.chain, 'btc');
  assert.deepEqual(view.btc.shown, [{ purpose: 'payment', address: SEGWIT }, { purpose: 'ordinals', address: TAPROOT }]);
  assert.equal(view.btc.note, 'connect to mint');
  const { result } = await answer;
  assert.deepEqual(result.addresses, [
    { address: SEGWIT, publicKey: '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c', purpose: 'payment', addressType: 'p2wpkh', walletType: 'software' },
    { address: TAPROOT, publicKey: 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115', purpose: 'ordinals', addressType: 'p2tr', walletType: 'software' },
  ]);
  assert.equal(result.network.bitcoin.name, 'Mainnet');
  // connected: no window this time, and the other shapes of the same answer
  const again = await ask(page, 'getAccounts', { purposes: ['ordinals'] });
  assert.deepEqual(again.result.map((a) => a.address), [TAPROOT]);
  assert.equal(_test.pending.size, 0);
  const acct = (await ask(page, 'wallet_getAccount')).result;
  assert.equal(acct.addresses.length, 2);
  assert.match(acct.id, /^[0-9a-f]{32}$/);
  const sites = await ok('sites');
  assert.deepEqual(sites.find((s) => s.origin === SITE).btc, [SEGWIT]);
  // the balance of both addresses, as strings of sats
  net.btc.stats.set(SEGWIT, { funded: 70_000, spent: 0, txs: 1 });
  net.btc.stats.set(TAPROOT, { funded: 30_000, spent: 0, txs: 1 });
  assert.deepEqual((await ask(page, 'getBalance')).result, { confirmed: '100000', unconfirmed: '0', total: '100000' });
});

test('signMessage: BIP-322 by default for either address, the legacy format when asked by name; both verify', async () => {
  for (const address of [SEGWIT, TAPROOT]) {
    const answer = ask(page, 'signMessage', { address, message: 'Hello World' });
    const { view } = await approveIt('btcMessage');
    assert.equal(view.btc.text, 'Hello World');
    assert.equal(view.btc.protocol, 'BIP322');
    const { result } = await answer;
    assert.equal(result.protocol, 'BIP322');
    assert.equal(result.address, address);
    assert.ok(verifyBip322(address, utf8('Hello World'), result.signature), address);
    assert.match(result.messageHash, /^[0-9a-f]{64}$/);
  }
  const answer = ask(page, 'signMessage', { address: SEGWIT, message: 'legacy please', protocol: 'ECDSA' });
  await approveIt('btcMessage');
  const { result } = await answer;
  const r = recoverLegacy(utf8('legacy please'), result.signature);
  assert.equal(hex(r.publicKey), '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c');
  assert.ok(r.header >= 39 && r.header <= 42, 'BIP-137 P2WPKH header');
  assert.match((await ask(page, 'signMessage', { address: SEGWIT, message: 'x', protocol: 'schnorr' })).error.message, /BIP322 or ECDSA/);
});

test('signPsbt: reviewed against the chain, only the inputs asked for, signatures bitcoinjs accepts; broadcast when asked', async () => {
  const merchant = p2wpkhAddress('a merchant');
  const built = buildPsbt({
    inputs: [
      { txid: txidOf('site 1'), vout: 0, value: 150_000n, script: SEG_SCRIPT },
      { txid: txidOf('site 2'), vout: 1, value: 60_000n, script: TR_SCRIPT },
    ],
    outputs: [{ address: merchant, value: 100_000n }, { address: SEGWIT, value: 108_000n }],
  });
  onChain(built);
  const answer = ask(page, 'signPsbt', { psbt: built.b64, signInputs: { [SEGWIT]: [0], [TAPROOT]: [1] } });
  const { previews } = await approveIt('btcPsbt');
  const p = previews[0];
  assert.equal(p.kind, 'psbt');
  assert.equal(p.checked, true);
  assert.deepEqual([p.leaves, p.arrives, p.net, p.fee, p.toOthers], ['210000', '108000', '-102000', '2000', '100000']);
  assert.deepEqual(p.inputs.map((x) => [x.mine, x.sign, x.verified]), [['p2wpkh', true, 'chain'], ['p2tr', true, 'chain']]);
  assert.deepEqual(p.warnings, []);
  const { result } = await answer;
  assert.equal(result.txid, undefined);
  const signed = Psbt.fromBase64(result.psbt);
  assert.ok(signed.validateSignaturesOfInput(0, validator));
  assert.ok(signed.validateSignaturesOfInput(1, validator));
  signed.finalizeAllInputs();
  const tx = signed.extractTransaction();
  // the same PSBT, to be sent by plum: finalized, extracted, broadcast; the txid is the network's
  const sent = ask(page, 'signPsbt', { psbt: built.b64, broadcast: true });
  await approveIt('btcPsbt');
  const r2 = (await sent).result;
  assert.equal(r2.txid, tx.getId());
  assert.equal(Transaction.fromHex(net.btc.broadcast.at(-1)).getId(), tx.getId());
});

test('sendTransfer: plum builds it from both addresses, signs it alone, sends it; change back to bc1q', async () => {
  const to = [stranger('payee 1').address, p2wpkhAddress('payee 2')];
  net.btc.utxos.set(SEGWIT, [{ txid: 'a1'.repeat(32), vout: 0, value: 40_000 }]);
  net.btc.utxos.set(TAPROOT, [{ txid: 'b2'.repeat(32), vout: 3, value: 90_000 }]);
  const answer = ask(page, 'sendTransfer', { recipients: [{ address: to[0], amount: 50_000 }, { address: to[1], amount: 20_000 }] });
  const { view, previews } = await approveIt('btcSend');
  assert.deepEqual(view.btc.recipients, [{ address: to[0], amount: '50000' }, { address: to[1], amount: '20000' }]);
  assert.equal(previews[0].amount, '70000');
  const { result } = await answer;
  const tx = Transaction.fromHex(net.btc.broadcast.at(-1));
  assert.equal(tx.getId(), result.txid);
  assert.deepEqual(tx.outs.slice(0, 2).map((o) => o.value), [50_000n, 20_000n]);
  assert.equal(hex(tx.outs[2].script), hex(SEG_SCRIPT), 'change to bc1q');
  // one signer: every input is the wallet's own key
  const prevs = tx.ins.map((i) => hex(Buffer.from(i.hash).reverse()));
  for (const [i, input] of tx.ins.entries()) {
    if (prevs[i] === 'b2'.repeat(32)) assert.equal(input.witness.length, 1, 'taproot key path');
    else assert.equal(hex(input.witness[1]), '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c');
  }
  assert.match((await ask(page, 'sendTransfer', { recipients: [{ address: to[0], amount: 100 }] })).error.message, /546 at least/);
  assert.match((await ask(page, 'sendTransfer', { recipients: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 1000 }] })).error.message, /testnet/);
});

test('a rejection is sats-connect\'s USER_REJECTION once it reaches the page; wallet_disconnect forgets the site', async () => {
  const answer = ask(page, 'signMessage', { address: SEGWIT, message: 'no thanks' });
  const r = await waiting('btcMessage');
  await ok('approval.reject', { id: r.id });
  assert.equal((await answer).error.code, 4001, 'the background says no; bitcoin.js turns 4001 into -32000');
  assert.equal((await ask(page, 'wallet_disconnect')).result, null);
  assert.equal((await ask(page, 'wallet_getAccount')).error.code, -32002);
});
