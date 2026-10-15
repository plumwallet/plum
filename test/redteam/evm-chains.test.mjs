// Attack: a site plays with networks. It moves between Ethereum, Base, Arbitrum and Polygon (and asks for chains plum
// doesn't know), switches while a request of its waits for you, names one chain in a request while it's on another,
// sends its own RPCs along with wallet_addEthereumChain, or edits what plum keeps on disk. Each request must stay on
// the network it was made on, be shown on it, simulated on it and signed for it; a site's network is its own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { fakeNet } from '../fake-net.mjs';
import { boot, sleep } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const SOMEONE = '0x1111111111111111111111111111111111111111';
const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { fake, ok, _test } = ctx;
const lower = (a) => a.toLowerCase();
const evmOf = (page) => (method, params) => page.request('evm', { method, params });

async function connectEvm(url) {
  const page = fake.page(url);
  const evm = evmOf(page);
  const answer = evm('eth_requestAccounts');
  const origin = new URL(url).origin;
  let entry;
  for (let i = 0; i < 200 && !(entry = [..._test.pending.values()].find((r) => r.origin === origin && r.kind === 'evmConnect')); i++) await sleep(5);
  assert.ok(entry, `no connect request from ${origin}`);
  await ok('approval.resolve', { id: entry.id, approve: true });
  assert.deepEqual((await answer).result, [ETH_ME]);
  return { page, evm };
}

const simulateTransfer = (c) => (call) => ({ status: '0x1', returnData: '0x', gasUsed: '0x5208', logs: [{ address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(24)}${call.from.slice(2).toLowerCase()}`, `0x${'0'.repeat(24)}${call.to.slice(2).toLowerCase()}`], data: call.value }], _net: c });
for (const c of Object.values(net.evm)) {
  c.balances.set(lower(ETH_ME), 10n ** 18n);
  c.simulate = simulateTransfer(c.key);
}

test('withstood: one site moving to Base leaves every other site where it was', async () => {
  await ctx.setup();
  const a = await connectEvm('https://a.example/');
  const b = await connectEvm('https://b.example/');
  assert.equal((await a.evm('wallet_switchEthereumChain', [{ chainId: '0x2105' }])).result, null);
  assert.equal((await a.evm('eth_chainId')).result, '0x2105');
  assert.equal((await b.evm('eth_chainId')).result, '0x1');
  // a site that was never connected has a network too (it's no secret), and moving it changes nobody else's
  const stranger = evmOf(fake.page('https://stranger.example/'));
  assert.equal((await stranger('wallet_switchEthereumChain', [{ chainId: '0x89' }])).result, null);
  assert.equal((await stranger('eth_chainId')).result, '0x89');
  assert.deepEqual((await stranger('eth_accounts')).result, []);
  assert.equal((await b.evm('eth_chainId')).result, '0x1');
  // tabs hear of a move (they ask again and see chainChanged)
  const before = fake.tabMessages.length;
  await b.evm('wallet_switchEthereumChain', [{ chainId: '0xa4b1' }]);
  assert.ok(fake.tabMessages.slice(before).some(([, m]) => m.type === 'plum-event'));
  // reads go to the site's own network
  const calls = net.evm.arbitrum.calls.length;
  await b.evm('eth_blockNumber');
  assert.equal(net.evm.arbitrum.calls.length, calls + 1);
});

test('withstood: wallet_addEthereumChain for a chain plum knows only moves the site: the RPCs it sends are never asked', async () => {
  const { evm } = await connectEvm('https://adder.example/');
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, o) => { asked.push(String(url)); return real(url, o); };
  try {
    const r = await evm('wallet_addEthereumChain', [{ chainId: '0x89', chainName: 'Polygon', rpcUrls: ['https://evil-rpc.example/'], nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, blockExplorerUrls: ['https://evil-scan.example/'] }]);
    assert.equal(r.result, null);
    assert.equal((await evm('eth_chainId')).result, '0x89');
    await evm('eth_getBalance', [ETH_ME, 'latest']);
  } finally { globalThis.fetch = real; }
  assert.ok(!asked.some((u) => /evil/.test(u)), `asked: ${asked.join(', ')}`);
  assert.ok(asked.some((u) => /polygon/.test(u)), "plum's own Polygon RPC answered");
});

test('withstood: chains plum does not work on are refused in plain words, and the site stays where it was', async () => {
  const { evm } = await connectEvm('https://wanderer.example/');
  for (const [method, id, code, re] of [
    ['wallet_switchEthereumChain', '0xa', 4902, /Optimism \(chain 10\)/],
    ['wallet_addEthereumChain', '0xa', 4200, /Optimism \(chain 10\)/],
    ['wallet_addEthereumChain', '0x7a69', 4200, /chain 31337/],
    ['wallet_switchEthereumChain', 'polygon', 4902, /isn't a chain id/],
    ['wallet_switchEthereumChain', undefined, 4902, /isn't a chain id/],
    ['wallet_switchEthereumChain', '0x' + 'f'.repeat(80), 4902, /isn't a chain id/],
  ]) {
    const r = await evm(method, id === undefined ? [{}] : [{ chainId: id }]);
    assert.equal(r.error?.code, code, `${method} ${id}`);
    assert.match(r.error.message, re);
    assert.match(r.error.message, /Ethereum, Base, Arbitrum and Polygon/);
  }
  assert.equal((await evm('wallet_switchEthereumChain', ['0x89'])).error?.code, 4902, 'a bare string is not the parameter object');
  assert.equal((await evm('eth_chainId')).result, '0x1');
});

test('withstood: a site that switches while its transaction waits: the request stays on the network it was made on, is shown, simulated and signed there', async () => {
  const { evm } = await connectEvm('https://switcher.example/');
  await evm('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  const answer = evm('eth_sendTransaction', [{ from: ETH_ME, to: SOMEONE, value: '0x2386f26fc10000' }]);
  const v = await ctx.nextApproval(1000);
  assert.equal(v.evmNet.key, 'base');
  // now the site moves to Polygon, hoping the transaction follows (or that the window shows the new network)
  assert.equal((await evm('wallet_switchEthereumChain', [{ chainId: '0x89' }])).result, null);
  const v2 = await ok('approval.get');
  assert.deepEqual([v2.id, v2.evmNet.key, v2.evmNet.siteNow], [v.id, 'base', 'Polygon'], 'still Base, and the window says the site moved');
  const polygonSims = net.evm.polygon.calls.filter(([, m]) => m === 'eth_simulateV1').length;
  const [p] = await ok('approval.preview', { id: v.id });
  assert.equal(p.net.key, 'base');
  assert.equal(net.evm.polygon.calls.filter(([, m]) => m === 'eth_simulateV1').length, polygonSims, 'nothing was simulated on Polygon');
  const polygonSent = net.evm.polygon.sent.length;
  await ok('approval.resolve', { id: v.id, approve: true });
  const hash = (await answer).result;
  const raw = net.evm.base.sent.at(-1);
  const tx = parseTransaction(raw);
  assert.equal(tx.chainId, 8453, 'signed for Base');
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME);
  assert.equal(net.evm.polygon.sent.length, polygonSent, 'nothing went to Polygon');
  assert.ok(hash.startsWith('0x'));
});

test('withstood: a transaction naming another chain than the one the site is on is refused, never signed for either', async () => {
  const { evm } = await connectEvm('https://mismatch.example/');
  await evm('wallet_switchEthereumChain', [{ chainId: '0xa4b1' }]);
  for (const [chainId, re] of [
    ['0x1', /for Ethereum \(chain 1\), but this site is on Arbitrum \(chain 42161\)/],
    ['0x2105', /for Base \(chain 8453\), but this site is on Arbitrum/],
    [10, /for chain 10, but this site is on Arbitrum/],
    ['junk', /chain junk, but this site is on Arbitrum/],
  ]) {
    const r = await evm('eth_sendTransaction', [{ from: ETH_ME, to: SOMEONE, value: '0x1', chainId }]);
    assert.equal(r.error?.code, 4901, String(chainId));
    assert.match(r.error.message, re);
  }
  assert.equal(_test.pending.size, 0);
  // the right chain id, written any way, is fine
  const answer = evm('eth_sendTransaction', [{ from: ETH_ME, to: SOMEONE, value: '0x1', chainId: 42161 }]);
  const v = await ctx.nextApproval(1000);
  assert.equal(v.evmNet.key, 'arbitrum');
  await ok('approval.reject', { id: v.id });
  assert.equal((await answer).error.code, 4001);
});

test('withstood: typed data for another chain than the site is on is a named danger that needs "i understand"', async () => {
  const { evm } = await connectEvm('https://typed.example/');
  await evm('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  const mail = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'contents', type: 'string' }] },
    primaryType: 'Mail', domain: { name: 'Ether Mail', chainId: 1 }, message: { contents: 'hi' },
  };
  const answer = evm('eth_signTypedData_v4', [ETH_ME, JSON.stringify(mail)]);
  const v = await ctx.nextApproval(1000);
  assert.equal(v.evmNet.key, 'base');
  const danger = v.typed.warnings.find((w) => w.level === 'danger');
  assert.match(danger?.text ?? '', /made for Ethereum \(chain 1\), not Base/);
  const r = await fake.ui('approval.resolve', { id: v.id, approve: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /i understand/);
  await ok('approval.reject', { id: v.id });
  await answer;
  // the same data for Base, on Base: no danger
  const right = evm('eth_signTypedData_v4', [ETH_ME, JSON.stringify({ ...mail, domain: { ...mail.domain, chainId: 8453 } })]);
  const v2 = await ctx.nextApproval(1000);
  assert.deepEqual(v2.typed.warnings, []);
  await ok('approval.reject', { id: v2.id });
  await right;
});

test('withstood: revoking a site sends it back to Ethereum; a network plum keeps on disk that it does not know is Ethereum', async () => {
  const { evm } = await connectEvm('https://forgotten.example/');
  await evm('wallet_switchEthereumChain', [{ chainId: '0x89' }]);
  await ok('sites.revoke', { origin: 'https://forgotten.example' });
  assert.equal((await evm('eth_chainId')).result, '0x1');
  // someone with the profile edits storage: a key plum doesn't know, junk instead of a map
  await fake.browser.storage.local.set({ evmChains: { 'https://edited.example': { net: 'optimism' }, 'https://proto.example': { net: '__proto__' } } });
  assert.equal((await evmOf(fake.page('https://edited.example/'))('eth_chainId')).result, '0x1');
  assert.equal((await evmOf(fake.page('https://proto.example/'))('eth_chainId')).result, '0x1');
  await fake.browser.storage.local.set({ evmChains: 'junk' });
  assert.equal((await evmOf(fake.page('https://edited.example/'))('eth_chainId')).result, '0x1');
  // and moving a site still works from there
  const p = evmOf(fake.page('https://edited.example/'));
  assert.equal((await p('wallet_switchEthereumChain', [{ chainId: '0x2105' }])).result, null);
  assert.equal((await p('eth_chainId')).result, '0x2105');
});

test("withstood: a flood of sites moving can't grow what plum keeps without end", async () => {
  for (let i = 0; i < 230; i++) await evmOf(fake.page(`https://s${i}.flood.example/`))('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  const kept = (await fake.browser.storage.local.get('evmChains')).evmChains;
  assert.ok(Object.keys(kept).length <= 200, `${Object.keys(kept).length} kept`);
  // the newest are the ones kept
  assert.equal((await evmOf(fake.page('https://s229.flood.example/'))('eth_chainId')).result, '0x2105');
});
