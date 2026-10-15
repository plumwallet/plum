// Staking ETH with Lido (stake, request a withdrawal, claim it), and what an RPC that lies about the simulation, or a
// contract that misbehaves, could try: take another token as well, approve someone else, keep the stETH or the ETH from
// arriving, take another request; and claims of requests that aren't yours or aren't finalized. Plum builds every one
// of these itself for Lido's own contracts, so each is refused outright when its simulation isn't what it should be,
// and each transaction it sends has one signer: your wallet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decodeFunctionData, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { fakeNet } from '../fake-net.mjs';
import { boot } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const QUEUE = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const ETH = 10n ** 18n;
const lower = (a) => a.toLowerCase();

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, err } = ctx;
const eth = net.evm.ethereum;

const topic = (s) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex')}`;
const TRANSFER = topic('Transfer(address,address,uint256)');
const APPROVAL = topic('Approval(address,address,uint256)');
const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const log = (address, a, b, v) => ({ address: lower(address), topics: [TRANSFER, pad(a), pad(b)], data: word(v) });
const nft = (a, b, id) => ({ address: lower(QUEUE), topics: [TRANSFER, pad(a), pad(b), word(id)], data: '0x' });
const okCall = (logs, gas = 90_000) => ({ status: '0x1', returnData: '0x', gasUsed: `0x${gas.toString(16)}`, logs });
const abi = parseAbi(['function requestWithdrawals(uint256[] amounts, address owner) returns (uint256[])', 'function approve(address spender, uint256 amount) returns (bool)', 'function claimWithdrawal(uint256 requestId)', 'function submit(address referral) payable returns (uint256)']);

// your requests in the queue: id -> { amount, finalized, claimed }
const requests = new Map([[101n, { amount: 3n * ETH, finalized: true, claimed: false }], [102n, { amount: ETH, finalized: false, claimed: false }], [99n, { amount: ETH, finalized: true, claimed: true }]]);
let nextId = 200n;
eth.ethCall = ({ to, data }) => {
  if (lower(to) !== lower(QUEUE)) return undefined;
  if (data.startsWith('0x7d031b65')) { const ids = [...requests.keys()]; return `0x${[32n, BigInt(ids.length), ...ids].map((n) => word(n).slice(2)).join('')}`; }
  if (data.startsWith('0xb8c4b85a')) {
    const body = data.slice(10);
    const n = Number(BigInt(`0x${body.slice(64, 128)}`));
    const ids = Array.from({ length: n }, (_, i) => BigInt(`0x${body.slice(128 + i * 64, 192 + i * 64)}`));
    const rows = ids.flatMap((id) => { const r = requests.get(id) ?? { amount: 0n }; return [r.amount, r.amount, BigInt(ETH_ME), 1_760_000_000n, r.finalized ? 1n : 0n, r.claimed ? 1n : 0n]; });
    return `0x${[32n, BigInt(n), ...rows].map((x) => word(x).slice(2)).join('')}`;
  }
  return undefined;
};
eth.tokens.set(lower(STETH), { decimals: 18, symbol: 'stETH', name: 'Liquid staked Ether 2.0', price: 2500, balances: new Map([[lower(ETH_ME), 5n * ETH]]), allowances: new Map() });
eth.balances.set(lower(ETH_ME), 10n * ETH);

let extra = () => []; // more logs a lying simulation adds to the main call
let drop = null; // 'steth' | 'eth' | 'nft': what a lying simulation leaves out
function lido(call) {
  const sel = call.data.slice(0, 10);
  if (sel === '0x095ea7b3') {
    const { args: [spender, amount] } = decodeFunctionData({ abi, data: call.data });
    return okCall([{ address: lower(call.to), topics: [APPROVAL, pad(call.from), pad(spender)], data: word(amount) }], 46_000);
  }
  if (sel === '0xa1903eab') {
    const v = BigInt(call.value);
    return okCall([log('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', call.from, STETH, v), ...(drop === 'steth' ? [] : [log(STETH, ZERO, call.from, v - 1n)]), ...extra(call)], 77_000);
  }
  if (sel === '0xd6681042') {
    const { args: [amounts, owner] } = decodeFunctionData({ abi, data: call.data });
    const total = amounts.reduce((n, x) => n + x, 0n);
    return okCall([log(STETH, call.from, QUEUE, total), ...(drop === 'nft' ? [] : amounts.map(() => nft(ZERO, owner, nextId++))), ...extra(call)], 160_000);
  }
  if (sel === '0xf8444436') {
    const { args: [id] } = decodeFunctionData({ abi, data: call.data });
    return okCall([...(drop === 'eth' ? [] : [log('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', QUEUE, call.from, requests.get(id)?.amount ?? 0n)]), nft(call.from, ZERO, id), ...extra(call)], 70_000);
  }
  return { status: '0x0', error: { message: 'execution reverted' }, logs: [], gasUsed: '0x0' };
}
eth.simulate = (call) => lido(call);

const reset = () => { extra = () => []; drop = null; eth.tokens.get(lower(STETH)).allowances.clear(); };
async function oneSigner(raw) {
  const tx = parseTransaction(raw);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, 1);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME, 'signed by your wallet alone');
  return tx;
}

test('baseline: your stETH and your withdrawal requests (claimed ones left out), newest first', async () => {
  await ctx.setup();
  const s = await ok('lido.state');
  assert.equal(s.staked, String(5n * ETH));
  assert.deepEqual(s.requests.map((r) => [r.id, r.amount, r.finalized]), [['101', String(3n * ETH), true], ['102', String(ETH), false]]);
});

test('baseline: staking 1 ETH: exactly 1 ETH leaves, stETH arrives, one transaction to Lido signed by you alone, through MEV Blocker', async () => {
  reset();
  const prep = await ok('lido.prepare', { action: 'stake', amount: '1' });
  assert.deepEqual(prep.steps, ['stake']);
  assert.deepEqual(prep.preview.changes.map((c) => [c.symbol, c.delta]), [['ETH', String(-ETH)], ['stETH', String(ETH - 1n)]]);
  const sent = eth.sent.length;
  await ok('lido.submit', { id: prep.id });
  assert.equal(eth.sent.length, sent + 1);
  const tx = await oneSigner(eth.sent.at(-1));
  assert.deepEqual([lower(tx.to), tx.value], [lower(STETH), ETH]);
  assert.deepEqual(decodeFunctionData({ abi, data: tx.data }).args, [ZERO]);
  assert.equal(eth.calls.filter(([, m]) => m === 'eth_sendRawTransaction').at(-1)[0], 'rpc.mevblocker.io');
});

test('baseline: a withdrawal request: an exact approval of stETH to the queue, then the request for you, each signed by you alone', async () => {
  reset();
  const prep = await ok('lido.prepare', { action: 'request', amount: '2' });
  assert.deepEqual(prep.steps, ['approve', 'request']);
  assert.deepEqual(prep.approval, { token: 'stETH', amount: '2', spender: QUEUE });
  const before = eth.sent.length;
  await ok('lido.submit', { id: prep.id });
  const [approve, request] = await Promise.all(eth.sent.slice(before).map(oneSigner));
  assert.deepEqual(decodeFunctionData({ abi, data: approve.data }).args, [QUEUE, 2n * ETH]);
  assert.equal(lower(request.to), lower(QUEUE));
  assert.deepEqual(decodeFunctionData({ abi, data: request.data }).args, [[2n * ETH], ETH_ME]);
});

test('baseline: more than 1,000 stETH is split into requests the queue takes (1,000 each at most)', async () => {
  reset();
  eth.tokens.get(lower(STETH)).balances.set(lower(ETH_ME), 2500n * ETH);
  try {
    const prep = await ok('lido.prepare', { action: 'request', amount: '2500' });
    assert.equal(prep.get, '3 withdrawal requests');
    const before = eth.sent.length;
    await ok('lido.submit', { id: prep.id });
    const request = parseTransaction(eth.sent.at(-1));
    assert.equal(eth.sent.length, before + 2);
    assert.deepEqual(decodeFunctionData({ abi, data: request.data }).args[0], [1000n * ETH, 1000n * ETH, 500n * ETH]);
  } finally { eth.tokens.get(lower(STETH)).balances.set(lower(ETH_ME), 5n * ETH); }
});

test('baseline: claiming a finalized request: its NFT leaves, the ETH arrives, one transaction signed by you alone', async () => {
  reset();
  const prep = await ok('lido.prepare', { action: 'claim', request: '101' });
  assert.deepEqual(prep.steps, ['claim']);
  assert.deepEqual(prep.preview.changes.map((c) => [c.symbol, c.delta]), [['ETH', String(3n * ETH)]]);
  assert.ok(prep.warnings.some((w) => /a withdrawal request leaves your wallet/.test(w.text)));
  await ok('lido.submit', { id: prep.id });
  const tx = await oneSigner(eth.sent.at(-1));
  assert.deepEqual(decodeFunctionData({ abi, data: tx.data }).args, [101n]);
});

test("withstood: claims of a request that isn't yours, is already claimed, or isn't finalized are refused before anything is built", async () => {
  reset();
  assert.match(await err('lido.prepare', { action: 'claim', request: '555' }), /isn't yours, or it's already claimed/);
  assert.match(await err('lido.prepare', { action: 'claim', request: '99' }), /isn't yours, or it's already claimed/);
  assert.match(await err('lido.prepare', { action: 'claim', request: '102' }), /hasn't finalized/);
  assert.match(await err('lido.prepare', { action: 'claim', request: '1 OR 1=1' }), /pick a withdrawal request/);
  assert.match(await err('lido.prepare', { action: 'request', amount: '6' }), /you have 5 stETH/);
  assert.match(await err('lido.prepare', { action: 'stake', amount: '10' }), /network fee is paid in ETH too/);
  assert.match(await err('lido.prepare', { action: 'unstake-all' }), /unknown staking step/);
});

test('withstood: a simulation in which anything else moves, anyone else is approved, or what should arrive does not, is refused outright', async () => {
  for (const [action, input, setup, re] of [
    ['stake', { amount: '1' }, () => { extra = (c) => [log(USDC, c.from, ATTACKER, 5n)]; }, /also take 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 from you/],
    ['stake', { amount: '1' }, () => { extra = (c) => [{ address: lower(USDC), topics: [APPROVAL, pad(c.from), pad(ATTACKER)], data: word((1n << 256n) - 1n) }]; }, /let 0x000000000000000000000000000000000000dEaD spend/],
    ['stake', { amount: '1' }, () => { drop = 'steth'; }, /doesn't show the stETH arriving/],
    ['request', { amount: '2' }, () => { extra = (c) => [{ address: lower(STETH), topics: [APPROVAL, pad(c.from), pad(ATTACKER)], data: word(1n) }]; }, /let 0x000000000000000000000000000000000000dEaD spend/],
    ['request', { amount: '2' }, () => { drop = 'nft'; }, /doesn't show the withdrawal request arriving/],
    ['request', { amount: '2' }, () => { extra = (c) => [log(STETH, c.from, ATTACKER, ETH)]; }, /would take 3000000000000000000 of your stETH/],
    ['request', { amount: '2' }, () => { extra = (c) => [nft(c.from, ATTACKER, 101n)]; }, /also take a withdrawal request of yours/],
    ['claim', { request: '101' }, () => { drop = 'eth'; }, /shows no ETH moving|doesn't show ETH arriving/],
    ['claim', { request: '101' }, () => { extra = (c) => [nft(c.from, ATTACKER, 102n)]; }, /another withdrawal request of yours/],
    ['claim', { request: '101' }, () => { extra = (c) => [log(STETH, c.from, ATTACKER, 1n)]; }, /take stETH from you/],
  ]) {
    reset();
    setup();
    const sent = eth.sent.length;
    assert.match(await err('lido.prepare', { action, ...input }), re, `${action} ${JSON.stringify(input)}`);
    assert.equal(eth.sent.length, sent);
  }
});

test('withstood: checked again right before the request is sent: an approval landed, then a request that would no longer bring its NFT is not sent', async () => {
  reset();
  const prep = await ok('lido.prepare', { action: 'request', amount: '1' });
  drop = 'nft';
  const before = eth.sent.length;
  assert.match(await err('lido.submit', { id: prep.id }), /the approval landed, but the simulation doesn't show the withdrawal request arriving/);
  assert.equal(eth.sent.length, before + 1, 'only the exact approval went out');
  reset();
});
