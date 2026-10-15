// plum's RPC proxy: the one place plum's Solana RPC key lives. Anyone can unpack a browser extension, so a key built
// into plum would be a key handed to everyone. Instead the wallet asks https://plum.fun/rpc, and this forwards the calls
// plum makes (only those) to the paid RPC, whose URL stays in this server's environment and is never sent anywhere else.
//
// What gets through: one JSON-RPC call per request (no batches), from a browser extension (an Origin of
// moz-extension:// or chrome-extension://, which no web page can send), as application/json, at most MAX_BODY bytes,
// with its method in METHODS and its params in the shape Solana takes them. Each address (an IPv6 /64 counts as one)
// gets a rate with a burst, a daily allowance, its own rate for sends, an allowance of bytes and a few calls at a time;
// everyone together gets a rate, a daily allowance and a cap on calls at a time, so the paid plan has a ceiling. Nothing
// about who asked what is kept or logged: the log gets totals every 15 minutes.
//
//   UPSTREAM_RPC='https://mainnet.helius-rpc.com/?api-key=...' node proxy/rpc-proxy.mjs
//
// Settings come from the environment: UPSTREAM_RPC (required), HOST (127.0.0.1) and PORT (8792), REPORT_MINUTES (15),
// and any of LIMITS below by its name. No dependencies: node 22 or later.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** The limits, each one settable from the environment by its name. */
export const LIMITS = {
  IP_RATE: 6, // calls a second from one address, on average...
  IP_BURST: 120, // ...and at once (importing a recovery phrase checks ~60 wallets in a row)
  IP_DAILY: 25_000, // calls a day from one address
  IP_SEND_RATE: 1, // sendTransaction a second from one address (plum re-sends every ~5 s until a transaction lands)
  IP_SEND_BURST: 30,
  IP_BYTES_RATE: 2_000_000, // bytes of answers a second to one address...
  IP_BYTES_BURST: 64_000_000, // ...and at once
  IP_INFLIGHT: 12, // calls at a time from one address (the phrase scan runs 6 while home loads 3)
  ALL_RATE: 30, // calls a second from everyone together: keep it under the paid plan's own rate
  ALL_BURST: 150,
  ALL_DAILY: 300_000, // calls a day from everyone together: under the plan's monthly credits / 30, less what else uses the key
  ALL_SEND_RATE: 5,
  ALL_SEND_BURST: 25,
  ALL_INFLIGHT: 64, // calls at a time to the paid RPC
  MAX_BODY: 32 * 1024, // bytes in a request: plum's largest (a simulation reading 256 accounts) is ~14 KB
  MAX_ANSWER: 12 * 1024 * 1024, // bytes in an answer: a simulation that reads big market accounts can be a few MB
  TIMEOUT_MS: 20_000, // for the paid RPC to answer in full
};

/* ------------------------------------------------------------ the calls plum makes, and the params it sends them */

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const config = isObject;
const address = (v) => typeof v === 'string' && ADDRESS.test(v);
const addresses = (min, max) => (v) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(address);
const signatures = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 256 && v.every((s) => typeof s === 'string' && SIGNATURE.test(s));
// a transaction is at most 4096 bytes (a v1 one; legacy and v0 stop at 1232): 5464 characters of base64
const transaction = (v) => typeof v === 'string' && v.length <= 5464 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
const tokenFilter = (v) => isObject(v) && Object.keys(v).length === 1 && (address(v.mint) || address(v.programId));
const simConfig = (v) => isObject(v) && (v.accounts === undefined || (isObject(v.accounts) && addresses(0, 256)(v.accounts.addresses)));
const need = (check) => ({ check, required: true });
const may = (check) => ({ check, required: false });

/** Every method the wallet calls (src/background: rpc.js and main.js), each with its params in order. Nothing else. */
export const METHODS = {
  getAccountInfo: [need(address), may(config)],
  getBalance: [need(address), may(config)],
  getBlockHeight: [may(config)],
  getLatestBlockhash: [may(config)],
  getMultipleAccounts: [need(addresses(1, 100)), may(config)],
  getRecentPrioritizationFees: [may(addresses(0, 128))],
  getSignatureStatuses: [need(signatures), may(config)],
  getSignaturesForAddress: [need(address), may(config)],
  getTokenAccountsByOwner: [need(address), need(tokenFilter), may(config)],
  sendTransaction: [need(transaction), may(config)],
  simulateTransaction: [need(transaction), may(simConfig)],
};

/** A request turned down: the HTTP status, a JSON-RPC error code and message, and a short reason for the totals. */
export class Refusal extends Error {
  constructor(status, code, message, { why = 'refused', id = null, headers = {} } = {}) {
    super(message);
    Object.assign(this, { status, code, why, id, headers });
  }
}

/** The call in a request's body, checked: { id, method, params }, or a Refusal. */
export function readCall(text) {
  let call;
  try { call = JSON.parse(text); } catch { throw new Refusal(400, -32700, "that isn't JSON", { why: 'json' }); }
  if (Array.isArray(call)) throw new Refusal(400, -32600, 'one call per request (no batches)', { why: 'batch' });
  if (!isObject(call) || call.jsonrpc !== '2.0' || typeof call.method !== 'string') throw new Refusal(400, -32600, "that isn't a JSON-RPC 2.0 call", { why: 'json' });
  const id = call.id ?? null;
  if (!(id === null || Number.isSafeInteger(id) || (typeof id === 'string' && id.length <= 64))) throw new Refusal(400, -32600, 'the id must be a whole number or a short string', { why: 'json' });
  const shape = Object.hasOwn(METHODS, call.method) ? METHODS[call.method] : null;
  if (!shape) throw new Refusal(400, -32601, "plum's rpc doesn't answer that method", { why: 'method', id });
  const params = call.params ?? [];
  if (!Array.isArray(params) || params.length > shape.length || shape.some((p, i) => (params[i] === undefined ? p.required : !p.check(params[i])))) {
    throw new Refusal(400, -32602, `those aren't params plum sends with ${call.method}`, { why: 'params', id });
  }
  return { id, method: call.method, params };
}

/* ------------------------------------------------------------ who's asking, and how much they've asked */

/** The address a request counts against: Cloudflare's word for it when the request came in through the tunnel
 * (cloudflared, on this machine), else the connection's own. */
export function clientOf(req) {
  const peer = req.socket?.remoteAddress ?? '';
  const viaTunnel = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const said = req.headers['cf-connecting-ip'];
  return addressKey(viaTunnel && typeof said === 'string' && said ? said : peer);
}

/** An address as the limits count it: IPv4 as it is, IPv6 by its /64 (what one home or one server holds). */
export function addressKey(raw) {
  let ip = String(raw ?? '').trim().toLowerCase();
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return 'unknown';
  const [head, tail] = ip.split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    // an IPv4 address written at the end takes two groups
    const width = rest.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    groups.push(...Array(8 - groups.length - width).fill('0'), ...rest);
  }
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Token buckets, one per key: `rate` a second up to `burst`. The longest-idle keys go first past `max`. */
export class Buckets {
  #map = new Map();
  constructor(rate, burst, { max = 100_000, now = Date.now } = {}) {
    Object.assign(this, { rate, burst, max, now });
  }
  #level(key) {
    const t = this.now();
    const b = this.#map.get(key);
    return { tokens: b ? Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate) : this.burst, at: t };
  }
  #keep(key, b) {
    this.#map.delete(key);
    this.#map.set(key, b);
    if (this.#map.size > this.max) this.#map.delete(this.#map.keys().next().value);
  }
  /** Take `cost` if it's there: 0, or the seconds until it would be. (A cost of 0 asks whether the key is in debt.) */
  take(key, cost = 1) {
    const b = this.#level(key);
    if (b.tokens < cost) {
      this.#keep(key, b);
      return Math.max(1, Math.ceil((cost - b.tokens) / this.rate));
    }
    b.tokens -= cost;
    this.#keep(key, b);
    return 0;
  }
  /** Spend after the fact (bytes, once an answer has gone): it can go below zero, which then has to be waited out. */
  spend(key, cost) {
    const b = this.#level(key);
    b.tokens -= cost;
    this.#keep(key, b);
  }
  /** Forget the keys whose bucket is full again: they're the same as new. */
  sweep() {
    const t = this.now();
    for (const [key, b] of this.#map) if (b.tokens + ((t - b.at) / 1000) * this.rate >= this.burst) this.#map.delete(key);
  }
  get size() {
    return this.#map.size;
  }
}

/* ------------------------------------------------------------ the paid RPC */

/** The upstream URL, checked: https (or http on this machine), with its key in the path or query. Never echoed back:
 * a bad one is reported without it. */
export function upstreamOf(raw) {
  if (!raw) throw new Error('UPSTREAM_RPC is not set: the paid RPC URL, key and all');
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error("UPSTREAM_RPC isn't a URL"); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new Error('UPSTREAM_RPC must be https:// (http:// only on this machine)');
  if (u.username || u.password) throw new Error('UPSTREAM_RPC: put the key in the path or query, not before the host');
  return u.toString();
}

/** The parts of the upstream URL that are its key (query values, long path segments): never in an answer or a log. */
export function secretsOf(url) {
  const u = new URL(url);
  return [...u.searchParams.values(), ...u.pathname.split('/')].filter((s) => s.length >= 16).map((s) => Buffer.from(s));
}

/** A key's fingerprint for the log: the first 10 hex of its sha256. */
const fingerprint = (secret) => createHash('sha256').update(secret).digest('hex').slice(0, 10);

/** Pass an answer through as it streams, never past `max` bytes and never with a secret in it. `meter.bytes` counts
 * what came, cut off or not. */
async function relay(body, res, secrets, max, meter) {
  const keep = Math.max(0, ...secrets.map((s) => s.length - 1));
  let tail = Buffer.alloc(0);
  const check = new Transform({
    transform(chunk, _enc, done) {
      meter.bytes += chunk.length;
      if (meter.bytes > max) return done(new Refusal(502, -32603, 'that answer is too large', { why: 'answer-too-large' }));
      // the last bytes of the chunk before go in front, so a key split across two chunks is still seen
      const seen = tail.length ? Buffer.concat([tail, chunk]) : Buffer.from(chunk);
      if (secrets.some((s) => seen.includes(s))) return done(new Refusal(502, -32603, 'that answer was cut off', { why: 'key-in-answer' }));
      tail = keep ? seen.subarray(Math.max(0, seen.length - keep)) : tail;
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body), check, res);
}

/** The first `max` bytes of a body as text, and no more read than that. */
async function readSome(body, max) {
  const chunks = [];
  let size = 0;
  if (body) {
    for await (const chunk of body) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= max) break; // leaving the loop cancels the rest
    }
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/* ------------------------------------------------------------ the server */

// a browser extension's own origin: Firefox gives each install a random uuid, Chromium an id of 32 letters a-p
const EXTENSION = /^(?:moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|chrome-extension:\/\/[a-p]{32})$/i;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The limits from the environment: any of LIMITS set there to a number. */
function limitsFrom(env) {
  const out = {};
  for (const name of Object.keys(LIMITS)) {
    const v = Number(env[name]);
    if (env[name] != null && env[name] !== '' && Number.isFinite(v) && v >= 0) out[name] = v;
  }
  return out;
}

/**
 * The proxy, not yet listening: { server, limits, close() }. `upstream` (else env.UPSTREAM_RPC) is the paid RPC's URL;
 * `limits` override LIMITS (as does the environment); `now` and `log` are there for tests.
 */
export function makeProxy({ upstream, env = process.env, limits: given = {}, now = Date.now, log = console } = {}) {
  const target = upstreamOf(upstream ?? env.UPSTREAM_RPC);
  const secrets = secretsOf(target);
  const limits = { ...LIMITS, ...limitsFrom(env), ...given };
  const redact = (text) => secrets.reduce((t, s) => t.split(s.toString()).join('<key>'), String(text));
  const per = (rate, burst) => new Buckets(rate, burst, { now });
  const ip = {
    calls: per(limits.IP_RATE, limits.IP_BURST),
    daily: per(limits.IP_DAILY / 86_400, limits.IP_DAILY),
    sends: per(limits.IP_SEND_RATE, limits.IP_SEND_BURST),
    bytes: per(limits.IP_BYTES_RATE, limits.IP_BYTES_BURST),
  };
  const all = {
    calls: per(limits.ALL_RATE, limits.ALL_BURST),
    daily: per(limits.ALL_DAILY / 86_400, limits.ALL_DAILY),
    sends: per(limits.ALL_SEND_RATE, limits.ALL_SEND_BURST),
  };
  const inflight = new Map(); // address -> calls of its being answered now
  let busy = 0; // calls out to the paid RPC now

  // totals for the log, never who asked
  const totals = { calls: new Map(), refused: new Map(), bytes: 0 };
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const warned = new Map();
  /** Something the operator should know about now (at most once a minute per kind), with the key taken out. */
  const warn = (kind, text) => {
    if (warned.has(kind) && now() - warned.get(kind) < 60_000) return;
    warned.set(kind, now());
    log.warn?.(`[rpc] ${redact(text)}`);
  };
  const every = Number(env.REPORT_MINUTES) > 0 ? Number(env.REPORT_MINUTES) : 15;
  const report = () => {
    const calls = [...totals.calls].sort((a, b) => b[1] - a[1]);
    const n = calls.reduce((s, [, c]) => s + c, 0);
    if (!n && !totals.refused.size) return;
    const list = (pairs) => pairs.map(([k, c]) => `${k} ${c}`).join(', ') || 'none';
    log.info?.(`[rpc] last ${every} min: ${n} calls (${list(calls)}), ${(totals.bytes / 1e6).toFixed(1)} MB out; turned down: ${list([...totals.refused])}`);
    totals.calls.clear();
    totals.refused.clear();
    totals.bytes = 0;
  };
  const timers = [
    setInterval(report, every * 60_000),
    setInterval(() => { for (const b of [...Object.values(ip), ...Object.values(all)]) b.sweep(); }, 60_000),
  ];
  for (const t of timers) t.unref();

  const limited = (wait, message, why) => new Refusal(429, -32429, `${message}: try again in a moment`, { why, headers: { 'retry-after': String(wait) } });

  async function handle(req, res) {
    const path = new URL(req.url ?? '/', 'http://plum').pathname;
    const origin = typeof req.headers.origin === 'string' && EXTENSION.test(req.headers.origin) ? req.headers.origin : null;
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : { vary: 'origin' };
    const who = clientOf(req);
    // the caller hanging up stops everything done on their behalf, the paid RPC's answer included
    const ctl = new AbortController();
    let gone = false;
    res.once('close', () => { if (!res.writableFinished) { gone = true; ctl.abort(); } });
    let id = null;
    let mine = false;
    try {
      if (path === '/rpc/health' && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, { ok: true }, cors);
      if (path !== '/rpc') throw new Refusal(404, -32601, 'no such endpoint', { why: 'path' });
      if (!origin) throw new Refusal(403, -32003, "plum's rpc only answers the plum wallet", { why: 'origin' });
      if (req.method === 'OPTIONS') {
        // the browser asking, before plum's first call, whether an extension may POST JSON here
        const wait = ip.calls.take(who);
        if (wait) throw limited(wait, 'too many calls from your address', 'ip-rate');
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '7200' });
        return res.end();
      }
      if (req.method !== 'POST') throw new Refusal(405, -32600, 'POST one JSON-RPC call', { why: 'verb', headers: { allow: 'POST, OPTIONS' } });
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new Refusal(415, -32600, 'send the call as application/json', { why: 'type' });
      if (Number(req.headers['content-length'] ?? 0) > limits.MAX_BODY) throw new Refusal(413, -32600, 'that request is too large', { why: 'size', headers: { connection: 'close' } });

      // every request counts against its address before anything is done for it
      if ((inflight.get(who) ?? 0) >= limits.IP_INFLIGHT) throw limited(1, 'too many calls at once from your address', 'ip-at-once');
      inflight.set(who, (inflight.get(who) ?? 0) + 1);
      mine = true;
      let wait = ip.calls.take(who) || ip.daily.take(who);
      if (wait) throw limited(wait, 'too many calls from your address', 'ip-rate');
      wait = ip.bytes.take(who, 0);
      if (wait) throw limited(wait, 'too much downloaded by your address', 'ip-bytes');

      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > limits.MAX_BODY) throw new Refusal(413, -32600, 'that request is too large', { why: 'size', headers: { connection: 'close' } });
        chunks.push(c);
      }
      const call = readCall(Buffer.concat(chunks).toString('utf8'));
      id = call.id;
      if (call.method === 'sendTransaction') {
        wait = ip.sends.take(who);
        if (wait) throw limited(wait, 'too many sends from your address', 'ip-sends');
        wait = all.sends.take('all');
        if (wait) throw limited(wait, "plum's rpc is busy", 'all-sends');
      }
      wait = all.calls.take('all') || all.daily.take('all');
      if (wait) throw limited(wait, "plum's rpc is busy", 'all-rate');
      if (busy >= limits.ALL_INFLIGHT) throw limited(1, "plum's rpc is busy", 'all-at-once');

      // to the paid RPC: the checked call, written afresh (none of the caller's headers, bytes or address go with it)
      busy++;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, limits.TIMEOUT_MS);
      // what the answer weighed, paid for by the address whether it arrived whole or was cut off
      const meter = { bytes: 0 };
      try {
        const up = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params }),
          signal: ctl.signal,
          redirect: 'error',
        });
        if (up.status === 429) {
          await up.body?.cancel().catch(() => {});
          warn('upstream-429', 'the paid RPC is rate-limiting plum: lower ALL_RATE / ALL_DAILY, or raise the plan');
          throw limited(2, "plum's rpc is busy", 'upstream-429');
        }
        if (up.status === 401 || up.status === 403) {
          await up.body?.cancel().catch(() => {});
          warn('upstream-key', `the paid RPC refused its key (${up.status}): check UPSTREAM_RPC`);
          throw new Refusal(502, -32603, "plum's rpc can't reach the network right now", { why: 'upstream-key' });
        }
        if (!up.ok) {
          // the chain's own word on a bad call (a JSON-RPC error) goes back as it came; anything else doesn't
          const text = await readSome(up.body, 64 * 1024);
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json, or longer than this */ }
          if (json?.jsonrpc === '2.0' && isObject(json.error) && !secrets.some((s) => text.includes(s.toString()))) return send(res, up.status, text, cors);
          throw new Refusal(502, -32603, `plum's rpc got ${up.status} from the network: try again`, { why: `upstream-${up.status}` });
        }
        res.writeHead(200, { ...JSON_HEADERS, ...cors });
        await relay(up.body, res, secrets, limits.MAX_ANSWER, meter);
        count(totals.calls, call.method);
      } catch (e) {
        if (e instanceof Refusal) throw e;
        if (timedOut) throw new Refusal(504, -32603, 'the network took too long to answer', { why: 'upstream-slow' });
        if (gone) throw e;
        warn('upstream-down', `the paid RPC failed: ${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}`);
        throw new Refusal(502, -32603, "plum's rpc couldn't reach the network: try again", { why: 'upstream-down' });
      } finally {
        busy--;
        clearTimeout(timer);
        ip.bytes.spend(who, meter.bytes);
        totals.bytes += meter.bytes;
      }
    } catch (e) {
      const r = e instanceof Refusal ? e : null;
      if (!r && !gone) warn('error', `${e?.stack ?? e}`);
      if (r?.why === 'key-in-answer') warn('key-in-answer', "an answer from the paid RPC held the RPC's own key: it was cut off");
      count(totals.refused, gone ? 'caller-left' : r?.why ?? 'error');
      // an answer already under way can only be cut off; a caller still there gets a JSON-RPC error
      if (gone || res.headersSent) return res.destroy();
      const { status, code, message, headers } = r ?? { status: 500, code: -32603, message: 'something went wrong in plum\'s rpc', headers: {} };
      send(res, status, { jsonrpc: '2.0', id: r?.id ?? id, error: { code, message } }, { ...cors, ...headers });
    } finally {
      if (mine) {
        const n = (inflight.get(who) ?? 1) - 1;
        if (n > 0) inflight.set(who, n);
        else inflight.delete(who);
      }
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 20_000 }, (req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  // longer than cloudflared keeps an idle connection (90 s), so it's always cloudflared that closes one
  server.keepAliveTimeout = 95_000;
  server.on('clientError', (_e, socket) => socket.destroy());

  return {
    server,
    limits,
    upstreamHost: new URL(target).host,
    fingerprint: secrets.length ? fingerprint(secrets[0]) : null,
    report,
    close: () => new Promise((done) => {
      for (const t of timers) clearInterval(t);
      server.close(() => done());
      server.closeIdleConnections?.();
    }),
  };
}

/* ------------------------------------------------------------ run as a service */

const isMain = import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  let proxy;
  try {
    proxy = makeProxy();
  } catch (e) {
    console.error(`plum rpc: ${e.message}`);
    process.exit(1);
  }
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8792);
  proxy.server.listen(port, host, () => {
    console.log(`plum rpc: listening on ${host}:${port}/rpc, forwarding to ${proxy.upstreamHost}${proxy.fingerprint ? ` (key fp ${proxy.fingerprint})` : ''}`);
  });
  const stop = () => {
    proxy.report();
    proxy.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
