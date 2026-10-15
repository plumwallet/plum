// Staking ETH with Lido, on Ethereum: stake ETH for stETH (which grows as the stake earns), ask for ETH back (a
// withdrawal request: an NFT in Lido's queue, finalized in a few days), and claim it once it's finalized. Every step is
// a transaction plum builds for Lido's own contracts (stETH and its withdrawal queue), simulated before you see it, and
// refused outright if anything else would move:
//   stake    exactly the ETH you typed leaves; stETH arrives (the same, to a wei or two: stETH counts in shares);
//   request  stETH leaves (after plum's exact approval of it to the queue); the request's NFT arrives;
//   claim    the request's NFT leaves (it's burned); ETH arrives.
// Requests go out like swaps (evm-steps.js): the approval first, then the request once it has landed and been checked
// again. Every transaction has one signer: your wallet.
import { formatUnits, parseUnits } from '../shared/format.js';
import * as E from './eth.js';
import { MAINNET } from './evm-chains.js';
import { allowance, approveData, sendSteps, tokenBalance } from './evm-steps.js';
import { priceOf } from './prices.js';

export const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
export const QUEUE = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';
/** The queue takes requests of 100 wei to 1,000 stETH each: more is split. */
const MIN_REQUEST = 100n;
const MAX_REQUEST = 1000n * 10n ** 18n;
/** stETH moves in shares, so an amount can arrive or leave a wei or two short. */
const SHARE_ROUNDING = 2n;
const PREPARED_TTL = 90_000;

const fail = (message) => new Error(message);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const stakeData = () => `0xa1903eab${word(0)}`; // submit(address referral): no referral
/** requestWithdrawals(uint256[] amounts, address owner) */
const requestData = (amounts, owner) => `0xd6681042${word(64)}${pad(owner)}${word(amounts.length)}${amounts.map(word).join('')}`;
/** claimWithdrawal(uint256 requestId): to the request's owner, its hint found by the queue itself */
const claimData = (id) => `0xf8444436${word(id)}`;

const words = (hexText) => {
  const h = String(hexText ?? '0x').slice(2);
  return Array.from({ length: Math.floor(h.length / 64) }, (_, i) => BigInt(`0x${h.slice(i * 64, i * 64 + 64)}`));
};

/** Your stETH and your withdrawal requests: { staked, requests: [{ id, amount, at, finalized, claimed }] }. */
export async function state({ me, urls }) {
  const u = await urls(MAINNET);
  const [staked, ids] = await Promise.all([
    tokenBalance(u, STETH, me),
    E.ethRpc(u, 'eth_call', [{ to: QUEUE, data: `0x7d031b65${pad(me)}` }, 'latest']).then((r) => { const w = words(r); return w.slice(2, 2 + Number(w[1] ?? 0n)); }),
  ]);
  let requests = [];
  if (ids.length) {
    // getWithdrawalStatus(ids): per request (amountOfStETH, amountOfShares, owner, timestamp, isFinalized, isClaimed)
    const r = await E.ethRpc(u, 'eth_call', [{ to: QUEUE, data: `0xb8c4b85a${word(32)}${word(ids.length)}${ids.map(word).join('')}` }, 'latest']);
    const w = words(r).slice(2);
    requests = ids.map((id, i) => {
      const [amount, , , at, finalized, claimed] = w.slice(i * 6, i * 6 + 6);
      return { id: id.toString(), amount: (amount ?? 0n).toString(), at: Number(at ?? 0n), finalized: finalized === 1n, claimed: claimed === 1n };
    }).filter((x) => !x.claimed).sort((a, b) => b.at - a.at);
  }
  const price = await priceOf('eth');
  return { staked: staked.toString(), usd: price.price == null ? null : (Number(staked) / 1e18) * price.price, requests };
}

/** What a simulated stake, request or claim must show, in words (null when it passes). */
export function simProblem(sim, { action, me, amount = 0n, requests = 1, id = null }) {
  if (!sim) return "plum couldn't simulate this on Ethereum, so it won't send it";
  if (!sim.ok) return `this would fail (${sim.error})`;
  for (const [i, c] of sim.calls.entries()) {
    const inCall = i === sim.calls.length - 1;
    for (const a of c.approvals) {
      if (a.nft != null) {
        if (!E.sameAddress(a.token, QUEUE)) return 'it would also move an NFT of yours';
        if (action === 'request' && a.out) return 'it would also take a withdrawal request of yours';
        if (action === 'claim' && !a.out) return 'it would hand you another withdrawal request';
        if (action === 'claim' && a.nft !== String(id)) return 'it would take another withdrawal request of yours';
        if (action === 'stake') return 'it would move a withdrawal request';
        continue;
      }
      // plum's approval of stETH to the queue is for the amount at most; inside the request, the queue's allowance can
      // only go down (only you can raise it), so what's left of one you gave before is fine
      const toQueue = !a.all && !a.permit2 && a.item == null && E.sameAddress(a.token, STETH) && E.sameAddress(a.spender, QUEUE);
      if (action === 'request' && toQueue && (inCall || a.amount <= amount)) continue;
      return `it would also let ${a.spender} spend tokens of yours`;
    }
  }
  if (!sim.calls.some((c) => c.native) && action !== 'request') return "the simulation shows no ETH moving, so plum can't see what this does: it won't send it";
  let eth = 0n, steth = 0n;
  for (const ch of sim.changes) {
    if (ch.token == null) eth = ch.delta;
    else if (E.sameAddress(ch.token, STETH)) steth = ch.delta;
    else if (ch.delta < 0n) return `it would also take ${ch.token} from you`;
  }
  const nfts = sim.calls.flatMap((c) => c.approvals).filter((a) => a.nft != null && !a.out).length;
  if (action === 'stake') {
    if (eth !== -amount) return `it would take ${-eth} wei of ETH, not ${amount}`;
    if (steth < amount - SHARE_ROUNDING) return "the simulation doesn't show the stETH arriving";
  } else if (action === 'request') {
    if (eth !== 0n) return 'it would move ETH too';
    if (-steth > amount || -steth < amount - SHARE_ROUNDING * BigInt(requests)) return `it would take ${-steth} of your stETH, not ${amount}`;
    if (nfts !== requests) return "the simulation doesn't show the withdrawal request arriving";
  } else if (action === 'claim') {
    if (eth <= 0n) return "the simulation doesn't show ETH arriving";
    if (steth < 0n) return 'it would take stETH from you';
  }
  return null;
}

const prepared = new Map();
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A stake, a withdrawal request or a claim, built, simulated and checked: { id, preview, warnings, ... } for the
 * review. `amount` (ETH or stETH, as typed) for stake and request; `request` (an id of yours) for claim.
 */
export async function prepare({ action, amount, request }, { me, urls }) {
  const u = await urls(MAINNET);
  const calls = [];
  const ctx = { action, me };
  let what;
  if (action === 'stake') {
    const raw = parseUnits(amount, 18);
    if (raw <= 0n) throw fail('type an amount above zero');
    const wei = BigInt(await E.ethRpc(u, 'eth_getBalance', [me, 'latest']));
    if (raw >= wei) throw fail(`you have ${formatUnits(wei, 18)} ETH on Ethereum, and the network fee is paid in ETH too`);
    calls.push({ to: STETH, value: raw, data: stakeData(), kind: 'stake' });
    Object.assign(ctx, { amount: raw });
    what = { pay: `${formatUnits(raw, 18)} ETH`, get: `${formatUnits(raw, 18)} stETH` };
  } else if (action === 'request') {
    const raw = parseUnits(amount, 18);
    const held = await tokenBalance(u, STETH, me);
    if (raw < MIN_REQUEST) throw fail('type an amount above zero');
    if (raw > held) throw fail(`you have ${formatUnits(held, 18)} stETH`);
    const amounts = [];
    for (let left = raw; left > 0n; left -= left > MAX_REQUEST ? MAX_REQUEST : left) amounts.push(left > MAX_REQUEST ? MAX_REQUEST : left);
    // a last piece under the queue's minimum rides with the one before it
    if (amounts.length > 1 && amounts.at(-1) < MIN_REQUEST) { const tail = amounts.pop(); amounts[amounts.length - 1] -= MIN_REQUEST - tail; amounts.push(MIN_REQUEST); }
    if ((await allowance(u, STETH, me, QUEUE)) < raw) calls.push({ to: STETH, value: 0n, data: approveData(QUEUE, raw), kind: 'approve' });
    calls.push({ to: QUEUE, value: 0n, data: requestData(amounts, me), kind: 'request' });
    Object.assign(ctx, { amount: raw, requests: amounts.length });
    what = { pay: `${formatUnits(raw, 18)} stETH`, get: amounts.length > 1 ? `${amounts.length} withdrawal requests` : 'a withdrawal request' };
  } else if (action === 'claim') {
    const id = String(request ?? '');
    if (!/^[0-9]{1,30}$/.test(id)) throw fail('pick a withdrawal request');
    const mine = (await state({ me, urls })).requests.find((x) => x.id === id);
    if (!mine) throw fail("that withdrawal request isn't yours, or it's already claimed");
    if (!mine.finalized) throw fail("Lido hasn't finalized that withdrawal yet: it usually takes a few days");
    calls.push({ to: QUEUE, value: 0n, data: claimData(BigInt(id)), kind: 'claim' });
    Object.assign(ctx, { id });
    what = { pay: `withdrawal request #${id}`, get: 'ETH' };
  } else throw fail('unknown staking step');
  const fees = await E.feeQuote(u, MAINNET);
  const sim = await E.simulateCalls(u, me, calls, { fees });
  const bad = simProblem(sim, ctx);
  if (bad) throw fail(`plum refused this: ${bad}`);
  const gas = sim.calls.map((c, i) => (c.gasUsed ? (c.gasUsed * 13n) / 10n + 10_000n : calls[i].kind === 'approve' ? 80_000n : 300_000n));
  const totalGas = gas.reduce((n, g) => n + g, 0n);
  const changes = sim.changes.map((ch) => (ch.token == null
    ? { symbol: 'ETH', decimals: 18, delta: ch.delta.toString(), verified: true }
    : { symbol: E.sameAddress(ch.token, STETH) ? 'stETH' : ch.token, decimals: 18, delta: ch.delta.toString(), verified: true }));
  const warnings = [];
  for (const c of sim.calls) for (const a of c.approvals) if (a.nft != null) warnings.push({ level: 'info', text: `${a.out ? 'a withdrawal request leaves your wallet (it becomes the ETH)' : 'a withdrawal request comes into your wallet'}: #${a.nft}` });
  if (action === 'request') warnings.push({ level: 'info', text: "Lido finalizes withdrawals in a few days (sometimes longer); then claim the ETH here. stETH stops earning once it's requested." });
  if (action === 'stake') warnings.push({ level: 'info', text: 'stETH grows each day as the stake earns; getting ETH back is a withdrawal request, finalized by Lido in a few days' });
  const id = newId();
  for (const [k, v] of prepared) if (Date.now() - v.at > PREPARED_TTL * 2) prepared.delete(k);
  prepared.set(id, { at: Date.now(), me, calls: calls.map((c, i) => ({ ...c, gas: gas[i] })), fees, ctx });
  const main = calls.at(-1);
  return {
    id, action, net: 'ethereum', ...what,
    steps: calls.map((c) => c.kind),
    approval: calls.length > 1 ? { token: 'stETH', amount: formatUnits(ctx.amount, 18), spender: QUEUE } : null,
    preview: {
      chain: 'eth', net: { key: 'ethereum', title: 'Ethereum', symbol: 'ETH' }, sim: { ok: true, error: null }, changes,
      fee: { est: (totalGas * (fees.base + fees.tip)).toString(), max: (totalGas * fees.maxFee).toString(), gas: totalGas.toString() },
      warnings: [], call: { to: main.to, value: main.value.toString(), name: { stake: 'submit (Lido)', request: 'requestWithdrawals (Lido)', claim: 'claimWithdrawal (Lido)' }[action], bytes: (main.data.length - 2) / 2 },
      txs: calls.length,
    },
    warnings,
  };
}

/** Sign and send a prepared step: the approval first when it has one, then the call once checked again. */
export async function submit({ id }, deps) {
  const p = prepared.get(id);
  if (!p) throw fail('that expired: review it again');
  prepared.delete(id);
  if (Date.now() - p.at > PREPARED_TTL) throw fail('that took too long (its fee may have moved): review it again');
  if (!E.sameAddress(p.me, deps.me)) throw fail('the wallet changed: review it again');
  const { hash, approvals } = await sendSteps(MAINNET, p, deps, (sim) => { const bad = simProblem(sim, p.ctx); if (bad) throw fail(bad); });
  return { signature: hash, approvals, chain: 'eth', net: 'ethereum', explorer: E.explorerTx(hash, MAINNET), explorerName: MAINNET.explorerName };
}

export const _test = { prepared, requestData, stakeData, claimData };
