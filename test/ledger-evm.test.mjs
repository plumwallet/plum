// A Ledger wallet on Ethereum, Base, Arbitrum and Polygon: every transaction plum builds or a site sends is signed on
// the device for its own network (its chain id inside what the device signs), one signature each, recovering to the
// Ledger's address: sends on each network, a site's transaction on Base, a swap's exact approval and the swap, Lido's
// stake, request and claim, an NFT on Polygon. With blind signing off, a token send stops before anything leaves; a no
// on the device in the middle of a swap leaves only the approval sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, fromRlp, parseAbi, recoverTransactionAddress, zeroAddress } from 'viem';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { addressOf, secretAt, seedOf } from '../src/background/keys.js';
import { fakeLedger } from './fake-ledger.mjs';
import { fakeNet } from './fake-net.mjs';
import { boot, sleep } from './redteam/helpers.mjs';

const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ME = addressOf('eth', secretAt(seedOf(LEGAL), 'eth', "m/44'/60'/0'/0/0"));
const TO = '0x4444444444444444444444444444444444444444';
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const EXECUTOR = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TOKEN = { ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' };
const IDS = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137 };
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const QUEUE = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';
const NFT = '0x9999999999999999999999999999999999999999';
const lower = (a) => a.toLowerCase();

const T = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;

const topic = (sig) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex')}`;
const TRANSFER = topic('Transfer(address,address,uint256)');
const APPROVAL = topic('Approval(address,address,uint256)');
const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const log = (address, t, a, b, v) => ({ address: lower(address), topics: [t, pad(a), pad(b)], data: word(v) });
const abi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function requestWithdrawals(uint256[] amounts, address owner) returns (uint256[])',
]);

// every network: coins and a token for the Ledger's address, simulations that move what they're told, KyberSwap honest
for (const [key, c] of Object.entries(net.evm)) {
  c.balances.set(lower(ME), 10n ** 20n);
  c.tokens.set(lower(TOKEN[key]), { decimals: 6, symbol: 'USDC', name: 'USD Coin', price: 1, balances: new Map([[lower(ME), 10n ** 9n]]), allowances: new Map() });
  c.simulate = (call) => {
    if (call.data?.startsWith('0x095ea7b3')) {
      const { args: [spender, amount] } = decodeFunctionData({ abi, data: call.data });
      return { status: '0x1', gasUsed: '0xb3b0', returnData: '0x', logs: amount ? [log(call.to, APPROVAL, call.from, spender, amount)] : [] };
    }
    if (call.data?.startsWith('0xe21fd0e9')) {
      const d = decodeFunctionData({ abi, data: call.data }).args[0].desc;
      const sell = d.srcToken === NATIVE ? log(NATIVE, TRANSFER, call.from, ROUTER, d.amount) : log(d.srcToken, TRANSFER, call.from, EXECUTOR, d.amount);
      const buy = d.dstToken === NATIVE ? log(NATIVE, TRANSFER, ROUTER, d.dstReceiver, d.minReturnAmount + 1n) : log(d.dstToken, TRANSFER, EXECUTOR, d.dstReceiver, d.minReturnAmount + 1n);
      return { status: '0x1', gasUsed: '0x2bf20', returnData: '0x', logs: [sell, buy] };
    }
    const nft = (a, b, id) => ({ address: lower(QUEUE), topics: [TRANSFER, pad(a), pad(b), word(id)], data: '0x' });
    if (call.data?.startsWith('0xa1903eab')) return { status: '0x1', gasUsed: '0x12c87', returnData: '0x', logs: [log(NATIVE, TRANSFER, call.from, STETH, BigInt(call.value)), log(STETH, TRANSFER, zeroAddress, call.from, BigInt(call.value) - 1n)] };
    if (call.data?.startsWith('0xd6681042')) {
      const { args: [amounts] } = decodeFunctionData({ abi, data: call.data });
      return { status: '0x1', gasUsed: '0x27100', returnData: '0x', logs: [log(STETH, TRANSFER, call.from, QUEUE, amounts.reduce((n, x) => n + x, 0n)), ...amounts.map((_, i) => nft(zeroAddress, call.from, 300 + i))] };
    }
    if (call.data?.startsWith('0xf8444436')) return { status: '0x1', gasUsed: '0x11170', returnData: '0x', logs: [log(NATIVE, TRANSFER, QUEUE, call.from, 10n ** 18n), nft(call.from, zeroAddress, BigInt(`0x${call.data.slice(10)}`))] };
    return { status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: call.value && BigInt(call.value) ? [log(NATIVE, TRANSFER, call.from, call.to, BigInt(call.value))] : [] };
  };
}
// Lido: some stETH, and one finalized withdrawal request (#77) of the Ledger's
net.evm.ethereum.tokens.set(lower(STETH), { decimals: 18, symbol: 'stETH', name: 'stETH', price: 2500, balances: new Map([[lower(ME), 3n * 10n ** 18n]]), allowances: new Map() });
net.evm.ethereum.ethCall = ({ to, data }) => {
  if (lower(to) !== lower(QUEUE)) return undefined;
  if (data.startsWith('0x7d031b65')) return `0x${[32n, 1n, 77n].map((n) => word(n).slice(2)).join('')}`;
  if (data.startsWith('0xb8c4b85a')) return `0x${[32n, 1n, 10n ** 18n, 10n ** 18n, BigInt(ME), 1n, 1n, 0n].map((n) => word(n).slice(2)).join('')}`;
  return undefined;
};
// an NFT of the Ledger's on Polygon
net.evm.polygon.ethCall = ({ to, data }) => (lower(to) === lower(NFT) && data.startsWith('0x6352211e') ? pad(ME) : undefined);
const coinUsd = (key) => (key === 'polygon' ? 0.25 : 2500);
net.kyber.routes = (q, key) => {
  const out = q.tokenIn === NATIVE ? BigInt(Math.round((Number(q.amountIn) / 1e18) * coinUsd(key) * 1e6)) : BigInt(Math.round((Number(q.amountIn) / 1e6 / coinUsd(key)) * 1e18));
  return { routeSummary: { tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, amountOut: String(out), route: [] }, routerAddress: ROUTER };
};
net.kyber.build = (b) => {
  const s = b.routeSummary;
  const min = (BigInt(s.amountOut) * BigInt(10_000 - b.slippageTolerance)) / 10_000n;
  const execution = { callTarget: EXECUTOR, approveTarget: zeroAddress, targetData: '0x01', desc: { srcToken: s.tokenIn, dstToken: s.tokenOut, srcReceivers: s.tokenIn === NATIVE ? [] : [EXECUTOR], srcAmounts: s.tokenIn === NATIVE ? [] : [BigInt(s.amountIn)], feeReceivers: [], feeAmounts: [], dstReceiver: b.recipient, amount: BigInt(s.amountIn), minReturnAmount: min, flags: 0x200n, permit: '0x' }, clientData: '0x' };
  return { amountIn: s.amountIn, amountOut: s.amountOut, data: encodeFunctionData({ abi, functionName: 'swap', args: [execution] }), routerAddress: ROUTER, transactionValue: s.tokenIn === NATIVE ? s.amountIn : '0' };
};

await T.setup();
const D = await import('../src/background/ledger/device.js');
const dev = fakeLedger({ mnemonic: LEGAL, app: 'Ethereum' });
D._setOpener(dev.opener);
D._setWait(1500);
const scan = await T.ok('ledger.scan', { chains: ['eth'] });
const added = await T.ok('ledger.add', { id: scan.id, keys: ['plum:0'] });
const wallet = added.wallets.find((w) => w.scheme === 'ledger');
await T.ok('wallet.select', { id: wallet.id });

/** A raw transaction taken apart: its type, chain, and how many signatures it carries. */
async function signers(raw) {
  assert.equal(raw.slice(0, 4), '0x02', 'an EIP-1559 transaction');
  const fields = fromRlp(`0x${raw.slice(4)}`);
  assert.equal((fields.length - 9) % 3, 0);
  return { count: (fields.length - 9) / 3, chainId: Number(BigInt(fields[0] === '0x' ? 0 : fields[0])), signer: lower(await recoverTransactionAddress({ serializedTransaction: raw })) };
}

const seen = Object.fromEntries(Object.keys(IDS).map((k) => [k, 0]));
/** The transactions `key` got since the last look: as many as `kinds`, each signed once on the device, by the
 * Ledger, for that network. */
async function signedOnLedger(key, kinds, reviewsBefore) {
  const fresh = net.evm[key].sent.slice(seen[key]);
  assert.equal(fresh.length, kinds.length, `${key}: ${kinds.join(', ')}`);
  for (const [i, raw] of fresh.entries()) assert.deepEqual(await signers(raw), { count: 1, chainId: IDS[key], signer: lower(ME) }, `${key} ${kinds[i]}`);
  assert.equal(dev.reviews - reviewsBefore, kinds.length, 'each one confirmed on the device');
  seen[key] += fresh.length;
}
const nothingNew = (key) => assert.equal(net.evm[key].sent.length, seen[key], `nothing sent on ${key}`);

test("the Ledger wallet's Ethereum address is the device's, on every network", () => {
  assert.equal(lower(wallet.chains.eth.address), lower(ME));
});

test('a send on each network: signed on the Ledger for that network', async () => {
  for (const key of Object.keys(IDS)) {
    const reviews = dev.reviews;
    const prep = await T.ok('send.prepare', { chain: 'eth', net: key, token: null, to: TO, amount: '1' });
    nothingNew(key);
    await T.ok('send.submit', { id: prep.id });
    await signedOnLedger(key, ['coin'], reviews);
  }
});

test('a token send with blind signing off: the device turns it down, plum says which setting, nothing is sent', async () => {
  dev.lie.ethNeedsBlind = true;
  try {
    const prep = await T.ok('send.prepare', { chain: 'eth', net: 'polygon', token: TOKEN.polygon, to: TO, amount: '5' });
    const e = await T.ui('send.submit', { id: prep.id });
    assert.equal(e.code, 'ledger-blind-sign');
    assert.match(e.error, /blind signing/i);
    nothingNew('polygon');
  } finally { dev.lie.ethNeedsBlind = false; }
  const reviews = dev.reviews;
  const again = await T.ok('send.prepare', { chain: 'eth', net: 'polygon', token: TOKEN.polygon, to: TO, amount: '5' });
  await T.ok('send.submit', { id: again.id });
  await signedOnLedger('polygon', ['token'], reviews);
});

test("a site's transaction on Base: approved in plum's window, then signed on the Ledger for Base", async () => {
  const page = T.fake.page('https://ledger-evm.example/');
  const evm = (method, params) => page.request('evm', { method, params });
  const connect = evm('eth_requestAccounts');
  const c = await T.nextApproval(1000);
  await T.ok('approval.resolve', { id: c.id, approve: true });
  assert.deepEqual((await connect).result.map(lower), [lower(ME)]);
  await evm('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  const answer = evm('eth_sendTransaction', [{ from: ME, to: TO, value: '0x1' }]);
  const v = await T.nextApproval(1000);
  assert.equal(v.evmNet.key, 'base');
  assert.match(v.ledger.note, /blind signing/);
  await T.ok('approval.preview', { id: v.id });
  nothingNew('base');
  const reviews = dev.reviews;
  await T.ok('approval.resolve', { id: v.id, approve: true });
  assert.match((await answer).result, /^0x[0-9a-f]{64}$/);
  await signedOnLedger('base', ['site'], reviews);
});

test('a swap on Arbitrum: the exact approval, then the swap, each confirmed on the Ledger', async () => {
  const q = await T.ok('evm.swap.quote', { net: 'arbitrum', sell: TOKEN.arbitrum, buy: null, amount: '20', slippageBps: 100 });
  const prep = await T.ok('evm.swap.prepare', { quoteId: q.id });
  assert.deepEqual(prep.steps, ['approve', 'swap']);
  nothingNew('arbitrum');
  const reviews = dev.reviews;
  await T.ok('evm.swap.submit', { id: prep.id });
  await signedOnLedger('arbitrum', ['approve', 'swap'], reviews);
});

test("a no on the Ledger in the middle of a swap: the approval went out, the swap didn't", async () => {
  const q = await T.ok('evm.swap.quote', { net: 'base', sell: TOKEN.base, buy: null, amount: '20', slippageBps: 100 });
  const prep = await T.ok('evm.swap.prepare', { quoteId: q.id });
  assert.deepEqual(prep.steps, ['approve', 'swap']);
  dev.decide = 'wait';
  const done = T.ui('evm.swap.submit', { id: prep.id });
  const pressed = async (answer) => {
    for (let i = 0; i < 600 && !dev.waiting; i++) await sleep(5);
    assert.ok(dev.waiting, 'the device is asking');
    dev.press(answer);
  };
  await pressed('approve');
  await pressed('reject');
  const e = await done;
  dev.decide = 'approve';
  assert.equal(e.code, 'ledger-rejected');
  const fresh = net.evm.base.sent.slice(seen.base);
  assert.equal(fresh.length, 1, 'only the approval');
  assert.equal(fromRlp(`0x${fresh[0].slice(4)}`)[7].slice(0, 10), '0x095ea7b3');
  seen.base += 1;
});

test("Lido on Ethereum: the stake, the request's exact approval and the request, the claim, each on the Ledger", async () => {
  for (const [input, kinds] of [[{ action: 'stake', amount: '0.5' }, ['stake']], [{ action: 'request', amount: '1' }, ['approve', 'request']], [{ action: 'claim', request: '77' }, ['claim']]]) {
    const prep = await T.ok('lido.prepare', input);
    assert.deepEqual(prep.steps, kinds);
    nothingNew('ethereum');
    const reviews = dev.reviews;
    await T.ok('lido.submit', { id: prep.id });
    await signedOnLedger('ethereum', kinds, reviews);
  }
});

test('an NFT on Polygon: signed on the Ledger for Polygon', async () => {
  const prep = await T.ok('nfts.prepare', { chain: 'eth', net: 'polygon', contract: NFT, to: TO, standard: 'erc721', id: '3' });
  nothingNew('polygon');
  const reviews = dev.reviews;
  await T.ok('nfts.submit', { id: prep.id });
  await signedOnLedger('polygon', ['erc721'], reviews);
  D._setOpener(null);
});
