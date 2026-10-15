// Swaps on Ethereum, Base, Arbitrum and Polygon, routed by KyberSwap's aggregator (no API key). Like Jupiter on
// Solana, everything KyberSwap answers is data that plum checks before you see it:
//   - the transaction must go to KyberSwap's router (MetaAggregationRouterV2: one address on every network, not a
//     proxy, so its code can't change under plum) and call its swap(), and its executor must be KyberSwap's;
//   - plum reads that call itself: it sells exactly what you typed of the token you picked, buys the one you picked,
//     pays it to you, takes no fee and carries no permit, and its minimum (which the router itself enforces on chain)
//     is no less than the quote you saw, less your slippage;
//   - a token's approval is plum's own: for exactly the amount you sell, to the router, never more;
//   - the approval and the swap are run together on the latest block: only what you sell may leave, at least the
//     minimum must arrive, and no other approval may be given; anything else and plum refuses the swap outright;
//   - the quote is compared with market prices from elsewhere (CoinGecko and Blockscout): one far worse is a danger;
//   - right before the swap is sent, it is simulated and checked again.
// On Ethereum it goes out through MEV Blocker. Every transaction has one signer: your wallet.
import { formatUnits, parseUnits, short } from '../shared/format.js';
import { cleanLine } from '../shared/text.js';
import * as E from './eth.js';
import { networkByKey } from './evm-chains.js';
import { allowance, approveData, sendSteps, tokenBalance } from './evm-steps.js';
import { NetError, request } from './net.js';
import { priceOf } from './prices.js';

export const KYBER = 'https://aggregator-api.kyberswap.com';
/** KyberSwap's router, the same on all four networks; the only contract a swap may call, and the only spender. */
export const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
/** KyberSwap's executor: the router hands it the trade. */
export const EXECUTORS = ['0x8F10B468b06c6FD214B65F87778827F7D113f996'];
/** How KyberSwap (and the router) name a network's own coin. */
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SWAP = 'e21fd0e9'; // swap(SwapExecutionParams)
// the router's flags plum refuses: partial fills, extra ETH, gas-token burning, fees, and approving anyone
const BAD_FLAGS = 0x01n | 0x02n | 0x08n | 0x10n | 0x40n | 0x80n | 0x100n;
const SLUG = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon' };
const QUOTE_TTL = 60_000;
const PREPARED_TTL = 90_000;

const fail = (message) => new Error(message);
const isNative = (t) => !t || E.sameAddress(t, NATIVE);

/** Tokens offered on each network before you search: their own contracts, read from the chain. */
export const TOKENS = {
  ethereum: [['USDC', 6, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'], ['USDT', 6, '0xdAC17F958D2ee523a2206206994597C13D831ec7'], ['DAI', 18, '0x6B175474E89094C44Da98b954EedeAC495271d0F'], ['WETH', 18, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'], ['WBTC', 8, '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'], ['stETH', 18, '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'], ['wstETH', 18, '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'], ['LINK', 18, '0x514910771AF9Ca656af840dff83E8264EcF986CA'], ['UNI', 18, '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'], ['PEPE', 18, '0x6982508145454Ce325dDbE47a25d4ec3d2311933']],
  base: [['USDC', 6, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'], ['USDT', 6, '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'], ['DAI', 18, '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'], ['WETH', 18, '0x4200000000000000000000000000000000000006'], ['cbBTC', 8, '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'], ['cbETH', 18, '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'], ['wstETH', 18, '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452'], ['AERO', 18, '0x940181a94A35A4569E4529A3CDfB74e38FD98631']],
  arbitrum: [['USDC', 6, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'], ['USDT0', 6, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'], ['DAI', 18, '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'], ['WETH', 18, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'], ['WBTC', 8, '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'], ['wstETH', 18, '0x5979D7b546E38E414F7E9822514be443A4800529'], ['ARB', 18, '0x912CE59144191C1204E64559FE8253a0e49E6548'], ['GMX', 18, '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a']],
  polygon: [['USDC', 6, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'], ['USDT0', 6, '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'], ['DAI', 18, '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'], ['WPOL', 18, '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'], ['WETH', 18, '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'], ['WBTC', 8, '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6'], ['LINK', 18, '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39'], ['AAVE', 18, '0xD6DF932A45C0f255f85145f286eA0b292B21C90B']],
};

/** The tokens to pick from on a network (its coin first). */
export function tokenList(netKey) {
  const net = networkByKey(netKey);
  if (!net) throw fail('pick a network');
  return [
    { chain: 'eth', net: net.key, mint: null, symbol: net.native.symbol, name: net.native.name, decimals: 18, verified: true },
    ...TOKENS[net.key].map(([symbol, decimals, mint]) => ({ chain: 'eth', net: net.key, mint, symbol, name: null, decimals, verified: true })),
  ];
}

/* ------------------------------------------------------------ KyberSwap's API */

async function kyber(path, { method = 'GET', body } = {}) {
  const r = await request(`${KYBER}${path}`, { method, body, headers: { accept: 'application/json', 'x-client-id': 'plum' }, timeout: 20_000 });
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* not json */ }
  if (r.status === 429) throw new NetError('KyberSwap is busy right now: try again in a moment');
  if (!j || r.status >= 400 || (j.code != null && j.code !== 0)) throw new NetError(cleanLine(String(j?.message || `KyberSwap answered ${r.status}`), 160));
  return j.data;
}

const intText = (v) => typeof v === 'string' && /^[0-9]{1,78}$/.test(v);

/* ------------------------------------------------------------ the router's swap(), read by plum */

/**
 * swap(SwapExecutionParams) read from call data, following its offsets the way Solidity's decoder does: { callTarget,
 * approveTarget, desc: { srcToken, dstToken, srcReceivers, srcAmounts, feeReceivers, feeAmounts, dstReceiver, amount,
 * minReturnAmount, flags, permit } }. Throws on anything else, or anything malformed.
 */
export function readSwap(data) {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw fail("KyberSwap's transaction data is malformed");
  if (data.slice(2, 10).toLowerCase() !== SWAP) throw fail(`KyberSwap's transaction calls ${data.slice(0, 10)} on the router, not its swap: plum won't sign it`);
  const body = E.fromHex(`0x${data.slice(10)}`);
  const bad = () => fail("KyberSwap's transaction data is malformed");
  const word = (at) => {
    if (!Number.isSafeInteger(at) || at < 0 || at + 32 > body.length) throw bad();
    let n = 0n;
    for (let i = at; i < at + 32; i++) n = (n << 8n) | BigInt(body[i]);
    return n;
  };
  const addr = (at) => {
    const w = word(at);
    if (w >> 160n) throw bad();
    return E.checkAddress(`0x${w.toString(16).padStart(40, '0')}`);
  };
  const off = (base, at) => {
    const o = word(base + at);
    if (o > BigInt(body.length)) throw bad();
    return base + Number(o);
  };
  const len = (at) => {
    const n = word(at);
    if (n > BigInt(body.length)) throw bad();
    return Number(n);
  };
  const list = (at, read) => { const n = len(at); return Array.from({ length: n }, (_, i) => read(at + 32 + 32 * i)); };
  const bytes = (at) => {
    const n = len(at);
    if (at + 32 + n > body.length) throw bad();
    return E.toHex(body.subarray(at + 32, at + 32 + n));
  };
  const exec = off(0, 0);
  const d = off(exec, 96);
  return {
    callTarget: addr(exec),
    approveTarget: addr(exec + 32),
    targetData: bytes(off(exec, 64)),
    clientData: bytes(off(exec, 128)),
    desc: {
      srcToken: addr(d), dstToken: addr(d + 32),
      srcReceivers: list(off(d, 64), addr), srcAmounts: list(off(d, 96), word),
      feeReceivers: list(off(d, 128), addr), feeAmounts: list(off(d, 160), word),
      dstReceiver: addr(d + 192), amount: word(d + 224), minReturnAmount: word(d + 256), flags: word(d + 288),
      permit: bytes(off(d, 320)),
    },
  };
}

/** What's wrong with KyberSwap's transaction for this swap (in words), or null. */
export function swapProblem(tx, { me, sell, buy, amount, floor }) {
  if (!E.sameAddress(tx.to, ROUTER)) return `KyberSwap's transaction goes to ${tx.to}, not KyberSwap's router: plum won't sign it`;
  let s;
  try { s = readSwap(tx.data); } catch (e) { return e.message; }
  const d = s.desc;
  if (!EXECUTORS.some((x) => E.sameAddress(x, s.callTarget))) return `KyberSwap's transaction hands the trade to ${s.callTarget}, which isn't KyberSwap's executor: plum won't sign it`;
  if (!E.sameAddress(d.srcToken, sell)) return "KyberSwap's transaction sells another token than the one you picked";
  if (!E.sameAddress(d.dstToken, buy)) return "KyberSwap's transaction buys another token than the one you picked";
  if (!E.sameAddress(d.dstReceiver, me)) return `KyberSwap's transaction pays what you buy to ${d.dstReceiver}, not to you`;
  if (d.amount !== amount) return "KyberSwap's transaction sells another amount than the one you typed";
  if (d.feeReceivers.length || d.feeAmounts.some((x) => x !== 0n)) return `KyberSwap's transaction takes a fee for ${d.feeReceivers[0] ?? 'someone'}`;
  if (d.flags & BAD_FLAGS) return `KyberSwap's transaction asks the router for something a plain swap doesn't need (flags 0x${d.flags.toString(16)})`;
  if (d.permit !== '0x') return "KyberSwap's transaction carries a permit: plum gives approvals itself";
  if (d.srcAmounts.reduce((n, x) => n + x, 0n) > amount) return "KyberSwap's transaction hands out more than you sell";
  if (d.minReturnAmount < floor) return `KyberSwap's transaction would accept less than the quote you saw allows (at least ${floor}, it says ${d.minReturnAmount})`;
  const value = isNative(sell) ? amount : 0n;
  if (tx.value !== value) return `KyberSwap's transaction sends ${tx.value} wei with it, not ${value}`;
  return null;
}

/* ------------------------------------------------------------ balances */

async function balanceOf(urls, token, owner) {
  if (isNative(token)) return BigInt(await E.ethRpc(urls, 'eth_getBalance', [owner, 'latest']));
  return tokenBalance(urls, token, owner);
}

/* ------------------------------------------------------------ quotes */

const quotes = new Map(); // id -> { at, ... }
const prepared = new Map(); // id -> { at, ... }
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const sweep = (map, ttl) => { for (const [k, v] of map) if (Date.now() - v.at > ttl * 2) map.delete(k); };

/** A token as the swap screen gives it: { mint (null for the coin), symbol, decimals }; its decimals read from the
 * chain when they aren't one of the built-in tokens'. */
async function tokenOf(urls, net, mint) {
  if (mint == null || isNative(mint)) return { mint: null, address: NATIVE, symbol: net.native.symbol, decimals: 18 };
  const a = E.checkAddress(mint);
  const known = TOKENS[net.key].find(([, , m]) => E.sameAddress(m, a));
  if (known) return { mint: a, address: a, symbol: known[0], decimals: known[1], known: true };
  const [decimals, meta] = await Promise.all([E.tokenDecimals(urls, a), E.tokenMeta(a, net)]);
  return { mint: a, address: a, symbol: meta.symbol ?? short(a, 6), decimals, known: false, verified: !!meta.price };
}

/** A token pasted into the swap picker, read from its network: { chain, net, mint, symbol, name, decimals, verified }
 * (verified when Blockscout knows a market price for it). */
export async function lookupToken(netKey, address, { urls }) {
  const net = networkByKey(netKey);
  if (!net) throw fail('pick a network');
  const a = E.checkAddress(String(address ?? ''));
  const u = await urls(net);
  let decimals;
  try { decimals = await E.tokenDecimals(u, a); } catch { throw fail(`that address isn't a token on ${net.title}`); }
  const meta = await E.tokenMeta(a, net);
  const known = TOKENS[net.key].find(([, , m]) => E.sameAddress(m, a));
  return { chain: 'eth', net: net.key, mint: a, symbol: known?.[0] ?? meta.symbol ?? short(a, 6), name: meta.name, decimals, verified: !!known || !!meta.price };
}

/** A token's price in dollars from somewhere other than KyberSwap (CoinGecko for the coin, Blockscout for tokens), or
 * null. */
async function marketPrice(net, t) {
  if (!t.mint) return (await priceOf(net.native.price)).price;
  return (await E.tokenMeta(t.mint, net)).price;
}

/** A quote from KyberSwap: what you'd get for `amount` of `sell` in `buy` on a network, kept for a minute. */
export async function quote({ net: netKey, sell, buy, amount, slippageBps }, { me, urls }) {
  const net = networkByKey(netKey);
  if (!net) throw fail('pick a network');
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 5000) throw fail('slippage must be between 0.01% and 50%');
  const u = await urls(net);
  const [a, b] = await Promise.all([tokenOf(u, net, sell), tokenOf(u, net, buy)]);
  if (a.address.toLowerCase() === b.address.toLowerCase()) throw fail('pick two different tokens');
  const raw = parseUnits(amount, a.decimals);
  if (raw <= 0n) throw fail('type an amount above zero');
  const held = await balanceOf(u, a.address, me);
  if (raw > held) throw fail(`you have ${formatUnits(held, a.decimals)} ${a.symbol} on ${net.title}`);
  const r = await kyber(`/${SLUG[net.key]}/api/v1/routes?tokenIn=${a.address}&tokenOut=${b.address}&amountIn=${raw}`);
  const s = r?.routeSummary;
  if (!s || !E.sameAddress(s.tokenIn, a.address) || !E.sameAddress(s.tokenOut, b.address) || String(s.amountIn) !== String(raw) || !intText(s.amountOut) || BigInt(s.amountOut) <= 0n) {
    throw fail("KyberSwap's quote doesn't match what you asked for");
  }
  if (r.routerAddress != null && !E.sameAddress(r.routerAddress, ROUTER)) throw fail(`KyberSwap's quote is for a router plum doesn't know (${short(String(r.routerAddress), 6)})`);
  const out = BigInt(s.amountOut);
  const inUsd = Number(s.amountInUsd), outUsd = Number(s.amountOutUsd);
  const impact = Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0 ? Math.max(0, ((inUsd - outUsd) / inUsd) * 100) : null;
  const venues = [...new Set((s.route ?? []).flat().map((h) => cleanLine(String(h?.exchange ?? ''), 24)).filter(Boolean))].slice(0, 4);
  sweep(quotes, QUOTE_TTL);
  const id = newId();
  quotes.set(id, { at: Date.now(), net: net.key, me, sell: a, buy: b, amount: raw, out, bps, summary: s });
  return {
    id, net: net.key, netTitle: net.title,
    inAmount: formatUnits(raw, a.decimals), outAmount: formatUnits(out, b.decimals), minOut: formatUnits((out * BigInt(10_000 - bps)) / 10_000n, b.decimals),
    inSymbol: a.symbol, outSymbol: b.symbol, priceImpact: impact, route: venues,
  };
}

/* ------------------------------------------------------------ preparing: build, check, simulate */

/** The checks a simulated approval-and-swap must pass, in words (null when it passes): only what you sell leaves, at
 * least the minimum arrives, no approval beyond the router's exact amount, nothing else of yours moves. */
export function simProblem(sim, { sell, buy, amount, floor }) {
  if (!sim) return "plum couldn't simulate this swap, so it won't send it";
  if (!sim.ok) return `the swap would fail (${sim.error}): get a new quote`;
  const sellKey = isNative(sell) ? null : sell.toLowerCase();
  const buyKey = isNative(buy) ? null : buy.toLowerCase();
  const key = (t) => (t == null ? null : t.toLowerCase());
  // the coin's moves are only seen when the RPC traces them: none at all, when the coin is bought or sold, means plum
  // can't see what you'd get (nothing arrives, or the RPC doesn't trace), so it won't send it
  if ((sellKey == null || buyKey == null) && !sim.calls.some((c) => c.native)) return "the simulation shows none of the network's coin moving, so plum can't see what you'd get: it won't send this swap";
  for (const [i, c] of sim.calls.entries()) {
    const inSwap = i === sim.calls.length - 1;
    for (const a of c.approvals) {
      if (a.nft != null && a.out) return 'the swap would also take an NFT from you';
      if (a.nft != null) continue;
      if (a.all || a.item != null || a.permit2) return `the swap would also let ${a.spender} take tokens of yours`;
      if (!E.sameAddress(a.spender, ROUTER) || key(a.token) !== sellKey) return `the swap would also let ${a.spender} spend tokens of yours`;
      // plum's own approval is for the amount at most; inside the swap, the router's allowance can only go down (only
      // you can raise it, and plum carries no permit), so what's left of one you gave before is fine
      if (!inSwap && a.amount > amount) return `the swap would let ${a.spender} spend more than you sell`;
    }
  }
  let got = 0n, sold = 0n;
  for (const ch of sim.changes) {
    const k = key(ch.token);
    if (k === sellKey) sold = -ch.delta;
    else if (k === buyKey) got = ch.delta;
    else if (ch.delta < 0n) return `the swap would also take ${ch.token ?? 'the coin'} from you`;
  }
  if (sold > amount) return `the swap would take more than you sell (${sold}, not ${amount})`;
  if (sold <= 0n) return "the simulation doesn't show what you sell leaving: plum won't trust it";
  if (got <= 0n) return "the simulation doesn't show you receiving what you're buying";
  if (got < floor) return `the swap would give you less than its minimum (${got}, at least ${floor} was quoted)`;
  return null;
}

/**
 * Turn a quote into the transactions to sign (an exact approval when it's needed, then the swap), read and simulated:
 * { id, preview, warnings, ... } for the review screen. Refused outright when KyberSwap's transaction or its
 * simulation isn't the swap you asked for.
 */
export async function prepare({ quoteId }, { me, urls }) {
  const q = quotes.get(quoteId);
  if (!q || Date.now() - q.at > QUOTE_TTL) throw fail('that quote is old: get a new one');
  if (!E.sameAddress(q.me, me)) throw fail('the wallet changed: get a new quote');
  const net = networkByKey(q.net);
  const u = await urls(net);
  const built = await kyber(`/${SLUG[net.key]}/api/v1/route/build`, {
    method: 'POST',
    body: { routeSummary: q.summary, sender: me, recipient: me, slippageTolerance: q.bps, deadline: Math.floor(Date.now() / 1000) + 1200, source: 'plum' },
  });
  if (!built || typeof built.data !== 'string' || !intText(String(built.amountOut ?? '')) || !intText(String(built.transactionValue ?? '0'))) throw fail("KyberSwap didn't return a swap");
  if (built.routerAddress != null && !E.sameAddress(built.routerAddress, ROUTER)) throw fail(`KyberSwap's swap goes to ${built.routerAddress}, not KyberSwap's router: plum won't sign it`);
  // the least you accept: the quote you saw (or the built swap's, if lower by rounding), less your slippage
  const builtOut = BigInt(built.amountOut);
  if (builtOut * 10_000n < q.out * 9_990n) throw fail("KyberSwap's swap gives less than its quote: get a new quote");
  const base = builtOut < q.out ? builtOut : q.out;
  const exact = (base * BigInt(10_000 - q.bps)) / 10_000n;
  // (less a billionth, for KyberSwap's own rounding of the same sum)
  const floor = exact - exact / 1_000_000_000n - 1n;
  const swap = { to: E.checkAddress(String(built.routerAddress ?? ROUTER)), value: BigInt(built.transactionValue ?? 0), data: built.data };
  const ctx = { me, sell: q.sell.address, buy: q.buy.address, amount: q.amount, floor };
  const problem = swapProblem(swap, ctx);
  if (problem) throw fail(problem);
  // the approval: plum's own, exactly the amount, only when the router can't already spend it
  const calls = [];
  const warnings = [];
  if (q.sell.mint) {
    const has = await allowance(u, q.sell.address, me, ROUTER);
    if (has < q.amount) {
      // a token like USDT won't change one allowance to another: it goes to zero first
      if (has > 0n) calls.push({ to: q.sell.address, value: 0n, data: approveData(ROUTER, 0n), kind: 'reset' });
      calls.push({ to: q.sell.address, value: 0n, data: approveData(ROUTER, q.amount), kind: 'approve' });
    } else if (has >= (1n << 255n)) warnings.push({ level: 'info', text: `KyberSwap's router can already spend all of your ${q.sell.symbol} (an approval given before): this swap adds none` });
  }
  calls.push({ ...swap, kind: 'swap' });
  const fees = await E.feeQuote(u, net);
  const sim = await E.simulateCalls(u, me, calls, { fees });
  const bad = simProblem(sim, ctx);
  if (bad) throw fail(bad);
  const gas = sim.calls.map((c, i) => (c.gasUsed ? (c.gasUsed * 13n) / 10n + 10_000n : calls[i].kind === 'swap' ? 800_000n : 80_000n));
  const got = sim.changes.find((ch) => (isNative(q.buy.address) ? ch.token == null : E.sameAddress(ch.token ?? '', q.buy.address)))?.delta ?? 0n;
  // the price against the market, from elsewhere: a quote far worse than it is a danger you must see
  const [pIn, pOut] = await Promise.all([marketPrice(net, q.sell).catch(() => null), marketPrice(net, q.buy).catch(() => null)]);
  if (pIn && pOut) {
    const inUsd = (Number(q.amount) / 10 ** q.sell.decimals) * pIn;
    const outUsd = (Number(got) / 10 ** q.buy.decimals) * pOut;
    const worse = inUsd > 0 ? ((inUsd - outUsd) / inUsd) * 100 : 0;
    if (worse >= 10) warnings.push({ level: 'danger', text: `you'd get about ${worse.toFixed(1)}% less than market prices say it's worth ($${inUsd.toFixed(2)} for $${outUsd.toFixed(2)}): KyberSwap's quote may be lying, or there's too little to trade against` });
    else if (worse >= 3) warnings.push({ level: 'warn', text: `you'd get about ${worse.toFixed(1)}% less than market prices say it's worth` });
  } else warnings.push({ level: 'info', text: `plum has no market price for ${pIn ? q.buy.symbol : q.sell.symbol} to check KyberSwap's quote against` });
  if (q.buy.mint && !q.buy.known && !q.buy.verified) warnings.push({ level: 'warn', text: `${q.buy.symbol} (${short(q.buy.mint, 6)}) has no market price: anyone can name a token anything, so check its address` });
  const l1 = net.l1Fee ? ((await E.l1Fee(u, { nonce: 0n, maxPriorityFeePerGas: fees.tip, maxFeePerGas: fees.maxFee, gas: gas.at(-1), ...swap }, net)) ?? 0n) * BigInt(calls.length) : 0n;
  const totalGas = gas.reduce((n, g) => n + g, 0n);
  const coin = net.native.symbol;
  // what the simulation moved, all of it: what you sell, what you buy, and anything else that came in
  const which = (t) => [q.sell, q.buy].find((x) => (t == null ? !x.mint : x.mint && E.sameAddress(x.mint, t)));
  const changes = sim.changes.map((ch) => {
    const t = which(ch.token);
    return t
      ? { symbol: t.symbol, decimals: t.decimals, delta: ch.delta.toString(), verified: !t.mint || t === q.sell || t.known || !!t.verified }
      : { symbol: ch.token ? short(ch.token, 6) : coin, decimals: ch.token ? 0 : 18, delta: ch.delta.toString(), verified: !ch.token };
  }).sort((x, y) => (BigInt(x.delta) < 0n ? -1 : 0) - (BigInt(y.delta) < 0n ? -1 : 0));
  sweep(prepared, PREPARED_TTL);
  const id = newId();
  const danger = warnings.some((w) => w.level === 'danger');
  prepared.set(id, { at: Date.now(), net: net.key, me, calls: calls.map((c, i) => ({ ...c, gas: gas[i] })), fees, ctx, danger });
  return {
    id, chain: 'eth', net: net.key, netTitle: net.title,
    inAmount: formatUnits(q.amount, q.sell.decimals), outAmount: formatUnits(got, q.buy.decimals), minOut: formatUnits(floor > 0n ? floor : 0n, q.buy.decimals),
    inSymbol: q.sell.symbol, outSymbol: q.buy.symbol,
    steps: calls.map((c) => c.kind),
    approval: q.sell.mint && calls.length > 1 ? { token: q.sell.symbol, amount: formatUnits(q.amount, q.sell.decimals), spender: ROUTER } : null,
    preview: {
      chain: 'eth', net: { key: net.key, title: net.title, symbol: coin }, sim: { ok: true, error: null }, changes,
      fee: { est: (totalGas * (fees.base + fees.tip) + l1).toString(), max: (totalGas * fees.maxFee + l1).toString(), gas: totalGas.toString() },
      warnings: [], call: { to: ROUTER, value: swap.value.toString(), name: 'swap (KyberSwap)', bytes: (swap.data.length - 2) / 2 },
      txs: calls.length,
    },
    warnings,
  };
}

/* ------------------------------------------------------------ sending */

/**
 * Sign and send a prepared swap: its approval first (when it has one), and once that has landed, the swap, after one
 * more simulation that must pass the same checks (evm-steps.js). Each is signed by your wallet alone.
 * { signature, approvals, ... }
 */
export async function submit({ id, ignoreRisk = false }, deps) {
  const p = prepared.get(id);
  if (!p) throw fail('that swap expired: review it again');
  // a danger on the review (a price far under the market's) needs your "i understand" here too
  if (p.danger && ignoreRisk !== true) throw fail('this swap carries a danger: tick "i understand" to swap anyway');
  prepared.delete(id);
  if (Date.now() - p.at > PREPARED_TTL) throw fail('that took too long (the price and fee may have moved): get a new quote');
  if (!E.sameAddress(p.me, deps.me)) throw fail('the wallet changed: get a new quote');
  const net = networkByKey(p.net);
  const { hash, approvals } = await sendSteps(net, p, deps, (sim) => { const bad = simProblem(sim, p.ctx); if (bad) throw fail(bad); });
  return { signature: hash, approvals, chain: 'eth', net: net.key, explorer: E.explorerTx(hash, net), explorerName: net.explorerName };
}

export const _test = { quotes, prepared };
