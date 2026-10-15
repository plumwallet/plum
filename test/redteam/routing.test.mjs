// Attacks on the two doors of the background page: who may use plum's own controls, who may connect as a site, and
// what a connected site can ask for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { b64encode, utf8 } from '../../src/shared/bytes.js';
import { ME, PK, boot, legacyB64, pk, sleep, transferIx } from './helpers.mjs';

const BASE = 'moz-extension://plum-test/';
const EXT_ID = 'plum@test';
const ctx = await boot();
const { fake, _test, ok, err, rejectAll } = ctx;
let app;

test("plum's controls refuse a sender with another extension's id, even at plum's own URL", async () => {
  await ctx.setup();
  app = await ctx.connectSite('https://app.example.com/');
  assert.equal(await _test.onUiMessage({ type: 'plum-ui', method: 'state', params: {} }, { id: 'other@ext', url: `${BASE}popup.html` }), undefined);
  assert.equal(await _test.onUiMessage({ type: 'plum-ui', method: 'account.phrase', params: { id: 'x', password: 'x' } }, { id: 'other@ext', url: `${BASE}popup.html` }), undefined);
});

test("plum's controls refuse URLs that only begin like plum's, a missing URL, and the wrong message type", async () => {
  for (const url of ['moz-extension://plum-test.evil/popup.html', 'moz-extension://plum-tests/popup.html', 'https://plum.fun/moz-extension://plum-test/', undefined, 42]) {
    assert.equal(await _test.onUiMessage({ type: 'plum-ui', method: 'state', params: {} }, { id: EXT_ID, url }), undefined, String(url));
  }
  assert.equal(await _test.onUiMessage({ type: 'plum-page', method: 'state' }, { id: EXT_ID, url: `${BASE}popup.html` }), undefined);
  assert.equal(await _test.onUiMessage({ type: 'plum-ui', method: 'constructor' }, { id: EXT_ID, url: `${BASE}popup.html` }), undefined, 'prototype names are not methods');
  assert.equal(await _test.onUiMessage({ type: 'plum-ui', method: '__proto__' }, { id: EXT_ID, url: `${BASE}popup.html` }), undefined);
});

test("a web page cannot reach plum's controls through the site port (every UI method is 'unknown', even from a connected site naming its account)", async () => {
  for (const method of ['state', 'unlock', 'approval.resolve', 'approval.get', 'wallet.export', 'account.phrase', 'send.submit', 'settings.set', 'reset', 'sites', 'importKey', 'ping']) {
    const r = await app.request(method, { account: ME, id: 'x', approve: true, password: 'p', confirm: 'reset' });
    assert.equal(r.result, undefined, method);
    assert.match(r.error?.message ?? '', /unknown method/, method);
  }
});

test('an extension page, a file, and localhost lookalikes cannot connect as a site', () => {
  for (const url of [`${BASE}popup.html`, 'file:///C:/x.html', 'http://localhost.evil.com/', 'http://127.0.0.1.nip.io/', 'http://evil.localhost.com/', 'http://0.0.0.0/', 'http://[::ffff:7f00:1]/', 'ftp://localhost/', 'https://']) {
    const page = fake.page(url);
    assert.ok(page.port.disconnected, `${url} connected`);
  }
  for (const url of ['http://localhost:3000/', 'http://app.localhost:5173/', 'http://127.0.0.1:8080/x', 'http://[::1]:3000/', 'https://user:pw@site.example/']) {
    assert.ok(!fake.page(url).port.disconnected, `${url} refused`);
  }
});

test('a port with the wrong name, or without a tab, is dropped', () => {
  let dropped = 0;
  const stub = (name, sender) => ({ name, sender, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() { dropped++; } });
  _test.onConnect(stub('plum-ui', { id: EXT_ID, url: 'https://site.example/', tab: { id: 1 }, frameId: 0 }));
  _test.onConnect(stub('plum-page', { id: EXT_ID, url: 'https://site.example/', frameId: 0 })); // no tab
  _test.onConnect(stub('plum-page', { id: EXT_ID, url: 'https://site.example/', tab: { id: 1 }, frameId: 1 }));
  _test.onConnect(stub('plum-page', { id: EXT_ID, tab: { id: 1 }, frameId: 0 })); // no url
  assert.equal(dropped, 4);
});

test('M4 retried: a site connected to wallet A sees nothing while B is active and cannot sign as A or B', async () => {
  const s = await ok('wallet.add', { account: (await ok('state')).accounts[0].id }); // adding selects the new wallet
  const B = s.wallets[1].chains.sol.address;
  try {
    assert.equal((await ok('state')).active, s.wallets[1].id);
    assert.deepEqual((await app.request('accounts')).result, []);
    assert.deepEqual((await app.request('connect', { silent: true })).result, []);
    // whichever account the page names, a site not connected to the active account is turned away first
    assert.match((await app.request('signMessage', { account: ME, message: b64encode(utf8('as A')) })).error.message, /connect to Plum first/);
    assert.match((await app.request('signMessage', { account: B, message: b64encode(utf8('as B')) })).error.message, /connect to Plum first/);
    assert.match((await app.request('signTransaction', { account: B, transactions: [legacyB64(PK(B), [transferIx(PK(B), pk())])] })).error.message, /connect to Plum first/);
    assert.equal(_test.pending.size, 0, 'nothing reached the approval queue');
    // connecting B asks you, and the answer is B alone, never the whole list
    const ask = app.request('connect');
    const v = await ctx.nextApproval();
    assert.equal(v.account.address, B);
    await ok('approval.resolve', { id: v.id, approve: true });
    assert.deepEqual((await ask).result, [B]);
    assert.equal((await ok('sites')).find((x) => x.origin === 'https://app.example.com').accounts.length, 2);
    // now B is connected too, but naming A (not active) is refused with the account error
    assert.match((await app.request('signMessage', { account: ME, message: b64encode(utf8('as A')) })).error.message, /isn't the one connected/);
  } finally {
    await ok('wallet.select', { id: s.wallets[0].id });
  }
});

test('params of the wrong shape are refused, never coerced', async () => {
  assert.equal((await ok('state')).wallets.find((w) => w.chains.sol.address === ME).id, (await ok('state')).active);
  const tx = legacyB64(PK(ME), [transferIx(PK(ME), pk())]);
  assert.match((await app.request('signMessage', { account: [ME], message: b64encode(utf8('x')) })).error.message, /isn't the one connected/);
  assert.match((await app.request('signMessage', { account: ME, message: 12345 })).error.message, /16 KB at most/);
  assert.match((await app.request('signMessage', { account: ME, message: 'not base64!!' })).error.message, /base64/);
  assert.match((await app.request('signMessage', { account: ME, message: '' })).error.message, /16 KB/);
  assert.match((await app.request('signTransaction', { account: ME, transactions: tx })).error.message, /between 1 and 20/);
  assert.match((await app.request('signTransaction', { account: ME, transactions: [{ b64: tx }] })).error.message, /malformed/);
  assert.match((await app.request('signTransaction', { account: ME, transactions: Array(21).fill(tx) })).error.message, /between 1 and 20/);
  assert.match((await app.request('signTransaction', { account: ME, chain: 7, transactions: [tx] })).error.message, /doesn't know the chain/);
  assert.match((await app.request('signIn', { account: ME, input: { statement: 42 } })).error.message, /malformed/);
  assert.match((await app.request('signIn', { account: ME, input: { resources: 'https://x' } })).error.message, /malformed/);
  // a non-string method is dropped without an answer (nothing to reply to)
  assert.equal(await Promise.race([app.request(42, {}).then(() => 'answered'), sleep(100).then(() => 'ignored')]), 'ignored');
  assert.equal(_test.pending.size, 0, 'none of these reached the approval queue');
});

test('H1 retried: a transaction request pinned to the right chain is voided by a network switch before approval, and its preview runs on the old network', async () => {
  const tx = legacyB64(PK(ME), [transferIx(PK(ME), pk())]);
  const answer = app.request('signTransaction', { account: ME, chain: 'solana:mainnet', transactions: [tx] });
  const v = await ctx.nextApproval();
  assert.equal(v.network, 'mainnet');
  await ok('settings.set', { patch: { network: 'devnet' } });
  assert.match(await err('approval.resolve', { id: v.id, approve: true }), /network changed/);
  assert.equal((await ok('approval.get')).network, 'mainnet', 'the window still says which network the request was for');
  await ok('settings.set', { patch: { network: 'mainnet' } });
  // switched back: the request was made for mainnet and plum is on mainnet again, so it may go through
  await ok('approval.resolve', { id: v.id, approve: true });
  assert.ok((await answer).result?.[0]);
});

test('a request keeps the wallet it was made for: switching wallets mid-approval does not resign it with the new one', async () => {
  const tx = legacyB64(PK(ME), [transferIx(PK(ME), pk())]);
  const answer = app.request('signTransaction', { account: ME, transactions: [tx] });
  const v = await ctx.nextApproval();
  const s = await ok('state');
  await ok('wallet.select', { id: s.wallets[1].id });
  assert.equal((await ok('approval.get')).account.address, ME, 'the window shows the wallet that will sign');
  await ok('approval.resolve', { id: v.id, approve: true });
  const r = await answer;
  const { Transaction } = await import('@solana/web3.js');
  const signed = Transaction.from(Buffer.from(r.result[0], 'base64'));
  assert.ok(signed.verifySignatures());
  assert.equal(signed.signatures[0].publicKey.toBase58(), ME);
  await ok('wallet.select', { id: s.wallets[0].id });
});

test('removing the wallet a request is for makes the request fail, not sign with another wallet', async () => {
  const s = await ok('state');
  const B = s.wallets[1];
  const addr = B.chains.sol.address;
  // connect B's address on a fresh site, queue a request for it, then remove B
  await ok('wallet.select', { id: B.id });
  const site = await ctx.connectSite('https://for-b.example/');
  const tx = legacyB64(PK(addr), [transferIx(PK(addr), pk())]);
  const answer = site.request('signTransaction', { account: addr, transactions: [tx] });
  const v = await ctx.nextApproval();
  await ok('wallet.select', { id: s.wallets[0].id });
  await ok('wallet.remove', { id: B.id });
  const r = await fake.ui('approval.resolve', { id: v.id, approve: true });
  assert.equal(r.ok, false);
  assert.match((await answer).error.message, /isn't one of your wallets/);
  assert.equal(_test.pending.size, 0);
});

test('a page closing takes only its own requests; the other site keeps its place', async () => {
  const other = await ctx.connectSite('https://other.example/');
  const a = app.request('signMessage', { account: ME, message: b64encode(utf8('a')) });
  const b = other.request('signMessage', { account: ME, message: b64encode(utf8('b')) });
  await sleep(10);
  assert.equal(_test.pending.size, 2);
  other.close();
  assert.match((await b).error.message, /page closed/);
  assert.equal(_test.pending.size, 1);
  assert.equal((await ok('approval.get')).origin, 'https://app.example.com');
  await rejectAll();
  await a;
});
