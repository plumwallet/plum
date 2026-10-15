// plum's RPC proxy (proxy/rpc-proxy.mjs) in front of a stand-in for the paid RPC: what it lets through, what it turns
// down, its limits, and that the paid RPC's key never comes back out of it. The wallet's own RPC client
// (src/background/rpc.js) makes each of its calls through it, so the proxy and the wallet can't drift apart unnoticed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Buckets, METHODS, addressKey, clientOf, makeProxy, readCall, secretsOf, upstreamOf } from '../proxy/rpc-proxy.mjs';
import { NETWORKS, PLUM_RPC, client, transport } from '../src/background/rpc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'test-key-0123456789abcdef'; // 16 characters or more: the proxy treats it as the paid RPC's key
const EXT = 'moz-extension://8b1f6c2e-5d3a-4c7e-9f10-000000000001';
const CHROME = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`;
const A = '11111111111111111111111111111111';
const B = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SIG = '5'.repeat(88);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the stand-in paid RPC */

const RESULTS = {
  getAccountInfo: { context: { slot: 1 }, value: null },
  getBalance: { context: { slot: 1 }, value: 5_000_000 },
  getBlockHeight: 123,
  getLatestBlockhash: { context: { slot: 1 }, value: { blockhash: B, lastValidBlockHeight: 150 } },
  getMultipleAccounts: { context: { slot: 1 }, value: [null, null] },
  getRecentPrioritizationFees: [{ slot: 1, prioritizationFee: 1000 }],
  getSignatureStatuses: { context: { slot: 1 }, value: [null] },
  getSignaturesForAddress: [],
  getTokenAccountsByOwner: { context: { slot: 1 }, value: [] },
  sendTransaction: SIG,
  simulateTransaction: { context: { slot: 1 }, value: { err: null, logs: [], accounts: [null] } },
};
const ok = (call) => ({ status: 200, body: { jsonrpc: '2.0', id: call.id, result: RESULTS[call.method] ?? null } });
let answer = ok; // how the stand-in answers: (call, req, res) => { status, body, type } or 'done' when it answered itself
const seen = []; // what reached it
let upstream;
let upUrl;

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString();
    const call = JSON.parse(text);
    seen.push({ url: req.url, headers: req.headers, call, text });
    const a = await answer(call, req, res);
    if (a === 'done') return;
    res.writeHead(a.status, { 'content-type': a.type ?? 'application/json' });
    res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upUrl = `http://127.0.0.1:${upstream.address().port}/?api-key=${KEY}`;
});
after(() => new Promise((r) => upstream.close(r)));

/* ------------------------------------------------------------ the proxy, and calling it */

const proxies = [];
let logged = [];
const log = { info: (l) => logged.push(l), warn: (l) => logged.push(l) };
let clock = 1_000_000;
const now = () => clock;

async function start(limits = {}, opts = {}) {
  const p = makeProxy({ upstream: upUrl, env: {}, limits, log, now, ...opts });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}/rpc`;
  proxies.push(p);
  return p;
}

beforeEach(() => {
  answer = ok;
  seen.length = 0;
  logged = [];
});
afterEach(async () => {
  while (proxies.length) await proxies.pop().close();
});

/** An HTTP request with exactly these headers (a new connection each time); resolves when the answer ends or is cut. */
function raw(url, { method = 'POST', headers = {}, body = '', parts = null, signal } = {}) {
  return new Promise((resolve) => {
    const req = request(url, { method, headers, agent: false, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => {});
      res.on('close', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json, or cut off */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, complete: res.complete });
      });
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: '', json: null, complete: false, error: e }));
    if (parts) {
      for (const p of parts) req.write(p);
      req.end();
    } else req.end(body);
  });
}

/** One call to the proxy, from plum (by default) at an address of the test's choosing. */
const post = (p, body, { origin = EXT, type = 'application/json', ip = null, headers = {} } = {}) => raw(p.url, {
  headers: { ...(type ? { 'content-type': type } : {}), ...(origin ? { origin } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
let nextId = 1;
const rpcCall = (method, params = []) => ({ jsonrpc: '2.0', id: nextId++, method, params });
const balance = (p, opts) => post(p, rpcCall('getBalance', [A, { commitment: 'confirmed' }]), opts);

/* ------------------------------------------------------------ the wallet and the proxy agree */

test('mainnet is plum.fun/rpc unless a build names another', () => {
  assert.equal(PLUM_RPC, 'https://plum.fun/rpc');
  assert.equal(NETWORKS.mainnet.url, PLUM_RPC);
  assert.equal(NETWORKS.mainnet.builtIn, true);
});

test('the proxy serves exactly the Solana methods the wallet calls', () => {
  const dir = join(ROOT, 'src', 'background');
  const used = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\bcall\('([A-Za-z]+)'/g)) used.add(m[1]);
  }
  assert.deepEqual([...used].sort(), Object.keys(METHODS).sort());
});

test("every call the wallet's RPC client makes goes through, as the wallet makes it", async () => {
  const p = await start();
  const original = transport.post;
  transport.post = async (url, body) => {
    const r = await raw(url, { headers: { 'content-type': 'application/json', origin: EXT }, body: JSON.stringify(body) });
    return { status: r.status, json: r.json };
  };
  try {
    const rpc = client(p.url);
    assert.equal(await rpc.balance(A), 5_000_000n);
    assert.deepEqual(await rpc.accounts([A, B]), [null, null]);
    assert.deepEqual(await rpc.tokenAccounts(A, TOKEN), []);
    assert.equal((await rpc.latestBlockhash()).blockhash, B);
    assert.equal((await rpc.simulate('AQIDBA==', [A])).err, null);
    assert.equal(await rpc.send('AQIDBA==', { maxRetries: 0 }), SIG);
    assert.deepEqual(await rpc.statuses([SIG]), [null]);
    assert.deepEqual(await rpc.signatures(A, 25), []);
    assert.equal((await rpc.priorityFees([A, B]))[0].prioritizationFee, 1000);
    assert.equal(await rpc.blockHeight(), 123);
    assert.equal((await rpc.call('getAccountInfo', [A, { encoding: 'jsonParsed' }])).value, null);
    assert.deepEqual((await rpc.call('getTokenAccountsByOwner', [A, { mint: B }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value, []);
  } finally {
    transport.post = original;
  }
  assert.equal(seen.length, 12);
  for (const s of seen) {
    // the key goes to the paid RPC and nowhere else; nothing of the caller's goes with it
    assert.equal(s.url, `/?api-key=${KEY}`);
    for (const h of ['origin', 'cf-connecting-ip', 'cookie', 'referer', 'user-agent']) assert.equal(s.headers[h] === undefined || h === 'user-agent', true, h);
    assert.deepEqual(Object.keys(s.call), ['jsonrpc', 'id', 'method', 'params']);
  }
  assert.deepEqual(seen[4].call.params[1].accounts, { encoding: 'base64', addresses: [A] });
});

/* ------------------------------------------------------------ who gets in */

test('only a browser extension gets an answer; web pages, scripts and null origins are turned away', async () => {
  const p = await start();
  for (const origin of [null, 'https://evil.example', 'null', 'moz-extension://not-a-uuid', 'chrome-extension://abc', 'http://localhost:3000']) {
    const r = await balance(p, { origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.match(r.json.error.message, /only answers the plum wallet/);
  }
  assert.equal(seen.length, 0);
  for (const origin of [EXT, CHROME]) {
    const r = await balance(p, { origin });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], origin);
    assert.match(r.headers.vary, /origin/i);
    assert.equal(r.json.result.value, 5_000_000);
  }
});

test("the browser's preflight is answered for extensions only", async () => {
  const p = await start();
  const ask = (origin) => raw(p.url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  const yes = await ask(EXT);
  assert.equal(yes.status, 204);
  assert.equal(yes.headers['access-control-allow-origin'], EXT);
  assert.equal(yes.headers['access-control-allow-methods'], 'POST');
  assert.equal(yes.headers['access-control-allow-headers'], 'content-type');
  assert.equal(yes.headers['access-control-max-age'], '7200');
  const no = await ask('https://evil.example');
  assert.equal(no.status, 403);
  assert.equal(no.headers['access-control-allow-origin'], undefined);
  assert.equal(seen.length, 0);
});

test('anything plum never sends is turned down before it reaches the paid RPC', async () => {
  const p = await start();
  const cases = [
    [rpcCall('getProgramAccounts', [TOKEN]), 400, -32601],
    [rpcCall('requestAirdrop', [A, 1_000_000_000]), 400, -32601],
    [rpcCall('getTransaction', [SIG]), 400, -32601],
    [rpcCall('__proto__', []), 400, -32601],
    [rpcCall('constructor', []), 400, -32601],
    [[rpcCall('getBalance', [A])], 400, -32600],
    ['{"jsonrpc":"2.0",', 400, -32700],
    [{ jsonrpc: '1.0', id: 1, method: 'getBalance', params: [A] }, 400, -32600],
    [{ jsonrpc: '2.0', id: { x: 1 }, method: 'getBalance', params: [A] }, 400, -32600],
    [rpcCall('getBalance', ['not an address']), 400, -32602],
    [rpcCall('getBalance', []), 400, -32602],
    [rpcCall('getBalance', [A, {}, 'extra']), 400, -32602],
    [rpcCall('getBalance', [A, 'confirmed']), 400, -32602],
    [{ jsonrpc: '2.0', id: 1, method: 'getBalance', params: { pubkey: A } }, 400, -32602],
    [rpcCall('getMultipleAccounts', [Array(101).fill(A)]), 400, -32602],
    [rpcCall('getMultipleAccounts', [[]]), 400, -32602],
    [rpcCall('getTokenAccountsByOwner', [A, {}]), 400, -32602],
    [rpcCall('getTokenAccountsByOwner', [A, { mint: B, programId: TOKEN }]), 400, -32602],
    [rpcCall('sendTransaction', ['A'.repeat(5468)]), 400, -32602],
    [rpcCall('sendTransaction', ['not base64!']), 400, -32602],
    [rpcCall('simulateTransaction', ['AQID', { accounts: { addresses: Array(257).fill(A) } }]), 400, -32602],
    [rpcCall('getSignatureStatuses', [['short']]), 400, -32602],
  ];
  for (const [body, status, code] of cases) {
    const r = await post(p, body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, code, JSON.stringify(body).slice(0, 80));
    assert.equal(r.headers['access-control-allow-origin'], EXT, 'plum can read why');
  }
  assert.equal((await post(p, rpcCall('getBalance', [A]), { type: 'text/plain' })).status, 415);
  assert.equal((await post(p, rpcCall('getBalance', [A]), { type: null })).status, 415);
  assert.equal((await raw(p.url, { method: 'GET', headers: { origin: EXT } })).status, 405);
  assert.equal((await raw(p.url.replace('/rpc', '/rpcx'), { headers: { origin: EXT, 'content-type': 'application/json' }, body: JSON.stringify(rpcCall('getBalance', [A])) })).status, 404);
  assert.equal((await raw(p.url.replace('/rpc', '/'), { method: 'GET' })).status, 404);
  assert.equal(seen.length, 0);
});

test('a request over MAX_BODY is turned down, with its length given or not', async () => {
  const p = await start({ MAX_BODY: 300 });
  const big = JSON.stringify(rpcCall('getMultipleAccounts', [Array(20).fill(A)]));
  assert.ok(big.length > 300);
  const declared = await post(p, big);
  assert.equal(declared.status, 413);
  const streamed = await raw(p.url, { headers: { origin: EXT, 'content-type': 'application/json' }, parts: [big.slice(0, 200), big.slice(200)] });
  assert.equal(streamed.status, 413);
  assert.equal(seen.length, 0);
  assert.equal((await post(p, rpcCall('getMultipleAccounts', [[A, B]]))).status, 200);
});

test('the health check answers anyone, without asking the paid RPC', async () => {
  const p = await start();
  const r = await raw(p.url.replace('/rpc', '/rpc/health'), { method: 'GET' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(seen.length, 0);
});

/* ------------------------------------------------------------ limits */

test('each address has its own rate and burst, and the bucket fills back up', async () => {
  const p = await start({ IP_RATE: 1, IP_BURST: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await balance(p, { ip: '198.51.100.7' })).status, 200);
  const no = await balance(p, { ip: '198.51.100.7' });
  assert.equal(no.status, 429);
  assert.equal(no.json.error.code, -32429);
  assert.ok(Number(no.headers['retry-after']) >= 1);
  assert.equal(no.headers['access-control-allow-origin'], EXT, 'plum can see it was rate-limited');
  assert.equal((await balance(p, { ip: '198.51.100.8' })).status, 200, 'another address is unaffected');
  clock += 1000;
  assert.equal((await balance(p, { ip: '198.51.100.7' })).status, 200, 'a second later there is one more');
  assert.equal((await balance(p, { ip: '198.51.100.7' })).status, 429);
});

test('an IPv6 /64 counts as one address', async () => {
  const p = await start({ IP_RATE: 0.001, IP_BURST: 2 });
  assert.equal((await balance(p, { ip: '2001:db8:1:2::1' })).status, 200);
  assert.equal((await balance(p, { ip: '2001:db8:1:2:ffff:ffff:ffff:9' })).status, 200);
  assert.equal((await balance(p, { ip: '2001:0db8:0001:0002:0:0:0:abcd' })).status, 429);
  assert.equal((await balance(p, { ip: '2001:db8:1:3::1' })).status, 200);
});

test('each address has a daily allowance', async () => {
  const p = await start({ IP_DAILY: 4 });
  for (let i = 0; i < 4; i++) assert.equal((await balance(p, { ip: '203.0.113.5' })).status, 200);
  assert.equal((await balance(p, { ip: '203.0.113.5' })).status, 429);
  clock += (86_400 / 4) * 1000;
  assert.equal((await balance(p, { ip: '203.0.113.5' })).status, 200, 'a quarter of a day later, a quarter of it is back');
});

test('sends have their own, lower rate; reads go on', async () => {
  const p = await start({ IP_SEND_RATE: 0.001, IP_SEND_BURST: 2 });
  const sendTx = () => post(p, rpcCall('sendTransaction', ['AQIDBA==', { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]), { ip: '203.0.113.9' });
  assert.equal((await sendTx()).status, 200);
  assert.equal((await sendTx()).status, 200);
  const no = await sendTx();
  assert.equal(no.status, 429);
  assert.match(no.json.error.message, /too many sends/);
  assert.equal((await balance(p, { ip: '203.0.113.9' })).status, 200);
});

test('everyone together has a rate, a daily allowance and a send rate', async () => {
  const p = await start({ ALL_RATE: 0.001, ALL_BURST: 3 });
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) assert.equal((await balance(p, { ip })).status, 200);
  const no = await balance(p, { ip: '192.0.2.4' });
  assert.equal(no.status, 429);
  assert.match(no.json.error.message, /plum's rpc is busy/);
  const q = await start({ ALL_DAILY: 2 });
  assert.equal((await balance(q, { ip: '192.0.2.5' })).status, 200);
  assert.equal((await balance(q, { ip: '192.0.2.6' })).status, 200);
  assert.equal((await balance(q, { ip: '192.0.2.7' })).status, 429);
  const s = await start({ ALL_SEND_RATE: 0.001, ALL_SEND_BURST: 1 });
  const sendFrom = (ip) => post(s, rpcCall('sendTransaction', ['AQIDBA==']), { ip });
  assert.equal((await sendFrom('192.0.2.8')).status, 200);
  assert.equal((await sendFrom('192.0.2.9')).status, 429);
});

test('only so many calls at a time, from one address and from everyone', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  answer = async (call) => { await held; return ok(call); };
  const p = await start({ IP_INFLIGHT: 2, ALL_INFLIGHT: 3 });
  const pending = [balance(p, { ip: '198.51.100.1' }), balance(p, { ip: '198.51.100.1' })];
  while (seen.length < 2) await sleep(5);
  const third = await balance(p, { ip: '198.51.100.1' });
  assert.equal(third.status, 429);
  assert.match(third.json.error.message, /at once from your address/);
  pending.push(balance(p, { ip: '198.51.100.2' }));
  while (seen.length < 3) await sleep(5);
  const fourth = await balance(p, { ip: '198.51.100.3' });
  assert.equal(fourth.status, 429);
  assert.match(fourth.json.error.message, /busy/);
  release();
  for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
  assert.equal((await balance(p, { ip: '198.51.100.1' })).status, 200, 'the slots come back');
});

test('each address has an allowance of bytes; a big answer is paid for afterwards', async () => {
  answer = (call) => ({ status: 200, body: { jsonrpc: '2.0', id: call.id, result: 'x'.repeat(5000) } });
  const p = await start({ IP_BYTES_RATE: 100, IP_BYTES_BURST: 1000 });
  assert.equal((await balance(p, { ip: '203.0.113.20' })).status, 200);
  const no = await balance(p, { ip: '203.0.113.20' });
  assert.equal(no.status, 429);
  assert.match(no.json.error.message, /too much downloaded/);
  assert.equal((await balance(p, { ip: '203.0.113.21' })).status, 200);
  clock += 50_000;
  assert.equal((await balance(p, { ip: '203.0.113.20' })).status, 200, 'the debt is waited out');
});

/* ------------------------------------------------------------ what the paid RPC says */

test("the chain's own errors come back as they are", async () => {
  const failed = { jsonrpc: '2.0', id: 7, error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { logs: ['Program log: x'], err: 'BlockhashNotFound' } } };
  answer = () => ({ status: 200, body: failed });
  const p = await start();
  const r = await post(p, { ...rpcCall('sendTransaction', ['AQIDBA==']), id: 7 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, failed);
  const bad = { jsonrpc: '2.0', id: 8, error: { code: -32602, message: 'Invalid param: WrongSize' } };
  answer = () => ({ status: 400, body: bad });
  const r2 = await post(p, { ...rpcCall('getBalance', [A]), id: 8 });
  assert.equal(r2.status, 400);
  assert.deepEqual(r2.json, bad);
});

test("the paid RPC's trouble comes back as plum's own error, never as its page", async () => {
  const p = await start();
  answer = () => ({ status: 429, body: 'slow down' });
  const busy = await balance(p);
  assert.equal(busy.status, 429);
  assert.match(busy.json.error.message, /busy/);
  answer = () => ({ status: 500, type: 'text/html', body: '<html>upstream exploded at node 12</html>' });
  const down = await balance(p);
  assert.equal(down.status, 502);
  assert.doesNotMatch(down.text, /exploded|html/);
  answer = () => ({ status: 401, body: { jsonrpc: '2.0', error: { code: -32401, message: 'invalid api key' } } });
  const key = await balance(p);
  assert.equal(key.status, 502);
  assert.doesNotMatch(key.text, /api key/);
  assert.ok(logged.some((l) => /refused its key \(401\)/.test(l)), 'the operator is told');
});

test('a slow paid RPC times out, and a gone one is an error', async () => {
  answer = async (call) => { await sleep(400); return ok(call); };
  const p = await start({ TIMEOUT_MS: 100 });
  const slow = await balance(p);
  assert.equal(slow.status, 504);
  const dead = makeProxy({ upstream: 'http://127.0.0.1:9/?api-key=' + KEY, env: {}, log, now });
  await new Promise((r) => dead.server.listen(0, '127.0.0.1', r));
  proxies.push(dead);
  const r = await raw(`http://127.0.0.1:${dead.server.address().port}/rpc`, { headers: { origin: EXT, 'content-type': 'application/json' }, body: JSON.stringify(rpcCall('getBalance', [A])) });
  assert.equal(r.status, 502);
});

test('a caller who hangs up stops the call to the paid RPC', async () => {
  let upstreamClosed = false;
  answer = (call, req, res) => new Promise((resolve) => {
    res.on('close', () => { upstreamClosed = true; resolve('done'); });
  });
  const p = await start();
  const ctl = new AbortController();
  const pending = raw(p.url, { headers: { origin: EXT, 'content-type': 'application/json' }, body: JSON.stringify(rpcCall('getBalance', [A])), signal: ctl.signal });
  while (!seen.length) await sleep(5);
  ctl.abort();
  await pending;
  for (let i = 0; i < 100 && !upstreamClosed; i++) await sleep(10);
  assert.ok(upstreamClosed);
});

/* ------------------------------------------------------------ the key never comes back out */

test("an answer holding the paid RPC's key is cut off, even split across chunks", async () => {
  const p = await start();
  answer = (call) => ({ status: 200, body: { jsonrpc: '2.0', id: call.id, result: `here it is: ${KEY}` } });
  const whole = await balance(p);
  assert.ok(!whole.text.includes(KEY));
  assert.ok(!whole.complete || whole.json === null);
  answer = (call, _req, res) => {
    const text = JSON.stringify({ jsonrpc: '2.0', id: call.id, result: `split ${KEY} end` });
    const at = text.indexOf(KEY) + 7;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(text.slice(0, at));
    setTimeout(() => res.end(text.slice(at)), 30);
    return 'done';
  };
  const split = await balance(p);
  assert.ok(!split.text.includes(KEY));
  assert.ok(logged.some((l) => /held the RPC's own key/.test(l)));
});

test("an error page holding the key isn't passed on, and the log never holds it", async () => {
  const p = await start();
  answer = () => ({ status: 400, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: `bad key ${KEY}` } } });
  const r = await balance(p);
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes(KEY));
  answer = () => ({ status: 503, type: 'text/plain', body: `upstream ${KEY} down` });
  assert.ok(!(await balance(p)).text.includes(KEY));
  for (const l of logged) assert.ok(!l.includes(KEY), l);
});

test('answers stop at MAX_ANSWER, and a cut-off answer still counts against the bytes allowed', async () => {
  answer = (call) => ({ status: 200, body: { jsonrpc: '2.0', id: call.id, result: 'y'.repeat(5000) } });
  const p = await start({ MAX_ANSWER: 1000, IP_BYTES_RATE: 1, IP_BYTES_BURST: 800 });
  const r = await balance(p, { ip: '203.0.113.30' });
  assert.ok(r.text.length <= 1000 + 64);
  assert.equal(r.json, null);
  const next = await balance(p, { ip: '203.0.113.30' });
  assert.equal(next.status, 429);
  assert.match(next.json.error.message, /too much downloaded/);
});

/* ------------------------------------------------------------ the parts */

test('addresses as the limits count them', () => {
  assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('2001:DB8:0:0:1::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('2001:db8:aa:bb:cc:dd:ee:ff'), '2001:db8:aa:bb::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey('64:ff9b::203.0.113.9'), '64:ff9b:0:0::/64');
  for (const junk of ['', 'nope', '1.2.3.4, 5.6.7.8', undefined, '999.1.1.1']) assert.equal(addressKey(junk), 'unknown');
});

test("Cloudflare's word for the address is taken only through the tunnel on this machine", () => {
  const req = (remoteAddress, ip) => ({ socket: { remoteAddress }, headers: ip ? { 'cf-connecting-ip': ip } : {} });
  assert.equal(clientOf(req('127.0.0.1', '198.51.100.4')), '198.51.100.4');
  assert.equal(clientOf(req('::1', '2001:db8:5:6::7')), '2001:db8:5:6::/64');
  assert.equal(clientOf(req('::ffff:127.0.0.1', '198.51.100.4')), '198.51.100.4');
  assert.equal(clientOf(req('203.0.113.50', '198.51.100.4')), '203.0.113.50', 'from anywhere else the header is anyone\'s say-so');
  assert.equal(clientOf(req('127.0.0.1')), '127.0.0.1');
});

test("the upstream URL is checked, and a bad one is reported without it", () => {
  assert.equal(upstreamOf(`https://mainnet.helius-rpc.com/?api-key=${KEY}`), `https://mainnet.helius-rpc.com/?api-key=${KEY}`);
  for (const bad of [`http://mainnet.helius-rpc.com/?api-key=${KEY}`, `https://user:${KEY}@rpc.example/`, `not a url ${KEY}`, '']) {
    assert.throws(() => upstreamOf(bad), (e) => !e.message.includes(KEY));
  }
  assert.throws(() => makeProxy({ env: {} }), /UPSTREAM_RPC is not set/);
  assert.deepEqual(secretsOf(`https://mainnet.helius-rpc.com/?api-key=${KEY}`).map(String), [KEY]);
  assert.deepEqual(secretsOf('https://x.solana-mainnet.quiknode.pro/0123456789abcdef0123/').map(String), ['0123456789abcdef0123']);
});

test('limits come from the environment by name', async () => {
  const p = makeProxy({ upstream: upUrl, env: { IP_RATE: '2', ALL_DAILY: '1000', MAX_BODY: 'lots', IP_BURST: '' }, log, now });
  assert.equal(p.limits.IP_RATE, 2);
  assert.equal(p.limits.ALL_DAILY, 1000);
  assert.equal(p.limits.MAX_BODY, 32 * 1024);
  assert.equal(p.limits.IP_BURST, 120);
  assert.equal(p.fingerprint.length, 10);
  await p.close();
});

test('token buckets refill, go into debt, and forget the longest idle past their size', () => {
  let t = 0;
  const b = new Buckets(2, 4, { max: 3, now: () => t });
  assert.equal(b.take('a', 4), 0);
  assert.equal(b.take('a'), 1);
  t += 500;
  assert.equal(b.take('a'), 0);
  b.spend('a', 10);
  assert.equal(b.take('a', 0), 5);
  b.take('b');
  b.take('c');
  b.take('d');
  assert.equal(b.size, 3);
  assert.equal(b.take('a', 4), 0, 'a was forgotten, so it starts full');
  t += 10_000;
  b.sweep();
  assert.equal(b.size, 0);
});

test('a call is read once and checked: id, method and params', () => {
  assert.deepEqual(readCall(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'getBlockHeight' })), { id: 'x', method: 'getBlockHeight', params: [] });
  assert.deepEqual(readCall(JSON.stringify({ jsonrpc: '2.0', method: 'getRecentPrioritizationFees', params: [[]] })), { id: null, method: 'getRecentPrioritizationFees', params: [[]] });
  assert.throws(() => readCall(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(65), method: 'getBlockHeight' })), /id/);
  assert.throws(() => readCall(JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'getBlockHeight' })), /id/);
});
