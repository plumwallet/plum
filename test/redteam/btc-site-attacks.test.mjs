// Attack: a Bitcoin site (or a page pretending to be one) asks plum for things it shouldn't get. Through plum's real
// background: a phishing site connecting, a sign-in message for another site, a message hiding characters, asking to
// sign for an address that isn't the connected wallet's (or after you switched wallets), an unconnected subdomain, a
// flood of connects, oversized and malformed requests, and a disconnect from one chain leaving the others alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeNet } from '../fake-net.mjs';
import { boot, sleep } from './helpers.mjs';

const SEGWIT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

const ctx = await boot({ phish: { block: ['evil-drainer.com'], allow: [], at: Date.now() } });
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, err, fake, _test } = ctx;
const ask = (page, method, params) => page.request('btc', { method, params });

async function waiting(kind, origin = null) {
  const until = Date.now() + 2000;
  let r;
  while (!(r = [..._test.pending.values()].find((x) => x.kind === kind && (!origin || x.origin === origin))) && Date.now() < until) await sleep(5);
  if (!r) throw new Error(`no ${kind} approval`);
  return r;
}
async function connect(page, origin) {
  const answer = ask(page, 'getAddresses', { purposes: ['payment', 'ordinals'] });
  const r = await waiting('btcConnect', origin);
  await ok('approval.resolve', { id: r.id, approve: true });
  return answer;
}

test('setup', async () => { await ctx.setup(); });

test('withstood: a site on the phishing list must be approved past the warning, every time', async () => {
  const page = fake.page('https://evil-drainer.com/claim');
  const answer = ask(page, 'getAddresses', {});
  const r = await waiting('btcConnect', 'https://evil-drainer.com');
  const view = await ok('approval.get');
  assert.equal(view.risk.level, 'blocked');
  assert.match(await err('approval.resolve', { id: r.id, approve: true }), /phishing blocklist/);
  await ok('approval.reject', { id: r.id });
  assert.equal((await answer).error.code, 4001);
});

test('withstood: a Sign-In with Bitcoin message for another site, and a message hiding characters, need "i understand"', async () => {
  const page = fake.page('https://ordinals.example/');
  await connect(page, 'https://ordinals.example');
  const siwb = `magiceden.io wants you to sign in with your Bitcoin account:\n${SEGWIT}\n\nWelcome\n\nURI: https://magiceden.io\nNonce: 1234`;
  let answer = ask(page, 'signMessage', { address: SEGWIT, message: siwb });
  let r = await waiting('btcMessage');
  let view = await ok('approval.get');
  assert.deepEqual(view.btc.problems, ['it signs you in to magiceden.io, but the site asking is ordinals.example', 'its link points at magiceden.io, not ordinals.example']);
  assert.match(await err('approval.resolve', { id: r.id, approve: true }), /danger/);
  await ok('approval.resolve', { id: r.id, approve: true, ignoreRisk: true });
  assert.ok((await answer).result.signature);
  // a sign-in naming another address
  answer = ask(page, 'signMessage', { address: SEGWIT, message: `ordinals.example wants you to sign in with your Bitcoin account:\n${TAPROOT}\n` });
  r = await waiting('btcMessage');
  view = await ok('approval.get');
  assert.deepEqual(view.btc.problems, [`it signs in ${TAPROOT}, not the address signing it`]);
  await ok('approval.reject', { id: r.id });
  await answer;
  // right-to-left override and zero-width characters: shown as bytes, never as text
  answer = ask(page, 'signMessage', { address: TAPROOT, message: 'pay 1‮0 BTC​' });
  r = await waiting('btcMessage');
  view = await ok('approval.get');
  assert.equal(view.btc.text, null);
  assert.match(view.btc.hex, /e280ae/);
  assert.match(await err('approval.resolve', { id: r.id, approve: true }), /danger/);
  await ok('approval.reject', { id: r.id });
  await answer;
});

test("withstood: signing for an address that isn't the connected wallet's, before or after you switch wallets", async () => {
  const page = fake.page('https://ordinals.example/');
  assert.equal((await ask(page, 'signMessage', { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', message: 'hi' })).error.code, -32002);
  // a second wallet becomes active: the site was connected to the first one only
  const s = await ok('state');
  const after = await ok('wallet.add', { account: s.accounts[0].id });
  const w2 = after.wallets.find((w) => w.index === 1);
  assert.equal((await ask(page, 'signMessage', { address: SEGWIT, message: 'hi' })).error.code, -32002);
  assert.equal((await ask(page, 'signMessage', { address: w2.chains.btc.address, message: 'hi' })).error.code, -32002);
  assert.equal((await ask(page, 'wallet_getAccount')).error.code, -32002);
  await ok('wallet.select', { id: s.wallets[0].id });
  assert.equal((await ask(page, 'wallet_getAccount')).result.addresses[0].address, SEGWIT);
});

test('withstood: a subdomain, or another site, gets nothing from a connection it never made', async () => {
  for (const url of ['https://evil.ordinals.example/', 'https://ordinals.example.evil.com/', 'http://localhost:9/']) {
    const page = fake.page(url);
    assert.equal((await ask(page, 'getBalance')).error.code, -32002, url);
    assert.equal((await ask(page, 'signPsbt', { psbt: 'cHNidP8BAAoCAAAAAAAAAAAAAA==' })).error.code, -32002, url);
    assert.equal((await ask(page, 'sendTransfer', { recipients: [{ address: TAPROOT, amount: 1000 }] })).error.code, -32002, url);
  }
  // a page in a frame, or a page that isn't https: its port is refused outright (main.js)
  const framed = fake.page('https://ordinals.example/', { frameId: 3 });
  assert.equal(framed.port.disconnected, true);
});

test('withstood: a flood of connects from one site and its subdomains: five wait, the rest are turned away', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => fake.page(`https://s${i}.flood.example/`));
  const answers = pages.map((p) => ask(p, 'getAddresses', {}));
  await sleep(100);
  assert.equal([..._test.pending.values()].filter((r) => r.origin.endsWith('flood.example')).length, 5);
  const turned = (await Promise.race([Promise.all(answers.slice(5)), sleep(1000).then(() => null)]));
  assert.ok(turned?.every((a) => a.error?.code === 4100));
  const first = [..._test.pending.values()].find((r) => r.origin.endsWith('flood.example'));
  assert.equal(await ok('approval.rejectSite', { id: first.id }), 5);
  await Promise.all(answers.slice(0, 5));
});

test('withstood: oversized and malformed requests are refused in words, nothing queued', async () => {
  const page = fake.page('https://ordinals.example/');
  const big = 'x'.repeat(17 * 1024);
  assert.match((await ask(page, 'signMessage', { address: SEGWIT, message: big })).error.message, /16 KB at most/);
  assert.match((await ask(page, 'signMessage', { address: SEGWIT, message: { toString: () => 'hi' } })).error.message, /must be text/);
  assert.match((await ask(page, 'sendTransfer', { recipients: Array(21).fill({ address: TAPROOT, amount: 1000 }) })).error.message, /1 to 20/);
  assert.match((await ask(page, 'sendTransfer', { recipients: [{ address: TAPROOT, amount: 1.5 }] })).error.message, /whole number of sats/);
  assert.match((await ask(page, 'sendTransfer', { recipients: [{ address: TAPROOT, amount: -5 }] })).error.message, /whole number of sats/);
  assert.match((await ask(page, 'getAddresses', { purposes: Array(50).fill('payment') })).error.message, /malformed/);
  assert.equal((await page.request('btc', { params: {} })).error.code, -32600);
  assert.equal([..._test.pending.values()].length, 0);
});

test("withstood: disconnecting Bitcoin leaves the site's Solana connection alone, and a revoke in plum takes all of it", async () => {
  const page = fake.page('https://ordinals.example/');
  const sol = page.request('connect');
  const r = await waiting('connect', 'https://ordinals.example');
  await ok('approval.resolve', { id: r.id, approve: true });
  await sol;
  await ask(page, 'wallet_disconnect');
  const site = (await ok('sites')).find((s) => s.origin === 'https://ordinals.example');
  assert.deepEqual(site.btc, []);
  assert.equal(site.accounts.length, 1);
  await connect(page, 'https://ordinals.example');
  await ok('sites.revoke', { origin: 'https://ordinals.example' });
  assert.equal((await ok('sites')).some((s) => s.origin === 'https://ordinals.example'), false);
  assert.equal((await ask(page, 'wallet_getAccount')).error.code, -32002);
});
