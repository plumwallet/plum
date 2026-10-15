// Ethereum's other networks (Base, Arbitrum One, Polygon PoS) next to Ethereum itself: the network table, a
// transaction signed for each (its chain id inside the signature), fees by each network's rules (Arbitrum takes no tip,
// Polygon wants at least 25 gwei, Base charges for its room on Ethereum), and in the background: balances, tokens and
// history on every network, sends on each, your own RPC per network, and a phrase scan that finds a wallet used only
// on one of them. The chains are stand-ins (fake-net.mjs); the code under test is plum's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransaction, recoverTransactionAddress, serializeTransaction } from 'viem';
import * as E from '../src/background/eth.js';
import { EVM_NETWORKS, MAINNET, chainHex, chainIdOf, networkById, networkByKey, unsupportedChain } from '../src/background/evm-chains.js';
import { signEthDigest } from '../src/background/keys.js';
import { fakeNet } from './fake-net.mjs';
import { ABANDON, boot } from './redteam/helpers.mjs';

const KEY = new Uint8Array(32).fill(7);
const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // m/44'/60'/0'/0/0 of the "abandon" phrase
const TO = '0x2222222222222222222222222222222222222222';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GWEI = 1_000_000_000n;

// the background on stand-in chains, set up before any test runs (the unit tests below swap fetch for a moment)
const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, err } = ctx;
const lower = (a) => a.toLowerCase();

/* ------------------------------------------------------------ the table */

test('four networks, found by key or by any spelling of their chain id; anything else is named and refused', () => {
  assert.deepEqual(EVM_NETWORKS.map((n) => [n.key, n.id, chainHex(n), n.native.symbol]), [
    ['ethereum', 1, '0x1', 'ETH'], ['base', 8453, '0x2105', 'ETH'], ['arbitrum', 42161, '0xa4b1', 'ETH'], ['polygon', 137, '0x89', 'POL'],
  ]);
  for (const id of ['0x2105', '0x02105', '8453', 8453, 8453n, ' 0x2105 ']) assert.equal(networkById(id)?.key, 'base', String(id));
  for (const id of ['0x', '', 'base', -1, 0, '0x0', 1.5, '1e3', null, undefined, {}, [], '0x' + 'f'.repeat(70), 2 ** 60]) assert.equal(networkById(id), null, JSON.stringify(id));
  assert.equal(chainIdOf('0x1'), 1n);
  assert.equal(networkByKey('optimism'), null);
  assert.equal(networkByKey('constructor'), null);
  assert.equal(unsupportedChain('0xa'), "Plum doesn't work on Optimism (chain 10): it works on Ethereum, Base, Arbitrum and Polygon only");
  assert.equal(unsupportedChain('0x7a69'), "Plum doesn't work on chain 31337: it works on Ethereum, Base, Arbitrum and Polygon only");
  assert.match(unsupportedChain('nope'), /isn't a chain id/);
  // every network has its own RPCs (all https), its own Blockscout and explorer
  for (const n of EVM_NETWORKS) {
    assert.ok(n.rpcs.length >= 3 && n.rpcs.every((u) => u.startsWith('https://')), n.key);
    assert.match(n.blockscout, /^https:\/\/[a-z]+\.blockscout\.com\/api\/v2$/);
  }
  // only Ethereum's sends go through MEV Blocker
  assert.deepEqual(EVM_NETWORKS.map((n) => n.private.length), [1, 0, 0, 0]);
});

test("a transaction carries its network's chain id in what's signed, so it can't be replayed on another", () => {
  const tx = { nonce: 5n, maxPriorityFeePerGas: GWEI, maxFeePerGas: 3n * GWEI, gas: 21_000n, to: TO, value: 10n ** 15n, data: '0x' };
  const digests = new Set();
  for (const n of EVM_NETWORKS) {
    const t = { ...tx, chainId: n.id };
    const raw = E.signedTx(t, signEthDigest(E.txDigest(t), KEY));
    const parsed = parseTransaction(E.toHex(raw));
    assert.equal(parsed.chainId, n.id);
    assert.equal(parsed.type, 'eip1559');
    // the same bytes viem would sign for that network
    assert.equal(E.toHex(E.unsignedTx(t)), serializeTransaction({ type: 'eip1559', chainId: n.id, nonce: 5, maxPriorityFeePerGas: GWEI, maxFeePerGas: 3n * GWEI, gas: 21_000n, to: TO, value: 10n ** 15n, data: '0x' }));
    digests.add(E.toHex(E.txDigest(t)));
  }
  assert.equal(digests.size, 4);
  // no chain id at all is Ethereum, as before
  assert.equal(E.toHex(E.txDigest(tx)), E.toHex(E.txDigest({ ...tx, chainId: 1 })));
});

/* ------------------------------------------------------------ fees */

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body });
    const out = await handler(String(url), body);
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), { status: out.status ?? 200 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const rpcResult = (result) => ({ body: { jsonrpc: '2.0', id: 1, result } });

test("fees follow each network's rules: no tip on Arbitrum, at least 30 gwei on Polygon, a tenth of a gwei-cent on Base", async () => {
  const quote = (net, base, tips) => withFetch((url, b) => {
    if (b.method === 'eth_getBlockByNumber') return rpcResult({ baseFeePerGas: E.qty(base) });
    if (b.method === 'eth_feeHistory') return rpcResult({ reward: tips.map((x) => [E.qty(x)]) });
    return { status: 404, body: '' };
  }, () => E.feeQuote(['https://rpc.test'], net));
  const arb = networkByKey('arbitrum'), pol = networkByKey('polygon'), base = networkByKey('base');
  assert.deepEqual(await quote(arb, 20_000_000n, [5n * GWEI]), { base: 20_000_000n, tip: 0n, maxFee: 40_000_000n });
  assert.deepEqual(await quote(pol, 250n * GWEI, [GWEI, 2n * GWEI]), { base: 250n * GWEI, tip: 30n * GWEI, maxFee: 530n * GWEI });
  assert.deepEqual(await quote(pol, 250n * GWEI, [78n * GWEI]), { base: 250n * GWEI, tip: 78n * GWEI, maxFee: 578n * GWEI });
  assert.deepEqual(await quote(base, 5_000_000n, [1n]), { base: 5_000_000n, tip: 1_000_000n, maxFee: 11_000_000n });
  // Ethereum's, as it always was
  assert.deepEqual(await quote(MAINNET, GWEI, [50n * GWEI]), { base: GWEI, tip: 3n * GWEI, maxFee: 5n * GWEI });
});

test("Base's fee for a transaction's room on Ethereum: GasPriceOracle.getL1Fee over the unsigned transaction", async () => {
  const base = networkByKey('base');
  const tx = { nonce: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21_000n, to: TO, value: 1n, data: '0x' };
  const got = await withFetch((url, b) => {
    assert.equal(b.method, 'eth_call');
    assert.equal(b.params[0].to, '0x420000000000000000000000000000000000000F');
    const data = b.params[0].data;
    assert.equal(data.slice(0, 10), '0x49948e0e');
    const unsigned = E.toHex(E.unsignedTx({ ...tx, chainId: 8453 })).slice(2);
    assert.equal(BigInt(`0x${data.slice(74, 138)}`), BigInt(unsigned.length / 2));
    assert.equal(data.slice(138, 138 + unsigned.length), unsigned);
    return rpcResult(`0x${(3_843_597_051n).toString(16).padStart(64, '0')}`);
  }, () => E.l1Fee(['https://rpc.test'], tx, base));
  assert.equal(got, 3_843_597_051n);
  // other networks have none, and nothing is asked
  assert.equal(await withFetch(() => { throw new Error('asked'); }, () => E.l1Fee(['https://rpc.test'], tx, networkByKey('arbitrum'))), 0n);
  // an oracle that fails is "not known", never zero
  assert.equal(await withFetch(() => ({ body: { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } } }), () => E.l1Fee(['https://rpc.test'], tx, base)), null);
});

/* ------------------------------------------------------------ the background, on every network */

test('balances: every network read, coins and tokens marked with their network; a network that fails is noted, not fatal', async () => {
  await ctx.setup();
  net.evm.ethereum.balances.set(lower(ETH_ME), 10n ** 18n);
  net.evm.base.balances.set(lower(ETH_ME), 2n * 10n ** 17n);
  net.evm.polygon.balances.set(lower(ETH_ME), 40n * 10n ** 18n);
  const token = (address, symbol, value, rate = '1.0') => ({ token: { address_hash: address, type: 'ERC-20', decimals: '6', symbol, name: symbol, exchange_rate: rate }, value });
  net.evm.base.blockscout.tokens.set(lower(ETH_ME), [token(BASE_USDC, 'USDC', '25000000')]);
  // POL's own balance shows on Polygon's Blockscout as a token at 0x...1010 too: never a second POL
  net.evm.polygon.blockscout.tokens.set(lower(ETH_ME), [token('0x0000000000000000000000000000000000001010', 'POL', '40000000000000000000', '0.25')]);
  const b = await ok('balances', { chain: 'eth' });
  assert.equal(b.native.amount, String(10n ** 18n));
  assert.equal(b.native.usd, 2500);
  assert.deepEqual(b.networks.map((x) => [x.net, x.symbol, x.amount, x.usd]), [
    ['base', 'ETH', String(2n * 10n ** 17n), 500], ['arbitrum', 'ETH', '0', 0], ['polygon', 'POL', String(40n * 10n ** 18n), 10],
  ]);
  assert.deepEqual(b.tokens.map((t) => [t.net, t.symbol, t.amount]), [['base', 'USDC', '25000000']]);
  // Arbitrum's RPCs all down: noted on its line, the rest still read
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (/arbitrum|\/arb$|arb1/.test(String(url)) ? new Response('down', { status: 503 }) : real(url, o));
  try {
    const b2 = await ok('balances', { chain: 'eth' });
    const arb = b2.networks.find((x) => x.net === 'arbitrum');
    assert.equal(arb.amount, null);
    assert.match(arb.error, /503/);
    assert.equal(b2.networks.find((x) => x.net === 'base').amount, String(2n * 10n ** 17n));
  } finally { globalThis.fetch = real; }
});

test('sending on Base: the chain id is 8453, the fee counts its room on Ethereum, it goes to Base (not MEV Blocker), with a word about the network', async () => {
  const base = net.evm.base;
  base.balances.set(lower(ETH_ME), 10n ** 17n);
  base.nonces.set(lower(ETH_ME), 41n);
  base.baseFee = 5_000_000n;
  base.tip = 1_000_000n;
  const prep = await ok('send.prepare', { chain: 'eth', net: 'base', token: null, to: TO, amount: '0.01' });
  assert.deepEqual([prep.net, prep.netTitle, prep.symbol], ['base', 'Base', 'ETH']);
  assert.ok(prep.warnings.some((w) => /goes out on Base/.test(w.text)));
  const gas = 21_000n * 125n / 100n;
  const maxFee = 2n * 5_000_000n + 1_000_000n;
  assert.equal(BigInt(prep.preview.fee.max), gas * maxFee + 2n * base.l1Fee, 'the most it can cost counts the room on Ethereum, twice over');
  assert.equal(BigInt(prep.preview.fee.est), gas * (5_000_000n + 1_000_000n) + base.l1Fee);
  const mev = net.evm.ethereum.calls.length;
  const done = await ok('send.submit', { id: prep.id });
  const raw = base.sent.at(-1);
  const tx = parseTransaction(raw);
  assert.deepEqual([tx.chainId, tx.nonce, tx.to, tx.value], [8453, 41, TO, 10n ** 16n]);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME, 'one signer: your wallet');
  assert.match(done.explorer, /^https:\/\/basescan\.org\/tx\/0x/);
  assert.equal(net.evm.ethereum.calls.length, mev, 'nothing went to Ethereum (or MEV Blocker)');
  assert.equal((await ok('tx.status', { signature: done.signature })).net, 'base');
});

test("sending on Arbitrum: the gas is Arbitrum's own estimate (it counts the Ethereum data cost), never a bare 21,000; no tip", async () => {
  const arb = net.evm.arbitrum;
  arb.balances.set(lower(ETH_ME), 10n ** 17n);
  arb.estimate = () => 23_812n;
  arb.baseFee = 20_000_000n;
  arb.tip = 7n * GWEI; // what an RPC says others paid; Arbitrum ignores tips, so plum pays none
  const prep = await ok('send.prepare', { chain: 'eth', net: 'arbitrum', to: TO, amount: '0.001' });
  assert.equal(prep.preview.fee.gas, String(23_812n * 125n / 100n));
  await ok('send.submit', { id: prep.id });
  const tx = parseTransaction(arb.sent.at(-1));
  assert.deepEqual([tx.chainId, tx.gas, tx.maxPriorityFeePerGas ?? 0n, tx.maxFeePerGas], [42161, 23_812n * 125n / 100n, 0n, 40_000_000n]);
});

test("sending POL on Polygon, and a token there: POL by name, at least Polygon's minimum tip", async () => {
  const pol = net.evm.polygon;
  pol.balances.set(lower(ETH_ME), 50n * 10n ** 18n);
  pol.baseFee = 250n * GWEI;
  pol.tip = 2n * GWEI;
  const prep = await ok('send.prepare', { chain: 'eth', net: 'polygon', to: TO, amount: '12.5' });
  assert.equal(prep.symbol, 'POL');
  assert.deepEqual(prep.preview.changes, [{ symbol: 'POL', decimals: 18, delta: String(-(125n * 10n ** 17n)), verified: true }]);
  await ok('send.submit', { id: prep.id });
  const tx = parseTransaction(pol.sent.at(-1));
  assert.deepEqual([tx.chainId, tx.maxPriorityFeePerGas], [137, 30n * GWEI]);
  // a token on Polygon: transfer() on that token's contract there
  const usdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
  pol.tokens.set(lower(usdc), { decimals: 6, symbol: 'USDC', name: 'USD Coin', price: 1, balances: new Map([[lower(ETH_ME), 9_000_000n]]) });
  const t = await ok('send.prepare', { chain: 'eth', net: 'polygon', token: usdc, to: TO, amount: '2' });
  assert.equal(t.symbol, 'USDC');
  await ok('send.submit', { id: t.id });
  const tt = parseTransaction(pol.sent.at(-1));
  assert.deepEqual([tt.chainId, tt.to, tt.data.slice(0, 10)], [137, usdc.toLowerCase(), '0xa9059cbb']);
  // not enough POL for the fee: said in POL
  pol.balances.set(lower(ETH_ME), 1n);
  assert.match(await err('send.prepare', { chain: 'eth', net: 'polygon', to: TO, amount: '0.5' }), /not enough POL/);
});

test('the most you can send on Base leaves its fee and its room on Ethereum', async () => {
  const base = net.evm.base;
  base.balances.set(lower(ETH_ME), 10n ** 16n);
  const max = await ok('send.max', { chain: 'eth', net: 'base', token: null });
  // the send's own gas and a tenth more, at the most the fee can be, and twice the room on Ethereum
  const gas = 21_000n * 125n * 11n / 1000n;
  assert.equal(max, E.units(10n ** 16n - gas * (2n * base.baseFee + base.tip) - 2n * base.l1Fee, 18));
  const prep = await ok('send.prepare', { chain: 'eth', net: 'base', to: TO, amount: max });
  assert.equal(prep.amount, max);
});

test('history from every network, each marked with it and linked to its own explorer', async () => {
  const h = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
  net.evm.base.blockscout.txs.set(lower(ETH_ME), [{ hash: h(4), timestamp: '2026-05-01T00:00:00Z', status: 'ok', block_number: 9 }]);
  net.evm.polygon.blockscout.txs.set(lower(ETH_ME), [{ hash: h(5), timestamp: '2026-04-01T00:00:00Z', status: 'error', block_number: 8 }]);
  const { items } = await ok('activity');
  const mine = items.filter((x) => x.id === h(4) || x.id === h(5));
  assert.deepEqual(mine.map((x) => [x.net, x.tag, x.ok, x.explorer]), [
    ['base', 'base', true, `https://basescan.org/tx/${h(4)}`], ['polygon', 'pol', false, `https://polygonscan.com/tx/${h(5)}`],
  ]);
});

test('your own RPC per network: checked to be on that network before it is kept, then used for it alone', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, o) => {
    const u = new URL(String(url));
    if (u.host === 'my-rpc.example') {
      const b = JSON.parse(o.body);
      asked.push(b.method);
      // an RPC that is really on Ethereum
      const result = b.method === 'eth_chainId' ? (u.pathname === '/base' ? '0x2105' : '0x1') : b.method === 'eth_getBalance' ? '0x2a' : '0x0';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
    }
    return real(url, o);
  };
  try {
    assert.match(await err('settings.set', { patch: { evmRpc: { base: 'https://my-rpc.example/wrong' } } }), /that RPC is for Ethereum, not Base \(chain 8453\)/);
    await ok('settings.set', { patch: { evmRpc: { base: 'https://my-rpc.example/base' } } });
    const s = await ok('state');
    assert.equal(s.evm.find((n) => n.key === 'base').rpc, 'https://my-rpc.example/base');
    const b = await ok('balances', { chain: 'eth' });
    assert.equal(b.networks.find((x) => x.net === 'base').amount, '42');
    assert.ok(asked.includes('eth_getBalance'));
    // Ethereum's own goes where it always went (ethRpc)
    await ok('settings.set', { patch: { evmRpc: { base: '' } } });
    assert.equal((await ok('state')).evm.find((n) => n.key === 'base').rpc, '');
    assert.match(await err('settings.set', { patch: { evmRpc: { polygon: 'http://insecure.example' } } }), /https/);
  } finally { globalThis.fetch = real; }
});

test('a phrase scan finds a wallet used only on Base, and calls one unknown when a network could not be asked', async () => {
  const { addressOf, schemePaths, secretAt, seedOf } = await import('../src/background/keys.js');
  const at = (n) => addressOf('eth', secretAt(seedOf(ABANDON), 'eth', schemePaths('bip44change', n).eth));
  net.evm.base.nonces.set(lower(at(2)), 3n);
  const found = await ok('scanPhrase', { mnemonic: ABANDON });
  const w3 = found.find((f) => f.scheme === 'bip44change' && f.index === 2);
  assert.equal(w3.chains.eth.used, true);
  assert.equal(w3.used, true);
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (/polygon|matic/.test(String(url)) ? new Response('down', { status: 503 }) : real(url, o));
  try {
    const again = await ok('scanPhrase', { mnemonic: ABANDON });
    const w2 = again.find((f) => f.scheme === 'bip44change' && f.index === 1);
    assert.equal(w2.chains.eth.used, null, "Polygon couldn't be asked, so wallet 2's Ethereum side is unknown, not unused");
  } finally { globalThis.fetch = real; }
});

test("NFTs on every network: listed from each network's Blockscout and marked with it; sent on their own network only", async () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const item = (contract, id, name) => ({ id, token_type: 'ERC-721', value: '1', metadata: { name }, token: { address_hash: contract, name: 'Things', symbol: 'T', type: 'ERC-721', reputation: 'ok' } });
  const BASE_NFT = '0x7777777777777777777777777777777777777777';
  const POL_NFT = '0x8888888888888888888888888888888888888888';
  net.evm.base.blockscout.nfts.set(lower(ETH_ME), [item(BASE_NFT, '5', 'a base thing')]);
  net.evm.polygon.blockscout.nfts.set(lower(ETH_ME), [item(POL_NFT, '9', 'a polygon thing')]);
  const r = await ok('nfts.list', { chain: 'eth' });
  assert.deepEqual(r.items.map((n) => [n.name, n.net, n.network]), [['a base thing', 'base', 'base'], ['a polygon thing', 'polygon', 'pol']]);
  assert.deepEqual(r.errors, []);
  // the Polygon one: Polygon's contract says it's yours; it's simulated, signed and sent on Polygon
  const pol = net.evm.polygon;
  pol.balances.set(lower(ETH_ME), 10n ** 18n);
  pol.ethCall = ({ to, data }) => (lower(to) === lower(POL_NFT) && data.startsWith('0x6352211e') ? pad(ETH_ME) : undefined);
  pol.simulate = () => ({ status: '0x1', returnData: '0x', gasUsed: '0x15f90', logs: [{ address: lower(POL_NFT), topics: [TRANSFER, pad(ETH_ME), pad(TO), `0x${(9).toString(16).padStart(64, '0')}`], data: '0x' }] });
  try {
    const prep = await ok('nfts.prepare', { chain: 'eth', net: 'polygon', contract: POL_NFT, id: '9', standard: 'erc721', to: TO });
    assert.deepEqual([prep.net, prep.preview.net.key], ['polygon', 'polygon']);
    assert.ok(prep.warnings.some((w) => /goes out on Polygon/.test(w.text)));
    assert.ok(prep.preview.warnings.some((w) => /an NFT leaves your wallet: #9/.test(w.text)));
    await ok('nfts.submit', { id: prep.id });
    const tx = parseTransaction(pol.sent.at(-1));
    assert.deepEqual([tx.chainId, tx.to.toLowerCase(), tx.data.slice(0, 10)], [137, lower(POL_NFT), '0x42842e0e']);
    assert.equal(await recoverTransactionAddress({ serializedTransaction: pol.sent.at(-1) }), ETH_ME);
    // the same NFT asked for on Base: Base's contract doesn't say it's yours, so nothing is built
    assert.match(await err('nfts.prepare', { chain: 'eth', net: 'base', contract: POL_NFT, id: '9', standard: 'erc721', to: TO }), /isn't in this wallet/);
  } finally { pol.ethCall = null; pol.simulate = null; }
  // a network whose Blockscout is down is named, and the others are still listed
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (/arbitrum\.blockscout/.test(String(url)) ? new Response('down', { status: 503 }) : real(url, o));
  try {
    const r2 = await ok('nfts.list', { chain: 'eth' });
    assert.equal(r2.items.length, 2);
    assert.match(r2.errors.join(' '), /^arbitrum: /);
  } finally { globalThis.fetch = real; }
});
