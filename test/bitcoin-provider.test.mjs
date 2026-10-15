// The Bitcoin provider in the page (src/content/bitcoin.js), on a stand-in window: registered by WBIP-004 in both
// lists, found at the path its id names (as sats-connect resolves it), answering with JSON-RPC envelopes and never
// rejecting, sats-connect's error codes, events in both shapes, and the Wallet Standard wallet with the bitcoin:*
// features (as Reown AppKit finds it). No other wallet's name is ever taken.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// a window: an EventTarget with the page's globals on it
const win = new EventTarget();
win.btc_providers = [{ id: 'SomeoneElse', name: 'other' }];
globalThis.window = win;
const { startBitcoin } = await import('../src/content/bitcoin.js');

const ADDRS = [
  { address: 'bc1qpay', publicKey: '02'.padEnd(66, '1'), purpose: 'payment', addressType: 'p2wpkh', walletType: 'software' },
  { address: 'bc1pord', publicKey: 'ab'.repeat(32), purpose: 'ordinals', addressType: 'p2tr', walletType: 'software' },
];
const calls = [];
let answer = async () => null;
const call = async (method, params) => { calls.push([method, params]); return answer(params.method, params.params); };

// the Wallet Standard app side registers before plum, and plum answers the app-ready call too
const registered = [];
win.addEventListener('wallet-standard:register-wallet', ({ detail }) => detail({ register: (w) => registered.push(w) }));
const btc = startBitcoin({ call, icon: 'data:image/png;base64,AAAA' });

test('WBIP-004: one entry in btc_providers and wbip_providers, its id a path to the provider; no other wallet\'s name taken', () => {
  for (const list of ['btc_providers', 'wbip_providers']) {
    const e = win[list].find((x) => x.name === 'Plum');
    assert.ok(e, list);
    assert.equal(e.id, 'PlumProviders.BitcoinProvider');
    assert.ok(e.methods.includes('signPsbt'));
    assert.match(e.icon, /^data:image\/png;base64,/);
    // as sats-connect's getProviderById resolves it
    assert.equal(e.id.split('.').reduce((acc, part) => acc?.[part], win), btc.provider);
  }
  assert.equal(win.btc_providers[0].id, 'SomeoneElse', "another wallet's entry is kept");
  for (const name of ['unisat', 'XverseProviders', 'LeatherProvider', 'BitcoinProvider', 'magicEden', 'phantom', 'okxwallet', 'ethereum']) assert.equal(win[name], undefined, name);
  // the provider can't be swapped out by the page
  assert.throws(() => { 'use strict'; win.PlumProviders = {}; });
  assert.equal(Object.isFrozen(btc.provider), true);
});

test('request: always a JSON-RPC envelope (sats-connect counts on it never rejecting), errors as its codes', async () => {
  answer = async (m) => (m === 'getInfo' ? { version: '0.1.6', methods: [], supports: [] } : m === 'wallet_disconnect' ? undefined : null);
  const info = await btc.provider.request('getInfo', null);
  assert.equal(info.jsonrpc, '2.0');
  assert.equal(typeof info.id, 'string');
  assert.deepEqual(info.result, { version: '0.1.6', methods: [], supports: [] });
  assert.deepEqual(calls.at(-1), ['btc', { method: 'getInfo', params: null }]);
  const v = await btc.provider.request('wallet_disconnect');
  assert.ok('result' in v && v.result === null, 'a void method answers result: null');
  for (const [code, want] of [[4001, -32000], [4100, -32002], [-32601, -32601], [-32602, -32602], [undefined, -32603], [12345, -32603]]) {
    answer = async () => { throw Object.assign(new Error('nope'), { code }); };
    const r = await btc.provider.request('signPsbt', { psbt: 'x' });
    assert.deepEqual(r.error, { code: want, message: 'nope' });
    assert.equal(r.jsonrpc, '2.0');
  }
  for (const bad of [undefined, '', 42, 'x'.repeat(65)]) assert.equal((await btc.provider.request(bad)).error.code, -32600);
});

test('events: accountChange when the addresses change, disconnect when the site loses them; both addListener shapes', async () => {
  const seen = [];
  const off1 = btc.provider.addListener('accountChange', (e) => seen.push(['a', e]));
  const off2 = btc.provider.addListener({ eventName: 'disconnect', cb: (e) => seen.push(['d', e]) });
  const off3 = btc.provider.addListener('nonsense', () => seen.push(['?']));
  answer = async (m) => (m === 'getAddresses' ? { addresses: ADDRS, network: {} } : null);
  await btc.provider.request('getAddresses', { purposes: ['payment', 'ordinals'] });
  assert.deepEqual(seen, [['a', { type: 'accountChange', addresses: ADDRS }]]);
  await btc.provider.request('getAddresses', { purposes: ['payment', 'ordinals'] });
  assert.equal(seen.length, 1, 'the same addresses again: no event');
  // plum says the wallet changed and the site isn't connected to the new one
  answer = async () => { throw Object.assign(new Error('connect to Plum first'), { code: -32002 }); };
  await btc.refresh();
  assert.deepEqual(seen.at(-1), ['d', { type: 'disconnect' }]);
  off1(); off2(); off3();
  answer = async () => ({ addresses: ADDRS });
  await btc.provider.request('getAddresses', {});
  assert.equal(seen.length, 2, 'no events after unsubscribing');
});

test('the Wallet Standard: a "Plum" wallet on bitcoin:mainnet with the bitcoin:* features, mapped onto the same requests', async () => {
  win.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: { register: (w) => registered.push(w) } }));
  assert.equal(registered.length, 2);
  const w = registered[0];
  assert.equal(registered[1], w);
  assert.equal(w.name, 'Plum');
  assert.deepEqual(w.chains, ['bitcoin:mainnet']);
  for (const f of ['bitcoin:connect', 'bitcoin:signTransaction', 'bitcoin:signAndSendTransaction', 'bitcoin:signMessage', 'bitcoin:disconnect', 'bitcoin:events', 'standard:events']) assert.ok(w.features[f], f);
  assert.ok(!Object.keys(w.features).some((f) => f.startsWith('solana:')), 'a Bitcoin wallet only');
  answer = async (m, p) => {
    if (m === 'getAddresses') return { addresses: ADDRS.filter((a) => p.purposes.includes(a.purpose)) };
    if (m === 'signPsbt') return p.broadcast ? { psbt: p.psbt, txid: 'ff'.repeat(32) } : { psbt: p.psbt };
    if (m === 'signMessage') return { signature: 'AUBhYmM=', address: p.address, protocol: 'BIP322' };
    return null;
  };
  const changes = [];
  w.features['bitcoin:events'].on('change', (e) => changes.push(e.accounts.map((a) => a.address)));
  const { accounts } = await w.features['bitcoin:connect'].connect({ purposes: ['ordinals'] });
  assert.deepEqual(accounts.map((a) => a.address), ['bc1pord']);
  assert.deepEqual([...accounts[0].publicKey].slice(0, 2), [0xab, 0xab]);
  assert.deepEqual(accounts[0].chains, ['bitcoin:mainnet']);
  assert.ok(changes.length >= 1);
  const psbt = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff, 1, 2, 3]);
  const [signed] = await w.features['bitcoin:signTransaction'].signTransaction({ psbt, inputsToSign: [{ account: accounts[0], signingIndexes: [0, 2], sigHash: 'SINGLE|ANYONECANPAY' }] });
  assert.deepEqual([...signed.signedPsbt], [...psbt]);
  assert.deepEqual(calls.at(-1)[1], { method: 'signPsbt', params: { psbt: 'cHNidP8BAgM=', inputsToSign: [{ address: 'bc1pord', signingIndexes: [0, 2], sigHash: 0x83 }] } });
  const [sent] = await w.features['bitcoin:signAndSendTransaction'].signAndSendTransaction({ psbt, chain: 'bitcoin:mainnet', inputsToSign: [{ account: accounts[0], signingIndexes: [0] }] });
  assert.equal(sent.txId, 'ff'.repeat(32));
  await assert.rejects(w.features['bitcoin:signAndSendTransaction'].signAndSendTransaction({ psbt, chain: 'bitcoin:testnet', inputsToSign: [] }), /mainnet only/);
  const [msg] = await w.features['bitcoin:signMessage'].signMessage({ account: accounts[0], message: new TextEncoder().encode('gm') });
  assert.deepEqual([...msg.signature], [1, 64, 97, 98, 99]);
  assert.deepEqual(calls.at(-1)[1].params, { address: 'bc1pord', message: 'gm', protocol: 'BIP322' });
  await assert.rejects(w.features['bitcoin:signMessage'].signMessage({ account: accounts[0], message: Uint8Array.of(0xff, 0xfe) }), /text/);
  // an account the site wasn't given can't be named
  await assert.rejects(w.features['bitcoin:signMessage'].signMessage({ account: { address: 'bc1qsomeoneelse' }, message: new TextEncoder().encode('x') }), /not connected/);
  answer = async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); };
  await assert.rejects(w.features['bitcoin:connect'].connect({ purposes: ['payment'] }), (e) => e.code === -32000);
});
