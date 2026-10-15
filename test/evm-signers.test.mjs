// Every transaction plum builds on Ethereum, Base, Arbitrum and Polygon has exactly one signer, your wallet: sends of
// each network's coin and of a token, a site's transaction on each network, and a swap's approvals and the swap. Each
// raw transaction that reaches a network is taken apart here: one EIP-1559 transaction, for that network, with one
// signature in it (the RLP list's last three fields: no second set, no EIP-7702 authorizations), recovering to the
// wallet. And nothing reaches a network before you said yes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, fromRlp, parseAbi, recoverTransactionAddress, zeroAddress } from 'viem';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { fakeNet } from './fake-net.mjs';
import { boot, sleep } from './redteam/helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TO = '0x4444444444444444444444444444444444444444';
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const EXECUTOR = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TOKEN = { ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' };
const IDS = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137 };
const lower = (a) => a.toLowerCase();

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, fake, _test } = ctx;

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
]);

// every network: a coin balance, a token, a simulation that moves what it's told, KyberSwap answering honestly
for (const [key, c] of Object.entries(net.evm)) {
  c.balances.set(lower(ETH_ME), 10n ** 20n);
  c.tokens.set(lower(TOKEN[key]), { decimals: 6, symbol: 'USDC', name: 'USD Coin', price: 1, balances: new Map([[lower(ETH_ME), 10n ** 9n]]), allowances: new Map([[`${lower(ETH_ME)}:${lower(ROUTER)}`, 7n]]) });
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
    return { status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: call.value && BigInt(call.value) ? [log(NATIVE, TRANSFER, call.from, call.to, BigInt(call.value))] : [] };
  };
}
// a fair price at the market's (the coin at $2,500, POL at $0.25, the token at $1)
const coinUsd = (key) => (key === 'polygon' ? 0.25 : 2500);
net.kyber.routes = (q, slug) => {
  const key = slug;
  const out = q.tokenIn === NATIVE ? BigInt(Math.round((Number(q.amountIn) / 1e18) * coinUsd(key) * 1e6)) : BigInt(Math.round((Number(q.amountIn) / 1e6 / coinUsd(key)) * 1e18));
  return { routeSummary: { tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, amountOut: String(out), route: [] }, routerAddress: ROUTER };
};
net.kyber.build = (b) => {
  const s = b.routeSummary;
  const min = (BigInt(s.amountOut) * BigInt(10_000 - b.slippageTolerance)) / 10_000n;
  const execution = { callTarget: EXECUTOR, approveTarget: zeroAddress, targetData: '0x01', desc: { srcToken: s.tokenIn, dstToken: s.tokenOut, srcReceivers: s.tokenIn === NATIVE ? [] : [EXECUTOR], srcAmounts: s.tokenIn === NATIVE ? [] : [BigInt(s.amountIn)], feeReceivers: [], feeAmounts: [], dstReceiver: b.recipient, amount: BigInt(s.amountIn), minReturnAmount: min, flags: 0x200n, permit: '0x' }, clientData: '0x' };
  return { amountIn: s.amountIn, amountOut: s.amountOut, data: encodeFunctionData({ abi, functionName: 'swap', args: [execution] }), routerAddress: ROUTER, transactionValue: s.tokenIn === NATIVE ? s.amountIn : '0' };
};

/** A raw transaction taken apart: its type, chain, and how many signatures it carries. */
async function signers(raw) {
  assert.equal(raw.slice(0, 4), '0x02', 'an EIP-1559 transaction (no other type, so no EIP-7702 authorization list)');
  const fields = fromRlp(`0x${raw.slice(4)}`);
  // [chainId, nonce, tip, maxFee, gas, to, value, data, accessList] then one signature: yParity, r, s
  assert.equal((fields.length - 9) % 3, 0);
  assert.deepEqual(fields[8], [], 'no access list');
  return { count: (fields.length - 9) / 3, chainId: Number(BigInt(fields[0] === '0x' ? 0 : fields[0])), signer: await recoverTransactionAddress({ serializedTransaction: raw }) };
}

const seen = [];
async function everyNewTransaction(key, kinds) {
  const c = net.evm[key];
  const fresh = c.sent.slice(seen.filter((s) => s.key === key).length);
  assert.equal(fresh.length, kinds.length, `${key}: ${kinds.join(', ')}`);
  for (const [i, raw] of fresh.entries()) {
    const s = await signers(raw);
    assert.deepEqual(s, { count: 1, chainId: IDS[key], signer: ETH_ME }, `${key} ${kinds[i]}`);
    seen.push({ key, kind: kinds[i] });
  }
}

test('sends: each network\'s coin and a token, one signer each', async () => {
  await ctx.setup();
  for (const key of Object.keys(IDS)) {
    for (const token of [null, TOKEN[key]]) {
      const before = net.evm[key].sent.length;
      const prep = await ok('send.prepare', { chain: 'eth', net: key, token, to: TO, amount: '1' });
      assert.equal(net.evm[key].sent.length, before, 'nothing sent before you said yes');
      await ok('send.submit', { id: prep.id });
      await everyNewTransaction(key, [token ? 'token' : 'coin']);
    }
  }
});

test("a site's transaction on each network, one signer each, sent only after you approve", async () => {
  const page = fake.page('https://signers.example/');
  const evm = (method, params) => page.request('evm', { method, params });
  const connect = evm('eth_requestAccounts');
  for (let i = 0; i < 200 && !_test.pending.size; i++) await sleep(5);
  await ok('approval.resolve', { id: (await ok('approval.get')).id, approve: true });
  await connect;
  for (const [key, id] of Object.entries(IDS)) {
    await evm('wallet_switchEthereumChain', [{ chainId: `0x${id.toString(16)}` }]);
    const answer = evm('eth_sendTransaction', [{ from: ETH_ME, to: TO, value: '0x1' }]);
    const v = await ctx.nextApproval(1000);
    await ok('approval.preview', { id: v.id });
    assert.equal(net.evm[key].sent.length, seen.filter((s) => s.key === key).length, 'nothing sent before you approve');
    await ok('approval.resolve', { id: v.id, approve: true });
    await answer;
    await everyNewTransaction(key, ['site']);
  }
});

test("swaps on each network: the approval's reset, the exact approval and the swap, one signer each", async () => {
  for (const key of Object.keys(IDS)) {
    // selling the token (an allowance of 7 is left over: reset, approve, swap), then buying it with the coin (swap)
    for (const [sell, buy, amount, kinds] of [[TOKEN[key], null, '20', ['reset', 'approve', 'swap']], [null, TOKEN[key], '0.01', ['swap']]]) {
      const q = await ok('evm.swap.quote', { net: key, sell, buy, amount, slippageBps: 100 });
      const prep = await ok('evm.swap.prepare', { quoteId: q.id });
      assert.deepEqual(prep.steps, kinds);
      assert.equal(net.evm[key].sent.length, seen.filter((x) => x.key === key).length, 'nothing sent before you said yes');
      await ok('evm.swap.submit', { id: prep.id });
      await everyNewTransaction(key, kinds);
    }
    net.evm[key].tokens.get(lower(TOKEN[key])).allowances.set(`${lower(ETH_ME)}:${lower(ROUTER)}`, 7n);
  }
  assert.ok(seen.length >= 4 * 2 + 4 + 4 * 4, `${seen.length} transactions checked`);
});
