// Jupiter: token names, icons and prices, and swaps. Mainnet only. Everything it returns is data: a swap comes back as
// an unsigned transaction that plum reads, checks (one signer: you, you pay the fee, nothing signed yet) and simulates
// like any other before you see it.
import { cleanLine } from '../shared/text.js';
import { WSOL_MINT } from '../shared/tx.js';

export const JUP_DEFAULT = 'https://api.jup.ag';
const TTL = 6 * 3600_000;
const PRICE_TTL = 30_000;

const cache = new Map(); // mint -> { at, info }

function headers(apiKey) {
  const h = { accept: 'application/json' };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

async function getJson(url, { apiKey, timeout = 15_000, method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { ...headers(apiKey), 'content-type': 'application/json' } : headers(apiKey),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || json?.message || `Jupiter answered ${res.status}`);
    return json;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Jupiter took too long to answer');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const safeIcon = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' ? x.toString() : null; } catch { return null; }
};

/** The fields plum keeps about a token (all text; shown as text, never as markup). */
function pick(t) {
  return {
    mint: String(t.id),
    symbol: typeof t.symbol === 'string' ? cleanLine(t.symbol, 16) || null : null,
    name: typeof t.name === 'string' ? cleanLine(t.name, 48) || null : null,
    icon: typeof t.icon === 'string' ? safeIcon(t.icon) : null,
    decimals: Number.isInteger(t.decimals) ? t.decimals : null,
    program: typeof t.tokenProgram === 'string' ? t.tokenProgram : null,
    verified: t.isVerified === true,
    price: typeof t.usdPrice === 'number' && Number.isFinite(t.usdPrice) ? t.usdPrice : null,
    change24h: typeof t.stats24h?.priceChange === 'number' ? t.stats24h.priceChange : null,
  };
}

/** Name, icon and price for mints: Map(mint -> info). Cached; prices refresh every 30 s. */
export async function tokenInfo(mints, { base = JUP_DEFAULT, apiKey, fresh = false } = {}) {
  const now = Date.now();
  const want = [...new Set(mints)].filter((m) => {
    const c = cache.get(m);
    if (!c) return true;
    return now - c.at > (fresh ? PRICE_TTL : TTL);
  });
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100);
    const list = await getJson(`${base}/tokens/v2/search?query=${chunk.map(encodeURIComponent).join(',')}`, { apiKey });
    const found = new Set();
    for (const t of Array.isArray(list) ? list : []) {
      if (!chunk.includes(t?.id)) continue;
      found.add(t.id);
      cache.set(t.id, { at: now, info: pick(t) });
    }
    for (const m of chunk) if (!found.has(m)) cache.set(m, { at: now, info: null });
  }
  return new Map(mints.map((m) => [m, cache.get(m)?.info ?? null]));
}

/** Search tokens by name, symbol or mint (the swap picker). */
export async function searchTokens(query, { base = JUP_DEFAULT, apiKey } = {}) {
  const q = String(query).trim().slice(0, 64);
  if (!q) return [];
  const list = await getJson(`${base}/tokens/v2/search?query=${encodeURIComponent(q)}`, { apiKey });
  return (Array.isArray(list) ? list : []).slice(0, 20).map(pick);
}

export const solPrice = async (opts) => (await tokenInfo([WSOL_MINT], { ...opts, fresh: true })).get(WSOL_MINT)?.price ?? null;

/** A quote: amount in raw units of the input token. */
export async function quote({ inputMint, outputMint, amount, slippageBps }, { base = JUP_DEFAULT, apiKey } = {}) {
  const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps), restrictIntermediateTokens: 'true' });
  const r = await getJson(`${base}/swap/v1/quote?${q}`, { apiKey });
  if (!r?.outAmount || r.inputMint !== inputMint || r.outputMint !== outputMint || String(r.inAmount) !== String(amount)) {
    throw new Error("Jupiter's quote doesn't match what you asked for");
  }
  return r;
}

/** The swap as an unsigned transaction (base64) for `user` to sign. */
export async function swapTransaction(quoteResponse, user, { base = JUP_DEFAULT, apiKey, maxPriorityLamports = 1_000_000 } = {}) {
  const r = await getJson(`${base}/swap/v1/swap`, {
    apiKey,
    method: 'POST',
    timeout: 20_000,
    body: {
      quoteResponse,
      userPublicKey: user,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel: 'high' } },
    },
  });
  if (typeof r?.swapTransaction !== 'string') throw new Error("Jupiter didn't return a transaction");
  return r.swapTransaction;
}

export const _cache = cache;
