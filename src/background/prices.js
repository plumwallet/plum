// What a bitcoin, an ether and a POL are worth in dollars, and how much that moved today: CoinGecko's public prices,
// kept for a minute; if CoinGecko is down, mempool.space's bitcoin price and Blockscout's ether and POL prices (without
// the day's move). (SOL and Solana tokens are priced by Jupiter, in jupiter.js.)
import { getJson } from './net.js';

const TTL = 60_000;
let cache = null; // { at, btc: { price, change24h }, eth: { price, change24h }, pol: { price, change24h } }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const COINS = ['btc', 'eth', 'pol'];

async function coingecko() {
  const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,polygon-ecosystem-token&vs_currencies=usd&include_24hr_change=true', { timeout: 10_000 });
  const pick = (k) => ({ price: num(j?.[k]?.usd), change24h: num(j?.[k]?.usd_24h_change) });
  const out = { btc: pick('bitcoin'), eth: pick('ethereum'), pol: pick('polygon-ecosystem-token') };
  if (out.btc.price == null && out.eth.price == null) throw new Error('no prices');
  return out;
}

async function fallback() {
  const stats = (host) => getJson(`https://${host}/api/v2/stats`, { timeout: 10_000 }).then((j) => ({ price: num(j?.coin_price), change24h: num(j?.coin_price_change_percentage) })).catch(() => null);
  const [btc, eth, pol] = await Promise.all([
    getJson('https://mempool.space/api/v1/prices', { timeout: 10_000 }).then((j) => num(j?.USD)).catch(() => null),
    stats('eth.blockscout.com'),
    stats('polygon.blockscout.com'),
  ]);
  const none = { price: null, change24h: null };
  return { btc: { price: btc, change24h: null }, eth: eth ?? none, pol: pol ?? none };
}

/** { price, change24h } for 'btc', 'eth' or 'pol' (nulls when nobody answered). */
export async function priceOf(chain) {
  if (!cache || Date.now() - cache.at > TTL) {
    let fresh;
    try { fresh = await coingecko(); } catch { fresh = await fallback(); }
    // a price nobody gave keeps the last one we had
    for (const k of COINS) if (fresh[k]?.price == null && cache?.[k]?.price != null) fresh[k] = cache[k];
    cache = { at: Date.now(), ...fresh };
  }
  return cache[chain] ?? { price: null, change24h: null };
}

export const _prices = { reset: () => { cache = null; } };
