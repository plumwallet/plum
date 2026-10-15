// Attack: KyberSwap's API is compromised (or someone sits between plum and it) and answers with a "swap" that does
// something else: a router that isn't KyberSwap's, a call that isn't its swap, what you buy paid to someone else, a
// minimum far under the quote, a fee or a permit tucked in, an executor of its own, a quote that lies about what
// arrives, or a simulation in which more leaves than you sell. Plum must refuse each outright (a swap is plum's own
// request: there is no "sign anyway" for these), give approvals only for the exact amount and only to KyberSwap's
// router, and every transaction it sends must have one signer: your wallet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseTransaction, recoverTransactionAddress, zeroAddress } from 'viem';
import { fakeNet } from '../fake-net.mjs';
import { boot } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const EXECUTOR = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // on Base
const WETH = '0x4200000000000000000000000000000000000006'; // on Base
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // on Ethereum
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const lower = (a) => a.toLowerCase();

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, err } = ctx;

const topic = (sig) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex')}`;
const TRANSFER = topic('Transfer(address,address,uint256)');
const APPROVAL = topic('Approval(address,address,uint256)');
const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const log = (address, t, a, b, v) => ({ address: lower(address), topics: [t, pad(a), pad(b)], data: word(v) });
const okCall = (logs, gas = 120_000) => ({ status: '0x1', returnData: '0x', gasUsed: `0x${gas.toString(16)}`, logs });

const abi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
  'function swapGeneric(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** KyberSwap's swap() as its API builds it, with any field changed. */
function swapData(o) {
  const amount = o.amount;
  const execution = {
    callTarget: o.callTarget ?? EXECUTOR, approveTarget: zeroAddress, targetData: '0x1234',
    desc: {
      srcToken: o.srcToken, dstToken: o.dstToken, srcReceivers: o.srcReceivers ?? (o.srcToken === NATIVE ? [] : [EXECUTOR]), srcAmounts: o.srcAmounts ?? (o.srcToken === NATIVE ? [] : [amount]),
      feeReceivers: o.feeReceivers ?? [], feeAmounts: o.feeAmounts ?? [], dstReceiver: o.dstReceiver ?? ETH_ME, amount, minReturnAmount: o.min,
      flags: o.flags ?? 0x200n, permit: o.permit ?? '0x',
    },
    clientData: '0x',
  };
  return encodeFunctionData({ abi, functionName: o.fn ?? 'swap', args: [execution] });
}

/* ------------------------------------------------------------ KyberSwap and the chain, stood in for */

// 25 USDC is worth 0.01 ETH (USDC at $1, ETH at $2,500): an honest quote gives exactly that
const FAIR_OUT = 10n ** 16n;
const IN = 25_000_000n;
let quoted = FAIR_OUT; // what /routes says you get
let built = {}; // overrides for /route/build's answer and its swap()
let swapSim = null; // (call) => the swap's simulated result; null for the honest one
let routeOverride = null;

net.kyber.routes = (q) => routeOverride?.(q) ?? {
  routeSummary: { tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, amountOut: String(quoted), amountInUsd: '25', amountOutUsd: String((Number(quoted) / 1e18) * 2500), route: [[{ exchange: 'uniswap-v3' }]], extraFee: { feeAmount: '', feeReceiver: '' } },
  routerAddress: ROUTER,
};
net.kyber.build = (body) => {
  const s = body.routeSummary;
  const out = BigInt(built.amountOut ?? s.amountOut) - 1n;
  const min = built.min ?? (out * BigInt(10_000 - body.slippageTolerance)) / 10_000n;
  const srcToken = s.tokenIn, dstToken = s.tokenOut;
  return {
    amountIn: s.amountIn, amountOut: String(out), gas: '300000',
    data: built.data ?? swapData({ srcToken, dstToken, amount: BigInt(s.amountIn), min, ...built.swap }),
    routerAddress: built.routerAddress ?? ROUTER,
    transactionValue: built.value ?? (srcToken === NATIVE ? s.amountIn : '0'),
  };
};

/** What KyberSwap's swap does when simulated: what you sell goes to the executor, what you buy comes to you. */
function honestSwap(call) {
  const d = decodeFunctionData({ abi, data: call.data }).args[0].desc;
  const sell = d.srcToken === NATIVE ? log(NATIVE, TRANSFER, call.from, ROUTER, d.amount) : log(d.srcToken, TRANSFER, call.from, EXECUTOR, d.amount);
  const got = BigInt(built.delivered ?? FAIR_OUT);
  const buy = d.dstToken === NATIVE ? log(NATIVE, TRANSFER, ROUTER, d.dstReceiver, got) : log(d.dstToken, TRANSFER, EXECUTOR, d.dstReceiver, got);
  return okCall([sell, buy], 180_000);
}
function chainSim(call) {
  if (call.data.startsWith('0x095ea7b3')) {
    const { args: [spender, amount] } = decodeFunctionData({ abi, data: call.data });
    return okCall(amount > 0n ? [log(call.to, APPROVAL, call.from, spender, amount)] : [], 46_000);
  }
  if (call.data.startsWith('0xe21fd0e9')) return (swapSim ?? honestSwap)(call);
  return { status: '0x0', error: { message: 'execution reverted' }, logs: [], gasUsed: '0x0' };
}
for (const c of Object.values(net.evm)) {
  c.simulate = chainSim;
  c.balances.set(lower(ETH_ME), 10n ** 18n);
}
const base = net.evm.base;
base.tokens.set(lower(USDC), { decimals: 6, symbol: 'USDC', name: 'USD Coin', price: 1, balances: new Map([[lower(ETH_ME), 100_000_000n]]), allowances: new Map() });
net.evm.ethereum.tokens.set(lower(ETH_USDC), { decimals: 6, symbol: 'USDC', name: 'USD Coin', price: 1, balances: new Map(), allowances: new Map() });

const reset = () => { quoted = FAIR_OUT; built = {}; swapSim = null; routeOverride = null; };
const quote = (o = {}) => ok('evm.swap.quote', { net: 'base', sell: USDC, buy: null, amount: '25', slippageBps: 50, ...o });
const refused = async (re, o) => {
  const q = await quote(o);
  const sent = base.sent.length;
  assert.match(await err('evm.swap.prepare', { quoteId: q.id }), re);
  assert.equal(base.sent.length, sent, 'nothing was sent');
};

/** Every transaction sent: one signature (your wallet's), an EIP-1559 transaction for that network, nothing else. */
async function oneSigner(raw, chainId) {
  const tx = parseTransaction(raw);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, chainId);
  assert.ok(tx.r && tx.s && (tx.yParity === 0 || tx.yParity === 1), 'one signature');
  assert.equal(tx.authorizationList, undefined);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME, 'signed by your wallet alone');
  return tx;
}

/* ------------------------------------------------------------ the honest swap */

test('baseline: an honest swap of 25 USDC for ETH on Base: an exact approval to the router, then the swap, each signed by you alone', async () => {
  await ctx.setup();
  reset();
  const q = await quote();
  assert.deepEqual([q.inAmount, q.outAmount, q.inSymbol, q.outSymbol, q.netTitle], ['25', '0.01', 'USDC', 'ETH', 'Base']);
  const prep = await ok('evm.swap.prepare', { quoteId: q.id });
  assert.deepEqual(prep.steps, ['approve', 'swap']);
  assert.deepEqual(prep.approval, { token: 'USDC', amount: '25', spender: ROUTER });
  assert.deepEqual(prep.preview.changes.map((c) => [c.symbol, c.delta]), [['USDC', String(-IN)], ['ETH', String(FAIR_OUT)]]);
  assert.deepEqual(prep.warnings.filter((w) => w.level !== 'info'), []);
  const sent = base.sent.length;
  const done = await ok('evm.swap.submit', { id: prep.id });
  assert.equal(base.sent.length, sent + 2);
  const [approval, swap] = await Promise.all(base.sent.slice(-2).map((raw) => oneSigner(raw, 8453)));
  // the approval: exactly 25 USDC, to KyberSwap's router, and nothing more
  assert.equal(lower(approval.to), lower(USDC));
  assert.deepEqual(decodeFunctionData({ abi, data: approval.data }).args, [ROUTER, IN]);
  assert.equal(swap.nonce, approval.nonce + 1);
  assert.equal(lower(swap.to), lower(ROUTER));
  assert.equal(done.approvals.length, 1);
  assert.match(done.explorer, /^https:\/\/basescan\.org\/tx\//);
});

test('baseline: buying with ETH on Ethereum needs no approval and goes out through MEV Blocker', async () => {
  reset();
  quoted = 25_000_000n;
  built = { delivered: 25_000_000n };
  const q = await quote({ net: 'ethereum', sell: null, buy: ETH_USDC, amount: '0.01' });
  const prep = await ok('evm.swap.prepare', { quoteId: q.id });
  assert.deepEqual(prep.steps, ['swap']);
  assert.equal(prep.approval, null);
  const eth = net.evm.ethereum;
  await ok('evm.swap.submit', { id: prep.id });
  const tx = await oneSigner(eth.sent.at(-1), 1);
  assert.equal(tx.value, 10n ** 16n);
  assert.equal(eth.calls.filter(([, m]) => m === 'eth_sendRawTransaction').at(-1)[0], 'rpc.mevblocker.io', 'MEV Blocker first');
});

/* ------------------------------------------------------------ a compromised KyberSwap */

test('withstood: a swap sent to a router that is not KyberSwap\'s is refused, whichever field names it', async () => {
  reset();
  built = { routerAddress: ATTACKER };
  await refused(/not KyberSwap's router/);
  reset();
  routeOverride = (q) => ({ routeSummary: { tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, amountOut: String(FAIR_OUT) }, routerAddress: ATTACKER });
  assert.match(await err('evm.swap.quote', { net: 'base', sell: USDC, buy: null, amount: '25', slippageBps: 50 }), /router plum doesn't know/);
});

test('withstood: a call to the router that is not its swap() (swapGeneric, or an approve) is refused', async () => {
  reset();
  built = { swap: { fn: 'swapGeneric' } };
  await refused(/not its swap/);
  built = { data: encodeFunctionData({ abi, functionName: 'approve', args: [ATTACKER, (1n << 256n) - 1n] }) };
  await refused(/not its swap/);
  built = { data: '0xe21fd0e9' };
  await refused(/malformed/);
  built = { data: `${swapData({ srcToken: USDC, dstToken: NATIVE, amount: IN, min: 1n })}`.slice(0, 400) };
  await refused(/malformed/);
});

test('withstood: calldata that pays what you buy to someone else is refused, before and after it is simulated', async () => {
  reset();
  built = { swap: { dstReceiver: ATTACKER } };
  await refused(/pays what you buy to 0x000000000000000000000000000000000000dEaD, not to you/);
  // the calldata says you, but the swap (an executor of its own choosing, say) pays someone else: nothing arrives
  reset();
  swapSim = (call) => okCall([log(USDC, TRANSFER, call.from, EXECUTOR, IN), log(NATIVE, TRANSFER, ROUTER, ATTACKER, FAIR_OUT)]);
  await refused(/doesn't show you receiving/);
});

test('withstood: KyberSwap\'s own fields that could skim or reach further are refused: fees, permits, flags, its executor', async () => {
  for (const [swap, re] of [
    [{ feeReceivers: [ATTACKER], feeAmounts: [1_000_000n] }, /takes a fee for 0x000000000000000000000000000000000000dEaD/],
    [{ permit: `0x${'ab'.repeat(224)}` }, /carries a permit/],
    [{ flags: 0x200n | 0x40n }, /flags 0x240/],
    [{ flags: 0x01n }, /flags 0x1/],
    [{ flags: 0x02n }, /flags 0x2/],
    [{ callTarget: ATTACKER }, /isn't KyberSwap's executor/],
    [{ srcAmounts: [IN + 1n] }, /hands out more than you sell/],
  ]) {
    reset();
    built = { swap };
    await refused(re, {});
  }
});

test('withstood: a swap that sells another token, another amount, buys another token, or carries the wrong value is refused', async () => {
  for (const [b, re] of [
    [{ swap: { srcToken: WETH } }, /sells another token/],
    [{ swap: { dstToken: WETH } }, /buys another token/],
    [{ swap: { amount: IN * 2n } }, /sells another amount/],
    [{ value: '1' }, /sends 1 wei with it, not 0/],
  ]) {
    reset();
    built = b;
    await refused(re);
  }
});

test('withstood: a quote that lies about what arrives: a built swap worth less than the quote, a minimum under it, or less arriving', async () => {
  reset();
  built = { amountOut: String(FAIR_OUT / 2n) };
  await refused(/gives less than its quote/);
  reset();
  built = { min: 1n };
  await refused(/would accept less than the quote you saw allows/);
  reset();
  built = { delivered: String(FAIR_OUT / 2n) };
  await refused(/less than its minimum/);
  // and a quote that lies the other way round shows nothing worse arriving: the simulation is what's shown
  reset();
  const q = await quote();
  const prep = await ok('evm.swap.prepare', { quoteId: q.id });
  assert.equal(prep.preview.changes.find((c) => c.symbol === 'ETH').delta, String(FAIR_OUT));
});

test('withstood: a quote that lies consistently (route, swap and simulation all at half the market price) is a named danger that needs "i understand"', async () => {
  reset();
  quoted = FAIR_OUT / 2n;
  built = { delivered: String(FAIR_OUT / 2n) };
  const q = await quote();
  const prep = await ok('evm.swap.prepare', { quoteId: q.id });
  const danger = prep.warnings.find((w) => w.level === 'danger');
  assert.match(danger?.text ?? '', /about 50\.0% less than market prices/);
  const sent = base.sent.length;
  assert.match(await err('evm.swap.submit', { id: prep.id }), /i understand/);
  assert.equal(base.sent.length, sent, 'nothing sent without it');
  await ok('evm.swap.submit', { id: prep.id, ignoreRisk: true });
  assert.equal(base.sent.length, sent + 2);
});

test('withstood: a swap whose simulation also approves someone else, takes another token, or takes more than you sell is refused', async () => {
  const OTHER = '0x3333333333333333333333333333333333333333';
  for (const [sim, re] of [
    [(call) => okCall([...honestSwap(call).logs, log(USDC, APPROVAL, call.from, ATTACKER, (1n << 256n) - 1n)]), /let 0x000000000000000000000000000000000000dEaD spend/],
    [(call) => okCall([...honestSwap(call).logs, log(OTHER, TRANSFER, call.from, ATTACKER, 5n)]), /also take 0x3333333333333333333333333333333333333333 from you/],
    [(call) => okCall([...honestSwap(call).logs, log(USDC, TRANSFER, call.from, ATTACKER, 1n)]), /take more than you sell/],
    [() => ({ status: '0x0', error: { message: 'Return amount is not enough' }, logs: [], gasUsed: '0x0' }), /would fail \(Return amount is not enough\)/],
  ]) {
    reset();
    swapSim = sim;
    await refused(re);
  }
  // only a transaction's own value can take a network's coin from you: selling one token for another, any coin
  // leaving is refused
  reset();
  swapSim = (call) => okCall([...honestSwap(call).logs, log(NATIVE, TRANSFER, call.from, ATTACKER, 1n)]);
  base.tokens.set(lower(WETH), { decimals: 18, symbol: 'WETH', name: 'Wrapped Ether', price: 2500, balances: new Map(), allowances: new Map() });
  await refused(/also take the coin from you/, { buy: WETH });
});

test('withstood: plum never gives an unlimited approval, and asks for none when the router can already spend the amount', async () => {
  reset();
  const usdc = base.tokens.get(lower(USDC));
  // an allowance left from before, smaller than this swap: back to zero first (USDT won't change one to another), then exact
  usdc.allowances.set(`${lower(ETH_ME)}:${lower(ROUTER)}`, 5n);
  let q = await quote();
  let prep = await ok('evm.swap.prepare', { quoteId: q.id });
  assert.deepEqual(prep.steps, ['reset', 'approve', 'swap']);
  const before = base.sent.length;
  await ok('evm.swap.submit', { id: prep.id });
  const [zero, exact] = base.sent.slice(before, before + 2).map((raw) => parseTransaction(raw));
  assert.deepEqual(decodeFunctionData({ abi, data: zero.data }).args, [ROUTER, 0n]);
  assert.deepEqual(decodeFunctionData({ abi, data: exact.data }).args, [ROUTER, IN]);
  for (const raw of base.sent.slice(before)) {
    const tx = parseTransaction(raw);
    if (tx.data.startsWith('0x095ea7b3')) assert.ok(decodeFunctionData({ abi, data: tx.data }).args[1] <= IN, 'never more than the amount');
  }
  // enough already: no approval at all
  usdc.allowances.set(`${lower(ETH_ME)}:${lower(ROUTER)}`, IN);
  q = await quote();
  prep = await ok('evm.swap.prepare', { quoteId: q.id });
  assert.deepEqual(prep.steps, ['swap']);
  usdc.allowances.clear();
});

test('an allowance you gave the router before: what is left of it, shown going down inside the swap, is fine; the same for anyone else is refused', async () => {
  reset();
  const usdc = base.tokens.get(lower(USDC));
  usdc.allowances.set(`${lower(ETH_ME)}:${lower(ROUTER)}`, (1n << 256n) - 1n);
  try {
    // a token that logs Approval(you, spender, what's left) when it's spent (OpenZeppelin 4 does)
    swapSim = (call) => okCall([...honestSwap(call).logs, log(USDC, APPROVAL, call.from, ROUTER, (1n << 256n) - 1n - IN)]);
    let q = await quote();
    const prep = await ok('evm.swap.prepare', { quoteId: q.id });
    assert.deepEqual(prep.steps, ['swap']);
    assert.ok(prep.warnings.some((w) => /can already spend all of your USDC/.test(w.text)), 'the old allowance is named');
    swapSim = (call) => okCall([...honestSwap(call).logs, log(USDC, APPROVAL, call.from, ATTACKER, 5n)]);
    q = await quote();
    assert.match(await err('evm.swap.prepare', { quoteId: q.id }), /let 0x000000000000000000000000000000000000dEaD spend/);
  } finally { usdc.allowances.clear(); }
});

test('withstood: checked again right before the swap is sent: a swap that would now fail is not sent (the approval stays exact)', async () => {
  reset();
  const q = await quote();
  const prep = await ok('evm.swap.prepare', { quoteId: q.id });
  // between the review and the send, the swap stops delivering (the price moved, or the route was a trap)
  swapSim = (call) => okCall([log(USDC, TRANSFER, call.from, EXECUTOR, IN), log(NATIVE, TRANSFER, ROUTER, ATTACKER, FAIR_OUT)]);
  const before = base.sent.length;
  assert.match(await err('evm.swap.submit', { id: prep.id }), /the approval landed, but the simulation doesn't show you receiving/);
  assert.equal(base.sent.length, before + 1, 'only the (exact) approval went out');
  assert.ok(parseTransaction(base.sent.at(-1)).data.startsWith('0x095ea7b3'));
});

test('withstood: an approval that fails on chain stops the swap; so does a fee risen past what you reviewed', async () => {
  reset();
  base.receipts.clear();
  let q = await quote();
  let prep = await ok('evm.swap.prepare', { quoteId: q.id });
  const real = base.receipts;
  base.receipts = new Map();
  const before = base.sent.length;
  const orig = base.receipts.get.bind(base.receipts);
  base.receipts.has = () => true;
  base.receipts.get = () => '0x0';
  try {
    assert.match(await err('evm.swap.submit', { id: prep.id }), /the approval failed on Base, so nothing else was sent/);
    assert.equal(base.sent.length, before + 1);
  } finally { base.receipts = real; void orig; }
  q = await quote();
  prep = await ok('evm.swap.prepare', { quoteId: q.id });
  base.baseFee *= 10n;
  try { assert.match(await err('evm.swap.submit', { id: prep.id }), /fee has risen past what you reviewed/); } finally { base.baseFee /= 10n; }
});

test('withstood: stale quotes, another wallet, and amounts you do not have are refused', async () => {
  reset();
  assert.match(await err('evm.swap.quote', { net: 'base', sell: USDC, buy: null, amount: '1000', slippageBps: 50 }), /you have 100 USDC on Base/);
  assert.match(await err('evm.swap.quote', { net: 'base', sell: USDC, buy: USDC, amount: '1', slippageBps: 50 }), /two different tokens/);
  assert.match(await err('evm.swap.quote', { net: 'optimism', sell: null, buy: USDC, amount: '1', slippageBps: 50 }), /pick a network/);
  assert.match(await err('evm.swap.quote', { net: 'base', sell: USDC, buy: null, amount: '1', slippageBps: 0 }), /slippage/);
  assert.match(await err('evm.swap.prepare', { quoteId: 'nope' }), /quote is old/);
  assert.match(await err('evm.swap.submit', { id: 'nope' }), /expired/);
  // KyberSwap answering a different pair than asked
  routeOverride = (q) => ({ routeSummary: { tokenIn: q.tokenOut, tokenOut: q.tokenIn, amountIn: q.amountIn, amountOut: '5' }, routerAddress: ROUTER });
  assert.match(await err('evm.swap.quote', { net: 'base', sell: USDC, buy: null, amount: '1', slippageBps: 50 }), /doesn't match what you asked for/);
});
