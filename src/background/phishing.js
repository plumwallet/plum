// Is a site safe to talk to? Two checks before any request reaches you:
//   1. Phantom's public blocklist (github.com/phantom/blocklist), fetched as data (never code) and refreshed twice a day.
//   2. Lookalikes: a site whose name is one or two letters off a well-known Solana site, or wears its name inside a
//      different domain (pump-fun.app, jup-ag.io, phantom-wallet.net), is flagged even before anyone lists it.
// Your own computer (localhost) is never flagged.

export const LIST_URLS = {
  block: 'https://raw.githubusercontent.com/phantom/blocklist/master/blocklist.yaml',
  allow: 'https://raw.githubusercontent.com/phantom/blocklist/master/whitelist.yaml',
};

/** Sites people sign on every day, by their real domain. */
export const BRANDS = [
  'phantom.app', 'phantom.com', 'solflare.com', 'backpack.app', 'metamask.io', 'pump.fun', 'jup.ag', 'raydium.io', 'orca.so',
  'meteora.ag', 'magiceden.io', 'tensor.trade', 'axiom.trade', 'gmgn.ai', 'bullx.io', 'dexscreener.com', 'birdeye.so',
  'solscan.io', 'solana.com', 'letsbonk.fun', 'bonk.fun', 'drift.trade', 'kamino.finance', 'jito.network', 'sanctum.so',
  'marginfi.com', 'tinyastro.io', 'padre.gg', 'plum.fun',
];
/** Names distinctive enough that wearing them inside another domain is suspicious (phantom-wallet.net). */
const DISTINCT = new Set(['phantom', 'solflare', 'metamask', 'raydium', 'magiceden', 'dexscreener', 'meteora', 'birdeye', 'solscan', 'kamino', 'marginfi', 'letsbonk']);
/** Names that are ordinary words too, so a near miss means nothing (draft vs drift). */
const NO_FUZZ = new Set(['drift', 'padre', 'tensor', 'axiom', 'orca', 'solana']);

/** `- url: example.com` lines of a YAML list, as lowercase domains (a leading `*.` is kept). */
export function parseList(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/^\s*-\s*url:\s*["']?([^"'\s#]+)["']?/gm)) out.add(m[1].toLowerCase());
  return out;
}

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost') || host.endsWith('.test');

/** The host and every parent of it: a.b.c.d -> [a.b.c.d, b.c.d, c.d]. */
function suffixes(host) {
  const parts = host.split('.');
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/** The most specific entry of a list that covers the host, with how specific it is: { match, depth } or null. */
function bestMatch(host, set) {
  if (!set?.size) return null;
  const parts = suffixes(host); // most specific first
  for (let i = 0; i < parts.length; i++) {
    const d = parts[i];
    if (set.has(d)) return { match: d, depth: parts.length - i };
    // "*.netlify.app" covers every site under it, not netlify.app itself
    if (i > 0 && set.has(`*.${d}`)) return { match: `*.${d}`, depth: parts.length - i };
  }
  return null;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}

/** The part of a domain people recognise: 'app.pump.fun' -> 'pump', 'pump-fun.app' -> 'pump-fun'. */
const label = (domain) => { const p = domain.split('.'); return p.length >= 2 ? p[p.length - 2] : p[0]; };
const site = (host) => host.split('.').slice(-2).join('.');
const squash = (s) => s.replace(/[^a-z0-9]/g, '');

/** A brand this host pretends to be, or null. */
export function lookalikeOf(host) {
  const mine = site(host);
  for (const brand of BRANDS) {
    if (mine === brand || host === brand || host.endsWith(`.${brand}`)) return null;
  }
  const name = label(host);
  const flat = squash(host.split('.').slice(0, -1).join('.'));
  for (const brand of BRANDS) {
    const b = label(brand);
    const bFull = squash(brand.replace(/\./g, ''));
    // pump-fun.app, pumpfun.io: the brand's whole domain typed as a name
    if (bFull.length >= 5 && flat.includes(bFull)) return brand;
    // phantom-wallet.net, raydium-swap.org: a distinctive brand name inside another domain
    if (DISTINCT.has(b) && flat.includes(b)) return brand;
    // phamtom.app, raydlum.io: one or two letters off
    if (NO_FUZZ.has(b) || b.length < 5) continue;
    const d = levenshtein(name, b);
    if (d > 0 && d <= (b.length >= 7 ? 2 : 1)) return brand;
  }
  return null;
}

/**
 * The verdict on a host: { level: 'blocked' | 'lookalike' | null, match }. `lists` is { block: Set, allow: Set }.
 */
export function checkHost(host, lists = {}) {
  const h = String(host || '').toLowerCase();
  if (!h || isLocal(h)) return { level: null, match: null };
  // the more specific entry wins: an allowed parent doesn't clear a blocked subdomain
  const allowed = bestMatch(h, lists.allow);
  const blocked = bestMatch(h, lists.block);
  if (blocked && (!allowed || blocked.depth > allowed.depth)) return { level: 'blocked', match: blocked.match };
  if (allowed) return { level: null, match: null };
  const brand = lookalikeOf(h);
  if (brand) return { level: 'lookalike', match: brand };
  return { level: null, match: null };
}

/** Fetch both lists: { block: [...], allow: [...], at }. Throws when they can't be read. */
export async function fetchLists(fetchFn = fetch) {
  const get = async (url) => {
    const res = await fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache' });
    if (!res.ok) throw new Error(`the blocklist answered ${res.status}`);
    return parseList(await res.text());
  };
  const [block, allow] = await Promise.all([get(LIST_URLS.block), get(LIST_URLS.allow)]);
  if (block.size < 100) throw new Error('the blocklist came back nearly empty');
  return { block: [...block], allow: [...allow], at: Date.now() };
}
