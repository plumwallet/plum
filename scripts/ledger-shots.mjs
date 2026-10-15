// Review screenshots of plum's Ledger screens, from the Chromium build. A headless browser has no Ledger to plug in, so
// each page of dist/chromium/ is served locally and opened with the background's answers scripted (and navigator.hid
// stood in for): the add-a-Ledger steps, the device in every state, the approval window and a send from a Ledger
// wallet, and the screen a browser without WebHID gets. Each screen is checked for one text size and nothing wider than
// its window, and saved as hw-*.png.
//   node build.mjs && node scripts/ledger-shots.mjs [--out <dir>] [--chrome <chrome.exe>]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { b64decode } from '../src/shared/bytes.js';
import { previewTx } from '../src/background/preview.js';
import { PK, fakeRpc, legacyB64, transferIx, walletAccount } from '../test/redteam/helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'chromium');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const OUT = resolve(arg('--out') ?? join(ROOT, 'shots'));
const CHROME = arg('--chrome') ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(join(DIST, 'manifest.json'))) { console.error('no dist/chromium/ yet: run npm run build first'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------ what the background answers */

const SOL = 'Dq3mFr1Lk3qBKXGxN6hoqPUuqA4YiU1qtkXbXyH8VbDo';
const ETH = '0x58A57ed9d8d624cBD12e2C467D34787555bB1b25';
const BTC = 'bc1qaqf9hpf0lrtwwjdx9zsgzvpu2hs72w8fyjx9ha';
const SOFT = { sol: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', eth: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', btc: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' };
const STATE = {
  version: '0.1.6', hasVault: true, unlocked: true, pending: 0,
  accounts: [
    { id: 'a1', kind: 'phrase', name: 'account 1', words: 12, backedUp: true, created: 1 },
    { id: 'l1', kind: 'ledger', name: 'ledger', words: null, backedUp: true, created: 2 },
  ],
  wallets: [
    { id: 'w1', account: 'a1', name: 'wallet 1', icon: 'ghost', scheme: 'bip44change', index: 0, chains: { sol: { address: SOFT.sol, path: "m/44'/501'/0'/0'" }, eth: { address: SOFT.eth, path: "m/44'/60'/0'/0/0" }, btc: { address: SOFT.btc, path: "m/84'/0'/0'/0/0" } } },
    { id: 'w2', account: 'l1', name: 'wallet 1', icon: 'robot', scheme: 'ledger', index: 0, layout: 'plum', chains: { sol: { address: SOL, path: "m/44'/501'/0'/0'" }, eth: { address: ETH, path: "m/44'/60'/0'/0/0" }, btc: { address: BTC, path: "m/84'/0'/0'/0/0" } } },
    { id: 'w3', account: 'l1', name: 'live 2', icon: 'cat', scheme: 'ledger', index: 1, layout: 'live', chains: { sol: { address: 'BmQHm8ZsZzAhtTdA7GFKhaM4HbKqvvYJpqAwi4pBG3eC', path: "m/44'/501'/1'" } } },
  ],
  active: 'w2',
  settings: { network: 'mainnet', rpc: { mainnet: '', devnet: '', testnet: '', localnet: '' }, ethRpc: '', autolockMin: 15, hideZero: true, jupiterKey: '', slippageBps: 100 },
  networks: { mainnet: { label: 'mainnet', url: "plum's built in rpc", custom: false, builtIn: true }, devnet: { label: 'devnet', url: 'https://api.devnet.solana.com', custom: false, builtIn: false } },
};
const native = (amount, decimals, symbol, name, price) => ({ amount, decimals, symbol, name, price, usd: (Number(amount) / 10 ** decimals) * price, change24h: 1.2 });
const BALANCES = {
  __by: 'chain',
  sol: { chain: 'sol', address: SOL, network: 'mainnet', hijacked: null, native: native('2450000000', 9, 'SOL', 'solana', 160), tokens: [] },
  eth: { chain: 'eth', address: ETH, native: native('120000000000000000', 18, 'ETH', 'ethereum', 2500), tokens: [] },
  btc: { chain: 'btc', address: BTC, pending: '0', native: native('80000', 8, 'BTC', 'bitcoin', 80000), tokens: [] },
};

// a real preview of a site's transfer, made by plum's own preview code over a stand-in RPC
const tx = b64decode(legacyB64(PK(SOL), [transferIx(PK(SOL), PK('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), 250_000_000)]));
const rpc = fakeRpc({ pre: { [SOL]: walletAccount(2_450_000_000) }, post: { [SOL]: walletAccount(2_199_995_000) } });
const PREVIEW = await previewTx(tx, { owner: SOL, rpc, meta: null });

const VIEW = {
  id: 'r1', kind: 'sign', chain: 'sol', origin: 'https://app.example.org', host: 'app.example.org', secure: true, connected: true, network: 'mainnet', risk: { level: null },
  queue: 1, siteQueue: 1, site: 'example.org', account: { name: 'wallet 1', icon: 'robot', address: SOL }, unlocked: true, txCount: 1,
  ledger: { app: 'Solana', note: 'after you approve it here, your Ledger shows the transaction: approve it there too.' },
};
const TYPED_VIEW = {
  ...VIEW, id: 'r2', kind: 'evmTyped', chain: 'eth', txCount: 0, account: { name: 'wallet 1', icon: 'robot', address: ETH },
  typed: { primaryType: 'Mail', domain: { name: 'Ether Mail', version: '1', chainId: '1', contract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' }, lines: [{ path: 'from.name', value: 'Cow' }, { path: 'to.name', value: 'Bob' }, { path: 'contents', value: 'Hello, Bob!' }], warnings: [] },
  ledger: { app: 'Ethereum', note: "your Ledger shows every field when its Ethereum app has raw messages (or blind signing) turned on in its settings; otherwise it shows the two hashes below. Check them against these.", hashes: { domain: '0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f', message: '0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e' } },
};
const SCAN = {
  id: 's1',
  rows: [
    { key: 'plum:0', layout: 'plum', index: 0, used: true, unknown: false, added: false, chains: { sol: { address: SOL, path: "m/44'/501'/0'/0'", used: true, amount: '2450000000' }, eth: { address: ETH, path: "m/44'/60'/0'/0/0", used: true, amount: '120000000000000000' }, btc: { address: BTC, path: "m/84'/0'/0'/0/0", used: false, amount: '0' } } },
    { key: 'plum:1', layout: 'plum', index: 1, used: false, unknown: false, added: false, chains: { sol: { address: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2', path: "m/44'/501'/1'/0'", used: false, amount: '0' }, eth: { address: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0', path: "m/44'/60'/0'/0/1", used: false, amount: '0' }, btc: { address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', path: "m/84'/0'/0'/0/1", used: false, amount: '0' } } },
    { key: 'plum:2', layout: 'plum', index: 2, used: false, unknown: false, added: false, chains: { sol: { address: 'GkzJnvYK4tFmsJ4vD5uSwJxt63xwi1n4GoU3kXQfEdAj', path: "m/44'/501'/2'/0'", used: false, amount: '0' }, eth: { address: '0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A', path: "m/44'/60'/0'/0/2", used: false, amount: '0' }, btc: { address: 'bc1qp59yckz4ae5c4efgw2s5wfyvrz0ala7rgvuz8z', path: "m/84'/0'/0'/0/2", used: false, amount: '0' } } },
    { key: 'live:1', layout: 'live', index: 1, used: true, unknown: false, added: false, chains: { sol: { address: 'BmQHm8ZsZzAhtTdA7GFKhaM4HbKqvvYJpqAwi4pBG3eC', path: "m/44'/501'/1'", used: true, amount: '310000000' }, eth: { address: '0x2b8A21A3a1e1D3B5ad7AD56aC4D2a6Fd9AB7e3a4', path: "m/44'/60'/1'/0/0", used: false, amount: '0' } } },
  ],
};
const PREP = { id: 'p1', chain: 'sol', preview: PREVIEW, warnings: [{ level: 'info', text: "you haven't sent to this address from plum before" }], to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: '0.25', symbol: 'SOL', mint: null, network: 'mainnet' };

/** In the page, before its scripts: the extension API and WebHID, answering from window.__answers. */
function standIn({ answers, hid }) {
  window.__answers = answers;
  window.__deferred = {};
  window.__calls = [];
  const reply = (method, params) => {
    window.__calls.push(method);
    const a = window.__answers[method];
    if (a === undefined) return { ok: false, error: `no scripted answer for ${method}`, code: null };
    if (a && a.__defer) return new Promise((resolve) => { window.__deferred[a.__defer] = resolve; });
    if (a && a.__error) return { ok: false, error: a.__error, code: a.__code ?? null };
    if (a && a.__by) return { ok: true, result: a[params?.[a.__by]] };
    return { ok: true, result: a };
  };
  window.browser = {
    runtime: { id: 'plum-shots', getURL: (p) => `/${p}`, sendMessage: async (m) => reply(m.method, m.params) },
    windows: { create: async () => ({ id: 1 }), getCurrent: async () => ({ id: 1 }) },
  };
  Object.defineProperty(Navigator.prototype, 'hid', { configurable: true, get: () => (hid ? { getDevices: async () => [{ vendorId: 0x2c97 }], requestDevice: async () => [{ vendorId: 0x2c97 }], addEventListener() {} } : undefined) });
}

/* ------------------------------------------------------------ a local server for dist/chromium */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.otf': 'font/otf', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = normalize(join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(DIST) || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------ the browser */

const CAP_60FPS = () => {
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const step = 1000 / 60, pending = new Map();
  let nextId = 1, next = 0, last = -1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    const tick = (t) => {
      if (t !== last) {
        if (t < next - 2) { pending.set(id, raf(tick)); return; }
        next = t - next > step ? t + step : next + step;
        last = t;
      }
      pending.delete(id);
      cb(t);
    };
    pending.set(id, raf(tick));
    return id;
  };
  window.cancelAnimationFrame = (id) => { caf(pending.get(id)); pending.delete(id); };
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, args: ['--screen-info={0,0 1280x800}'] });
try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
const taken = [];
let failures = 0;

async function open(path, { width = 380, height = 600, answers = {}, hid = true } = {}) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(CAP_60FPS);
  await p.evaluateOnNewDocument(standIn, { answers: { state: STATE, balances: BALANCES, ping: true, 'ledger.status': { state: 'idle' }, ...answers }, hid });
  await p.setViewport({ width, height, deviceScaleFactor: 1 });
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  // (the browser asks the local server for a favicon the extension never has)
  p.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) p.errors.push(`${r.status()} for ${r.url().replace(BASE, '')}`); });
  opened.push(p);
  await p.goto(`${BASE}/${path}`, { waitUntil: 'load' });
  await p.waitForSelector('#app > :not(.boot)', { timeout: 15_000 });
  await p.bringToFront();
  return p;
}
const set = (p, answers) => p.evaluate((a) => Object.assign(window.__answers, a), answers);
const settle = (p, name, value) => p.evaluate((n, v) => window.__deferred[n]?.(v), name, value);
const textOf = (p) => p.evaluate(() => document.body.innerText);
async function waitText(p, re, timeout = 10_000) {
  // (titles are upper case on screen, and innerText says them that way)
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (re.test(await textOf(p))) return; await sleep(100); }
  throw new Error(`no ${re} on the page: ${(await textOf(p)).slice(0, 300)}`);
}
const click = (p, text, tag = 'button') => p.locator(`${tag}::-p-text(${text})`).setTimeout(10_000).click();

/** One screen: saved, then checked (one text size, nothing sideways, no page errors). */
async function shot(p, name) {
  await sleep(450);
  // from the top, so the head (which stays on top while a screen scrolls) is drawn where it belongs
  await p.evaluate(() => window.scrollTo(0, 0));
  await sleep(100);
  const h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  const w = await p.evaluate(() => Math.ceil(document.documentElement.clientWidth));
  const file = join(OUT, `hw-${name}.png`);
  await p.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: Math.min(h, 2400) }, captureBeyondViewport: true });
  taken.push(file);
  const sizes = await p.evaluate(() => {
    const ART = '.icon-art, .hero .logo-art';
    const seen = new Map();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest(ART) || !el.checkVisibility()) continue;
      const s = getComputedStyle(el).fontSize;
      if (!seen.has(s)) seen.set(s, n.textContent.trim().slice(0, 40));
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest(ART) || !el.checkVisibility()) continue;
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content && !['none', 'normal', '""'].includes(cs.content) && !seen.has(cs.fontSize)) seen.set(cs.fontSize, `${el.className}${pseudo}`);
      }
    }
    return [...seen];
  });
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const problems = [];
  if (sizes.length !== 1 || sizes[0][0] !== '12.5px') problems.push(`text sizes: ${sizes.map(([s, t]) => `${s} (${t})`).join(', ')}`);
  if (over > 1) problems.push(`${over}px wider than the window`);
  if (p.errors.length) problems.push(...p.errors.map((e) => `page error: ${e}`));
  if (problems.length) { failures++; console.log(`FAIL  hw-${name}.png\n        ${problems.join('\n        ')}`); } else console.log(`ok    hw-${name}.png`);
}

const opened = [];
async function scene(name, fn) {
  try { await fn(); } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e.message.split('\n')[0]}`);
    for (const p of opened.splice(0)) {
      for (const err of p.errors) console.log(`        page error: ${err}`);
      await p.screenshot({ path: join(OUT, `hw-fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
      await p.close().catch(() => {});
    }
  }
  opened.length = 0;
}

try {
  await scene('accounts', async () => {
    const p = await open('popup.html');
    await click(p, 'wallet 1');
    await waitText(p, /connect a ledger/);
    await shot(p, 'accounts');
    // a Ledger wallet's tools: its addresses (checked on the device), no keys to show
    await p.evaluate(() => [...document.querySelectorAll('.acct-row')].find((r) => r.textContent.includes('Dq3m'))?.querySelector('.mini')?.click());
    await waitText(p, /keys stay on your Ledger/);
    await shot(p, 'wallet-tools');
    await p.evaluate(() => [...document.querySelectorAll('.acct-box')].find((b) => /ledger/i.test(b.querySelector('h3')?.textContent ?? ''))?.querySelector('.head-side .mini')?.click());
    await waitText(p, /recovery phrase is on your Ledger/);
    await shot(p, 'account-tools');
    await p.close();
  });

  await scene('receive', async () => {
    const p = await open('popup.html', { answers: { 'ledger.show': { __defer: 'show' } } });
    await click(p, 'receive');
    await waitText(p, /check it on your ledger/);
    await shot(p, 'receive');
    await set(p, { 'ledger.status': { state: 'confirm', app: 'Solana', message: 'check that your Ledger shows this same address, then confirm it there' } });
    await click(p, 'check it on your ledger');
    await waitText(p, /same address/);
    await shot(p, 'receive-check');
    await settle(p, 'show', { ok: true, result: true });
    await waitText(p, /showed this same address/);
    await shot(p, 'receive-checked');
    await p.close();
  });

  await scene('send', async () => {
    const p = await open('popup.html', { answers: { 'send.prepare': PREP, 'send.submit': { __defer: 'submit' } } });
    await click(p, 'send');
    await p.waitForSelector('input.input');
    const inputs = await p.$$('input.input');
    await inputs[0].type(PREP.to);
    await inputs[1].type('0.25');
    await click(p, 'review');
    await waitText(p, /approve it there after this/);
    await shot(p, 'send-review');
    await set(p, { 'ledger.status': { state: 'confirm', app: 'Solana', message: 'check the transaction on your Ledger, then approve it there. If it can only show a message hash (blind signing), that hash must be 3Lm8XgVa..zP5Tu1Kc' } });
    await click(p, 'send it');
    await waitText(p, /blind signing/);
    await shot(p, 'send-confirm');
    await p.close();
  });

  await scene('add a ledger', async () => {
    const p = await open('popup.html?window=1&ledger=new', { width: 420, height: 680, answers: { 'ledger.scan': { __defer: 'scan' }, 'ledger.add': STATE } });
    await waitText(p, /plug in your Ledger/);
    await shot(p, 'connect');
    await set(p, { 'ledger.status': { state: 'connect', app: null, message: 'plug in your Ledger and unlock it' } });
    await click(p, 'read my ledger');
    await waitText(p, /let plum use it/);
    await shot(p, 'connect-unplugged');
    await set(p, { 'ledger.status': { state: 'locked', app: 'Solana', message: 'your Ledger is locked: type its PIN on it' } });
    await waitText(p, /type its PIN/);
    await shot(p, 'connect-locked');
    await set(p, { 'ledger.status': { state: 'open-app', app: 'Ethereum', message: 'plum asked your Ledger to open Ethereum: confirm it there if it asks' } });
    await waitText(p, /open Ethereum/);
    await shot(p, 'connect-open-app');
    await set(p, { 'ledger.status': { state: 'wrong-app', app: 'Bitcoin', message: 'your Ledger has Ethereum open: plum is closing it to open Bitcoin' } });
    await waitText(p, /closing it/);
    await shot(p, 'connect-switch-app');
    await settle(p, 'scan', { ok: true, result: SCAN });
    await waitText(p, /its wallets/);
    await shot(p, 'pick');
    await p.close();
  });

  await scene('no webhid', async () => {
    const p = await open('popup.html', { hid: false });
    await click(p, 'wallet 1');
    await waitText(p, /chrome, brave, edge/);
    await click(p, '+ connect a ledger');
    await waitText(p, /no WebHID/);
    await shot(p, 'no-webhid');
    await p.close();
  });

  await scene('approval', async () => {
    const p = await open('approve.html', { width: 400, height: 660, answers: { 'approval.get': VIEW, 'approval.preview': [PREVIEW], 'approval.resolve': { __defer: 'resolve' } } });
    await waitText(p, /signed on your ledger/);
    await shot(p, 'approve-sol');
    await set(p, { 'ledger.status': { state: 'confirm', app: 'Solana', message: 'check the transaction on your Ledger, then approve it there. If it can only show a message hash (blind signing), that hash must be 3Lm8XgVa..zP5Tu1Kc' } });
    await sleep(1300);
    await p.locator('.answer .btn-go').setTimeout(10_000).click();
    await waitText(p, /approve it there\. If/);
    await shot(p, 'approve-confirm');
    await settle(p, 'resolve', { ok: false, error: 'you turned it down on your Ledger', code: 'ledger-rejected' });
    await waitText(p, /turned it down/);
    await shot(p, 'approve-rejected');
    await p.close();
  });

  for (const [name, state, message] of [
    ['approve-blind', 'blind-sign', "your Ledger's Solana app needs blind signing to sign this: turn it on in the app's settings, then try again"],
    ['approve-mismatch', 'mismatch', "this isn't the Ledger this wallet is on (it holds a different recovery phrase, or a passphrase): plug in the right one"],
    ['approve-old-app', 'old-app', 'the Solana app on your Ledger is too old for this: update it with Ledger Live (My Ledger)'],
  ]) {
    await scene(name, async () => {
      const p = await open('approve.html', { width: 400, height: 660, answers: { 'approval.get': VIEW, 'approval.preview': [PREVIEW], 'approval.resolve': { __error: message, __code: `ledger-${state}` } } });
      await waitText(p, /signed on your ledger/);
      await sleep(1300);
      await p.locator('.answer .btn-go').setTimeout(10_000).click();
      await waitText(p, new RegExp(message.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await shot(p, name);
      await p.close();
    });
  }

  await scene('typed data', async () => {
    const p = await open('approve.html', { width: 400, height: 660, answers: { 'approval.get': TYPED_VIEW } });
    await waitText(p, /domain hash/);
    await shot(p, 'approve-typed');
    await p.close();
  });
} finally {
  await browser.close().catch(() => {});
  server.closeAllConnections();
  server.close();
}
console.log(`\n${taken.length} screenshots in ${OUT}${failures ? `, ${failures} failed` : ''}`);
assert.ok(taken.length);
process.exit(failures ? 1 : 0);
