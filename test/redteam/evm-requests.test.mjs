// Attack: a malicious Ethereum page. What it can learn without being connected, what it keeps after a
// switch or a revoke, how many requests and windows it can cause, what one small message can make the background do,
// and whether a request can end up answered, or shown, by anything but you.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { parseTransaction, recoverMessageAddress } from 'viem';
import { b64encode, utf8 } from '../../src/shared/bytes.js';
import { fakeNet } from '../fake-net.mjs';
import { ME, boot, sleep } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const SOMEONE = '0x1111111111111111111111111111111111111111';
const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { fake, ok, _test } = ctx;

const evmOf = (page) => (method, params) => page.request('evm', { method, params });
const popups = () => fake.created.filter((o) => o.type === 'popup' && /approve\.html/.test(o.url)).length;
const newestWindow = () => Math.max(...fake.windows.keys());
const closeAll = () => { for (const id of [...fake.windows.keys()]) fake.closeWindow(id); };

/** A page whose Ethereum connection you approved (only that request is approved here). */
async function connectEvm(url, page = fake.page(url)) {
  const evm = evmOf(page);
  const answer = evm('eth_requestAccounts');
  const origin = new URL(url).origin;
  const until = Date.now() + 1000;
  let entry;
  while (!(entry = [..._test.pending.values()].find((r) => r.origin === origin && r.kind === 'evmConnect')) && Date.now() < until) await sleep(5);
  assert.ok(entry, `no connect request from ${origin}`);
  await ok('approval.resolve', { id: entry.id, approve: true });
  assert.deepEqual((await answer).result, [ETH_ME]);
  return { page, evm };
}

test('withstood: a page that is not connected learns no address and can queue nothing', async () => {
  await ctx.setup();
  const evm = evmOf(fake.page('https://stranger.example/'));
  assert.deepEqual((await evm('eth_accounts')).result, []);
  assert.deepEqual((await evm('wallet_getPermissions')).result, []);
  for (const [m, p] of [
    ['personal_sign', ['0x68', ETH_ME]], ['eth_signTypedData_v4', [ETH_ME, '{}']], ['eth_signTypedData_v3', [ETH_ME, '{}']],
    ['eth_sendTransaction', [{ from: ETH_ME, to: SOMEONE }]], ['eth_sign', [ETH_ME, `0x${'11'.repeat(32)}`]], ['eth_signTransaction', [{}]],
    ['wallet_sendCalls', [{}]], ['eth_signTypedData', [ETH_ME, '{}']], ['personal_ecRecover', ['0x', '0x']], ['eth_decrypt', ['0x', ETH_ME]],
    ['eth_getEncryptionPublicKey', [ETH_ME]], ['wallet_watchAsset', [{}]],
  ]) {
    const r = await evm(m, p);
    assert.ok(r.error, `${m} answered ${JSON.stringify(r.result)}`);
  }
  assert.equal(_test.pending.size, 0);
});

test('withstood: a Solana connection shows nothing on Ethereum, and an Ethereum one nothing on Solana', async () => {
  const sol = await ctx.connectSite('https://solonly.example/');
  const evmS = evmOf(sol);
  assert.deepEqual((await evmS('eth_accounts')).result, []);
  assert.match((await evmS('personal_sign', ['0x68', ETH_ME])).error.message, /connect to Plum first/);
  const { page } = await connectEvm('https://ethonly.example/');
  assert.deepEqual((await page.request('accounts')).result, []);
  assert.deepEqual((await page.request('connect', { silent: true })).result, []);
  assert.match((await page.request('signMessage', { account: ME, message: b64encode(utf8('x')) })).error.message, /connect to Plum first/);
  const sites = await ok('sites');
  assert.deepEqual(sites.find((x) => x.origin === 'https://ethonly.example').accounts, []);
  assert.deepEqual(sites.find((x) => x.origin === 'https://solonly.example').evm, []);
});

test('withstood: after a switch to another wallet, a site connected to the first sees nothing and can ask nothing of either', async () => {
  const { evm } = await connectEvm('https://switch.example/');
  const s = await ok('wallet.add', { account: (await ok('state')).accounts[0].id }); // adding selects it
  const eth2 = s.wallets.at(-1).chains.eth.address;
  try {
    assert.deepEqual((await evm('eth_accounts')).result, []);
    assert.deepEqual((await evm('wallet_getPermissions')).result, []);
    assert.match((await evm('personal_sign', ['0x68', ETH_ME])).error.message, /connect to Plum first/);
    assert.match((await evm('personal_sign', ['0x68', eth2])).error.message, /connect to Plum first/);
    assert.equal(_test.pending.size, 0);
  } finally { await ok('wallet.select', { id: s.wallets[0].id }); }
  assert.deepEqual((await evm('eth_accounts')).result, [ETH_ME]);
});

test('withstood: wallet_revokePermissions ends the connection; asking again needs you again', async () => {
  const { evm } = await connectEvm('https://revoker.example/');
  assert.equal((await evm('wallet_revokePermissions', [{ eth_accounts: {} }])).result, null);
  assert.deepEqual((await evm('eth_accounts')).result, []);
  assert.match((await evm('personal_sign', ['0x68', ETH_ME])).error.message, /connect to Plum first/);
  const again = evm('wallet_requestPermissions', [{ eth_accounts: {} }]);
  const v = await ctx.nextApproval();
  assert.equal(v.kind, 'evmConnect');
  await ok('approval.reject', { id: v.id });
  assert.equal((await again).error.code, 4001);
});

// FINDING (low): sites.revoke (and wallet_revokePermissions, and the Solana disconnect) only change the connected list:
// a request the site queued before it was revoked stays in the window and, if approved, its signature goes to the site.
test('FINDING (low): a site you revoke in plum still gets the signature it asked for before', async () => {
  const { evm } = await connectEvm('https://revoked.example/');
  const answer = evm('personal_sign', ['0x6c6f67696e', ETH_ME]);
  const v = await ctx.nextApproval();
  await ok('sites.revoke', { origin: 'https://revoked.example' });
  assert.deepEqual((await evm('eth_accounts')).result, [], 'the site is revoked');
  const r = await fake.ui('approval.resolve', { id: v.id, approve: true });
  const got = await answer;
  await ctx.rejectAll();
  assert.ok(!r.ok && !got.result, `after the revoke the site still received a signature by ${got.result ? await recoverMessageAddress({ message: { raw: '0x6c6f67696e' }, signature: got.result }) : '?'}`);
});

// FINDING (low): a page that was never connected reads the active wallet's own name (the one you typed) from the error
// eth_requestAccounts gives when that wallet has no Ethereum address (Solana's connect does the same the other way).
test("FINDING (low): any page learns the active wallet's name when it is an imported key of another chain", async () => {
  const s0 = await ok('state');
  await ok('importKey', { password: '', secret: JSON.stringify([...Keypair.generate().secretKey]), name: 'cold storage 2024' });
  try {
    const stranger = evmOf(fake.page('https://nosy.example/'));
    const r = await stranger('eth_requestAccounts');
    assert.ok(r.error);
    assert.ok(!/cold storage/.test(r.error.message), `a page that was never connected read: "${r.error.message}"`);
  } finally { await ok('wallet.select', { id: s0.active }); }
});

test('withstood: Solana and Ethereum requests from one site share its 5-request allowance, and a flood opens one window', async () => {
  closeAll();
  const before = popups();
  const page = await ctx.connectSite('https://both.example/');
  await connectEvm('https://both.example/', page);
  closeAll();
  const opened = popups();
  const evm = evmOf(page);
  const reqs = [];
  for (let i = 0; i < 8; i++) {
    reqs.push(page.request('signMessage', { account: ME, message: b64encode(utf8(`sol ${i}`)) }));
    reqs.push(evm('personal_sign', [`0x${Buffer.from(`eth ${i}`).toString('hex')}`, ETH_ME]));
    reqs.push(evm('eth_requestAccounts'));
  }
  await sleep(50);
  try {
    assert.ok(_test.pending.size <= 5, `${_test.pending.size} waiting from one site`);
    assert.equal(popups() - opened, 1, 'one window for the whole burst');
    assert.ok(opened - before <= 2);
  } finally {
    await ctx.rejectAll();
    await Promise.allSettled(reqs);
    closeAll();
  }
});

/** One array per level, each slot of a level pointing at the same array below: `depth` small arrays in the message,
 * width^depth numbers once something expands it. (Firefox's window.postMessage and its extension ports both carry
 * structured clones, which keep shared references; JSON.stringify expands every one.) */
function shared(width, depth) {
  let node = Array.from({ length: width }, (_, i) => i);
  for (let d = 1; d < depth; d++) { const inner = node; node = Array.from({ length: width }, () => inner); }
  return node;
}

// FINDING (medium): the background never bounds a page's params. A read-only call (allowed with no connection at all)
// is JSON.stringify'd into the RPC request, so a message of a few hundred bytes whose arrays share references expands
// to width^depth values: 120 references here are a ~2 MB request; depth 6 would be ~730 million numbers, and the
// background (in Firefox, the extension process every add-on shares) hangs or runs out of memory, plum with it
// (nothing can be approved or locked until the browser restarts).
test('FINDING (medium): one small message from any unconnected page makes the background build an exponentially large request', async () => {
  const sizes = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sizes.push(String(opts?.body ?? '').length); return real(url, opts); };
  const stranger = evmOf(fake.page('https://freeze.example/'));
  const t0 = performance.now();
  try {
    await stranger('eth_call', [{ to: SOMEONE, data: shared(30, 4) }, 'latest']);
  } finally { globalThis.fetch = real; }
  const ms = performance.now() - t0;
  const biggest = Math.max(0, ...sizes);
  assert.ok(biggest < 64 * 1024, `4 arrays of 30 references became a ${biggest.toLocaleString('en-US')}-byte request to the RPC (${ms.toFixed(0)} ms); each level more multiplies it by 30`);
});

// FINDING (medium, same root): typed data sent as an object (not a JSON string) has no size limit at all; its digest and
// its lines walk every shared reference. The same trick from a connected site costs the background width^depth hashes.
test('FINDING (medium, same root): typed data sent as an object is hashed however large it expands', async () => {
  const { evm } = await connectEvm('https://freeze-typed.example/');
  const td = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }], Big: [{ name: 'xs', type: 'uint8[][][][]' }] },
    primaryType: 'Big', domain: { name: 'x' }, message: { xs: shared(20, 4) },
  };
  const t0 = performance.now();
  const answer = evm('eth_signTypedData_v4', [ETH_ME, td]);
  let settled = false;
  answer.then(() => { settled = true; });
  while (!_test.pending.size && !settled) await sleep(2);
  const ms = performance.now() - t0;
  const queued = _test.pending.size;
  await ctx.rejectAll();
  await answer;
  assert.equal(queued, 0, `4 small arrays (80 references) were hashed as 160,000 values (${ms.toFixed(0)} ms) and queued; 64 KB is the limit for the same data as a string`);
});

test('withstood: a request that arrives while the approval window closes itself gets a window of its own and is not rejected', async () => {
  closeAll();
  const { evm } = await connectEvm('https://lifecycle.example/');
  closeAll();
  const a = evm('personal_sign', ['0x61', ETH_ME]);
  const va = await ctx.nextApproval();
  const w1 = newestWindow();
  await ok('approval.resolve', { id: va.id, approve: true });
  await a;
  // the window finds nothing left, says so, and starts closing; a request lands before it's gone
  assert.equal(await ok('approval.get'), null);
  assert.equal(await ok('approval.done'), 0);
  const before = popups();
  const b = evm('personal_sign', ['0x62', ETH_ME]);
  const vb = await ctx.nextApproval();
  await sleep(10);
  assert.equal(popups() - before, 1, 'it opened a window of its own');
  const w2 = newestWindow();
  assert.notEqual(w2, w1);
  fake.closeWindow(w1);
  await sleep(5);
  assert.equal((await ok('approval.get'))?.id, vb.id, 'the old window closing did not answer it');
  // and closing the window that shows it is still a "no"
  fake.closeWindow(w2);
  assert.equal((await b).error?.code, 4001);
  assert.equal(_test.pending.size, 0);
});

test('withstood: "done" while something waits keeps the window, and closing it is still a "no" for what it shows', async () => {
  closeAll();
  const { evm } = await connectEvm('https://lifecycle2.example/');
  closeAll();
  const a = evm('personal_sign', ['0x63', ETH_ME]);
  await ctx.nextApproval();
  const w = newestWindow();
  assert.equal(await ok('approval.done'), 1);
  fake.closeWindow(w);
  assert.equal((await a).error?.code, 4001);
});

test('withstood: a blocklisted site connecting needs "i understand", and its transaction fields are refused or kept, never mixed', async () => {
  const evil = evmOf(fake.page('https://evil-drainer.com/'));
  const ask = evil('eth_requestAccounts');
  const v = await ctx.nextApproval();
  assert.equal(v.risk.level, 'blocked');
  const r = await fake.ui('approval.resolve', { id: v.id, approve: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /phishing/);
  await ok('approval.reject', { id: v.id });
  await ask;

  const { evm } = await connectEvm('https://fields.example/');
  for (const [tx, re] of [
    [{ from: SOMEONE, to: SOMEONE }, /isn't the one connected/],
    [{ to: SOMEONE, chainId: '0x89' }, /chain 1/],
    [{ to: SOMEONE, chainId: 'abc' }, /./],
    [{ to: SOMEONE, value: '1.5' }, /value is malformed/],
    [{ to: SOMEONE, value: '-1' }, /value is malformed/],
    [{ to: SOMEONE, data: '0xzz' }, /data is malformed/],
    [{ to: 'not an address' }, /isn't an Ethereum address/],
    [{ to: SOMEONE, gas: 'lots' }, /gas is malformed/],
  ]) {
    const res = await evm('eth_sendTransaction', [tx]);
    assert.match(res.error?.message ?? '(answered)', re, JSON.stringify(tx));
  }
  assert.equal(_test.pending.size, 0);
  // `data` and `input` both given: the one shown is the one signed
  net.eth.balances.set(ETH_ME.toLowerCase(), 10n ** 18n);
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] });
  const answer = evm('eth_sendTransaction', [{ to: SOMEONE, data: '0xaaaaaaaa', input: '0xbbbbbbbb' }]);
  const vt = await ctx.nextApproval();
  const [p] = await ok('approval.preview', { id: vt.id });
  await ok('approval.resolve', { id: vt.id, approve: true });
  await answer;
  assert.equal(p.call.name, '0xaaaaaaaa');
  assert.equal(parseTransaction(net.eth.sent.at(-1)).data, '0xaaaaaaaa');
});
