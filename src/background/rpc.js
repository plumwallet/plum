// Talking to Solana: JSON-RPC over fetch, one network at a time. Mainnet goes to plum's own RPC; the public endpoints
// work but are rate-limited; any RPC URL (Helius, Triton, QuickNode...) can go in settings instead.

/** plum's own mainnet RPC: a proxy on plum.fun that holds the RPC key on the server (proxy/rpc-proxy.mjs) and passes
 * on only the calls below, so nothing secret is built into plum. */
export const PLUM_RPC = 'https://plum.fun/rpc';

/** Mainnet's RPC as built into this copy: plum's own, unless the build named another (build.mjs --rpc / --own-rpc). */
const BUILT_IN = typeof __PLUM_MAINNET_RPC__ === 'string' && __PLUM_MAINNET_RPC__ ? __PLUM_MAINNET_RPC__ : PLUM_RPC;

export const NETWORKS = {
  mainnet: { chain: 'solana:mainnet', label: 'main', url: BUILT_IN, builtIn: true, cluster: '' },
  devnet: { chain: 'solana:devnet', label: 'devnet', url: 'https://api.devnet.solana.com', cluster: 'devnet' },
  testnet: { chain: 'solana:testnet', label: 'testnet', url: 'https://api.testnet.solana.com', cluster: 'testnet' },
  localnet: { chain: 'solana:localnet', label: 'localnet', url: 'http://127.0.0.1:8899', cluster: 'custom' },
};
export const networkOfChain = (chain) => Object.keys(NETWORKS).find((k) => NETWORKS[k].chain === chain) ?? null;

/** Only https (or plain http to this computer) may be an RPC: a key or a transaction never goes out in the clear. */
export function checkRpcUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("that isn't a URL"); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('an RPC must be https:// (or http:// on this computer)');
  if (u.username || u.password) throw new Error('put the RPC key in the path or query, not before the host');
  return u.toString();
}

export function explorerUrl(network, kind, id) {
  const cluster = NETWORKS[network]?.cluster;
  const q = cluster === 'custom' ? `?cluster=custom&customUrl=${encodeURIComponent(NETWORKS.localnet.url)}` : cluster ? `?cluster=${cluster}` : '';
  return `https://solscan.io/${kind}/${id}${q}`;
}

export class RpcError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;

/** The transport, swappable in tests. */
export const transport = {
  async post(url, body, timeout) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  },
};

/** One call. Retries on 429 / 5xx / network errors with backoff; a JSON-RPC error throws RpcError. */
export async function rpc(url, method, params = [], { timeout = 20_000, retries = 3 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(400 * 2 ** (attempt - 1));
    let res;
    try {
      res = await transport.post(url, { jsonrpc: '2.0', id: nextId++, method, params }, timeout);
    } catch (e) {
      last = new RpcError(e?.name === 'AbortError' ? 'the RPC took too long to answer' : "can't reach the RPC: check your connection or the RPC in settings");
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = new RpcError(res.status === 429 ? 'the RPC is rate-limiting plum: set your own RPC URL in settings' : `the RPC answered ${res.status}`);
      continue;
    }
    if (!res.json) throw new RpcError(`the RPC answered ${res.status} with something that isn't JSON`);
    if (res.json.error) throw new RpcError(res.json.error.message || 'the RPC returned an error', res.json.error);
    return res.json.result;
  }
  throw last;
}

/** A client bound to one URL, with the calls plum makes. */
export function client(url) {
  const call = (method, params, opts) => rpc(url, method, params, opts);
  return {
    url,
    call,
    async balance(address) {
      return BigInt((await call('getBalance', [address, { commitment: 'confirmed' }])).value);
    },
    /** Raw accounts (base64), null where there's none, 100 a call. */
    async accounts(addresses) {
      const out = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const r = await call('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
        out.push(...r.value);
      }
      return out;
    },
    async tokenAccounts(owner, programId) {
      return (await call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
    },
    async latestBlockhash() {
      return (await call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    },
    async simulate(b64, accounts = []) {
      const cfg = { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' };
      if (accounts.length) cfg.accounts = { encoding: 'base64', addresses: accounts };
      return (await call('simulateTransaction', [b64, cfg], { retries: 1 })).value;
    },
    async send(b64, { skipPreflight = false, preflightCommitment = 'confirmed', maxRetries } = {}) {
      const cfg = { encoding: 'base64', skipPreflight, preflightCommitment };
      if (maxRetries != null) cfg.maxRetries = maxRetries;
      return call('sendTransaction', [b64, cfg], { retries: 1 });
    },
    async statuses(signatures) {
      return (await call('getSignatureStatuses', [signatures, { searchTransactionHistory: false }])).value;
    },
    async signatures(address, limit = 25) {
      return call('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
    },
    async priorityFees(writable) {
      return call('getRecentPrioritizationFees', [writable.slice(0, 128)], { retries: 1 });
    },
    async blockHeight() {
      return call('getBlockHeight', [{ commitment: 'confirmed' }]);
    },
  };
}
