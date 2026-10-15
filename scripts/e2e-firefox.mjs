// plum in real Firefox, end to end: Firefox Developer Edition, headless, in a throwaway profile (your own profile is
// never touched), with dist/firefox/ installed as a temporary add-on. It goes through every screen the way you would and
// saves each to shots/ (f-<nn>-<name>.png, the same numbers as the Chrome run's c-<nn>): the window plum opens on
// install, the welcome in the popup, a new wallet made right there (icon, name, 24 words, password, the phrase, done),
// home on three chains, accounts (a new wallet, a new account, an account brought from a phrase with its wallets found,
// a private key), receive on each chain, send, history, settings, locking. Then a test dApp on localhost finds plum
// through the Wallet Standard and EIP-6963, and asks for Solana and Ethereum connections, messages, typed data and a
// transaction, each in plum's approval window. Every screen is checked for one text size and for nothing sticking out
// sideways. scripts/e2e-chromium.mjs is the same journey in Chrome.
//   node build.mjs && node scripts/e2e-firefox.mjs [--firefox "C:\path\to\firefox.exe"] [--headful]
// Nothing is ever sent to a chain: transactions are rejected, only signatures are approved (and checked here).
// Mainnet is read (balances, the phrase scan, simulations).
//
// What Firefox does differently for automation, and how this run gets round it:
//   - extension pages are privileged, so automation can't load one (goto), resize it, bring its window forward or add a
//     script to it before it loads. plum's own pages open each other instead (browser.windows.create from a plum page),
//     the popup is a 380 x 600 popup window of its own (the toolbar popup's size), "opening the popup again" is the page
//     loading itself again, and plum's windows ask for focus themselves (as its "open it" button does).
//   - automation sees an extension page's address as about:blank, so pages are told apart by asking each its
//     location.href.
//   - the 60 fps cap goes into each plum page the moment it's found (it can't go in before), and the layout.frame_rate
//     pref caps every page, plum's included, from the start.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { recoverMessageAddress, recoverTypedDataAddress } from 'viem';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'firefox');
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const FIREFOX = arg('--firefox') ?? 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe';
const HEADLESS = !process.argv.includes('--headful');
// plum's address inside Firefox is moz-extension://<a uuid Firefox picks>/; this profile pins it so the run knows it
const UUID = '8b1f6c2e-5d3a-4c7e-9f10-000000000001';
const EXT = `moz-extension://${UUID}/`;
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'plum e2e password';
const ETH_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'; // a well-known throwaway test key
const POPUP = { width: 380, height: 600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('>', ...a);

if (!existsSync(join(DIST, 'manifest.json'))) { console.error('no dist/firefox/ yet: run npm run build first'); process.exit(1); }

// steady 60 fps for anything animating (from the house rules for automated browsers)
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

/* ------------------------------------------------------------ a test dApp: the Wallet Standard and EIP-6963 */
const DAPP = `<!doctype html><meta charset="utf-8"><title>plum test dapp</title><link rel="icon" href="data:,"><body style="background:#fff;font:14px sans-serif"><h1>test dapp</h1><script>
const wallets = [];
const api = { register: (...ws) => { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); return () => {}; }, get: () => wallets, on: () => () => {} };
window.addEventListener('wallet-standard:register-wallet', (e) => e.detail(api));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
const providers = [];
window.addEventListener('eip6963:announceProvider', (e) => providers.push(e.detail));
window.dispatchEvent(new Event('eip6963:requestProvider'));
const plum = () => wallets.find((w) => w.name === 'Plum');
const eth = () => providers.find((p) => p.info.name === 'Plum').provider;
const run = async (f) => { try { return { ok: await f() }; } catch (e) { return { err: e.message, code: e.code }; } };
const changes = [];
window.dapp = {
  names: () => wallets.map((w) => w.name),
  features: () => Object.keys(plum().features),
  providers: () => providers.map((p) => p.info),
  sol: (silent) => run(async () => (await plum().features['standard:connect'].connect({ silent })).accounts.map((a) => a.address)),
  ethConnect: () => run(() => eth().request({ method: 'eth_requestAccounts' })),
  ethWatch: () => eth().on('accountsChanged', (a) => changes.push(a)),
  ethChanges: () => changes,
  ethCall: (method, params) => run(() => eth().request({ method, params })),
};
</script>`;
const server = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DAPP);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const DAPP_URL = `http://localhost:${server.address().port}/`;

let browser = null;
let failures = 0;
/** Errors thrown on plum's pages or the dApp's (each: where, what), reported with the step they happened in. */
const pageErrors = [];
async function step(name, fn) {
  const before = pageErrors.length;
  try { await fn(); log('ok  ', name); } catch (e) {
    failures++;
    log('FAIL', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      '));
    let n = 0;
    for (const p of await browser.pages()) {
      const href = await hrefOf(p);
      const text = await Promise.race([p.evaluate(() => document.body?.innerText ?? ''), sleep(5000).then(() => '')]).catch(() => '');
      console.log(`      tab ${n}: ${href}\n        ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
      await p.screenshot({ path: join(SHOTS, `fail-f${failures}-${n++}.png`) }).catch(() => {});
    }
  }
  await collectErrors();
  for (const [where, what] of pageErrors.slice(before)) log('     page error', `(${where}):`, what);
}
/** The dApp's page: the tab Firefox opened with, in its normal window. (A new page would open in whichever window was
 * used last, which can be plum's popup window: the popup's tab would then be hidden behind it, and stop drawing.) */
async function dappPage(p, viewport) {
  await p.evaluateOnNewDocument(CAP_60FPS);
  await p.setViewport({ ...(viewport ?? { width: 1280, height: 720 }), deviceScaleFactor: 1 });
  p.on('pageerror', (e) => pageErrors.push(['dapp', e.message]));
  p.on('console', (m) => { if (m.type() === 'error') pageErrors.push(['dapp console', m.text()]); });
  return p;
}
/** A page's address, as it says it (Firefox shows automation about:blank for extension pages). */
const hrefOf = (p) => Promise.race([p.evaluate(() => location.href), sleep(5000).then(() => '?')]).catch(() => '?');
/** A tab or window by what it shows. */
async function findPage(test, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const p of await browser.pages()) if (test(await hrefOf(p))) return p;
    await sleep(250);
  }
  throw new Error('no such tab');
}
/** Firefox won't add a script to an extension page before it loads (privileged pages refuse it), so plum's own pages
 * get the 60 fps cap the moment they're found, once per document; from then on any error they throw is noted too. */
async function capLate(p) {
  const fresh = await p.evaluate(() => !window.__e2e).catch(() => false);
  if (!fresh) return;
  await p.evaluate(CAP_60FPS).catch(() => {});
  await p.evaluate(() => {
    window.__e2e = { errors: [] };
    const note = (what) => window.__e2e.errors.push(String(what).slice(0, 300));
    addEventListener('error', (e) => note(e.message));
    addEventListener('unhandledrejection', (e) => note(e.reason?.message ?? e.reason));
    const ce = console.error.bind(console);
    console.error = (...a) => { note(a.map(String).join(' ')); ce(...a); };
  }).catch(() => {});
}
/** What plum's open pages noted since they were last asked. */
async function collectErrors() {
  for (const p of await browser.pages().catch(() => [])) {
    const got = await Promise.race([p.evaluate(() => {
      if (!window.__e2e) return null;
      const out = window.__e2e.errors.splice(0);
      return [location.pathname + location.search, out];
    }), sleep(3000).then(() => null)]).catch(() => null);
    if (got) for (const what of got[1]) pageErrors.push([got[0], what]);
  }
}
/** One of plum's pages, booted (a fresh document after it loaded itself again), and capped. */
async function booted(p, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await p.evaluate(() => !window.__plumLeft && !!document.querySelector('#app > :not(.boot)')).catch(() => false)) { await capLate(p); return p; }
    await sleep(100);
  }
  throw new Error(`plum's page didn't start: ${await hrefOf(p)}`);
}
/** One of plum's pages, opened by another (Firefox won't let automation open an extension page): in a popup window of
 * its own, its inside exactly `size` (the window's frame added, if it has one). */
async function openExt(from, path, size) {
  await from.evaluate((url, s) => browser.windows.create({ url, type: 'popup', ...s }).then(() => true), path, size);
  const p = await booted(await findPage((href) => href === EXT + path));
  await p.evaluate(async (s) => {
    const w = await browser.windows.getCurrent();
    if (innerWidth !== s.width || innerHeight !== s.height) await browser.windows.update(w.id, { width: w.width + s.width - innerWidth, height: w.height + s.height - innerHeight });
    return true;
  }, size);
  await sleep(300);
  return p;
}
/** The whole page, as tall as it is (up to 2400px), at the window's width. */
const shot = async (p, name) => {
  await sleep(250);
  const h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  const w = await p.evaluate(() => Math.ceil(document.documentElement.scrollWidth));
  await p.screenshot({ path: join(SHOTS, `f-${name}.png`), clip: { x: 0, y: 0, width: Math.min(w, 1280), height: Math.min(h, 2400) }, captureBeyondViewport: true });
};
/** A call into the dApp page that's still waiting while plum's window is answered: if the run stops meanwhile, its
 * failure is kept as the answer instead of crashing the script. */
const pendingCall = (p, fn, ...args) => p.evaluate(fn, ...args).catch((e) => ({ err: e.message }));
const click = async (p, text, tag = 'button') => { await p.locator(`${tag}::-p-text(${text})`).setTimeout(20_000).click(); };
const textOf = (p) => p.evaluate(() => document.body.innerText);
async function waitText(p, re, timeout = 25_000) {
  // box titles are uppercased by CSS, and innerText reads what's on screen
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (re.test(await textOf(p).catch(() => ''))) return; await sleep(200); }
  throw new Error(`timed out waiting for ${re} in:\n${(await textOf(p).catch(() => '')).slice(0, 500)}`);
}
/** Every character on the screen is the same size. Only pictures drawn in characters keep their own: the wallets'
 * icons, and the logo when the popup shrinks it to fit. */
async function oneSize(p, where) {
  const sizes = await p.evaluate(() => {
    const ART = '.icon-art, .hero .logo-art';
    const seen = new Map();
    const note = (size, what) => { if (!seen.has(size)) seen.set(size, what); };
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest(ART) || !el.checkVisibility()) continue;
      note(getComputedStyle(el).fontSize, n.textContent.trim().slice(0, 40));
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest(ART) || !el.checkVisibility()) continue;
      if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) note(getComputedStyle(el).fontSize, `<${el.tagName.toLowerCase()}> ${el.placeholder}`);
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content && !['none', 'normal', '""'].includes(cs.content)) note(cs.fontSize, `${el.className}${pseudo} ${cs.content}`);
      }
    }
    return [...seen];
  });
  assert.deepEqual(sizes.map(([s]) => s), ['12.5px'], `${where}: every character the same size, but found ${sizes.map(([s, w]) => `${s} (${w})`).join(', ')}`);
}
/** Nothing sticks out sideways (no horizontal scroll in the popup). */
async function fits(p, where) {
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `${where}: ${over}px wider than the popup`);
}
const check = async (p, name) => { await shot(p, name); await oneSize(p, name); await fits(p, name); };

/** The approval window showing a request that matches `re` (the window from the last request may still be closing, or
 * may have stayed open for this one). */
async function approvalPage(re) {
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    for (const p of await browser.pages()) {
      const text = await Promise.race([p.evaluate(() => (location.pathname === '/approve.html' && document.querySelector('main.approve') ? document.body.innerText : '')), sleep(5000).then(() => '')]).catch(() => '');
      if (re.test(text)) { await capLate(p); return p; }
    }
    await sleep(250);
  }
  throw new Error(`no approval window showed ${re}`);
}
/** Approve (or reject) what the approval window shows, once its button has armed. Automation can't bring a privileged
 * window forward in Firefox, so the window asks for focus itself. */
async function answer(ap, yes, { ack = false } = {}) {
  await ap.evaluate(async () => { const w = await browser.windows.getCurrent(); await browser.windows.update(w.id, { focused: true }); return true; }).catch(() => {});
  await sleep(1300);
  if (ack) { const a = await ap.$('.ack-row:not([hidden]) .toggle'); if (a) await a.click(); }
  if (yes) await ap.locator('.answer .btn-go').setTimeout(20_000).click();
  else await click(ap, 'reject').catch(() => click(ap, 'cancel'));
}

try {
  browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: HEADLESS,
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    protocolTimeout: 120_000,
    // lets the run reach plum's own pages (extension pages are privileged); only in this throwaway profile
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ 'plum-wallet@plum.fun': UUID }),
      'browser.shell.checkDefaultBrowser': false,
      // every page at 60 fps at most, plum's own included (the in-page cap can only reach those once they've loaded)
      'layout.frame_rate': 60,
    },
  });
  try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  const [blank] = await browser.pages();
  const id = await browser.installExtension(DIST);
  log(`plum in ${await browser.version()}, extension ${id}`);
  // the window plum opens on install: its first page, and the only way in (automation can't open an extension page)
  const welcomeWin = await findPage((href) => href === `${EXT}popup.html?window=1`).catch(() => null);
  if (!welcomeWin) throw new Error('installing plum opened no welcome window (and Firefox gives automation no other way into plum)');
  await booted(welcomeWin);
  // the popup: plum's popup page in a window of the toolbar popup's size, opened by that window
  const popup = await openExt(welcomeWin, 'popup.html', POPUP);
  /** The popup opened afresh, as a click on plum's button opens it (here: the page loads itself again). */
  const open = async () => {
    await popup.evaluate(() => { window.__plumLeft = true; location.replace('popup.html'); }).catch(() => {});
    await booted(popup);
    // a hidden page draws nothing (and nothing on it can be clicked): the popup must be its window's one tab
    assert.equal(await popup.evaluate(() => document.visibilityState), 'visible', 'the popup is showing');
  };

  await step('the welcome, in the popup (and the window plum opens on install)', async () => {
    await waitText(welcomeWin, /new here/);
    assert.equal(await welcomeWin.evaluate(async () => (await browser.windows.getCurrent()).type), 'popup', 'a little window of its own, not a tab');
    await check(welcomeWin, '00-welcome-window');
    await welcomeWin.close().catch(() => {});
    await open();
    await waitText(popup, /new here/);
    assert.deepEqual(await popup.evaluate(() => [innerWidth, innerHeight]), [POPUP.width, POPUP.height], 'the popup is 380 x 600');
    await check(popup, '01-welcome');
  });

  await step('a new wallet, right in the popup: icon, name, 24 words, password, phrase, done', async () => {
    await click(popup, 'create a new wallet');
    await waitText(popup, /create a wallet/);
    await waitText(popup, /step 1 of 2/);
    assert.equal(await popup.evaluate(() => location.pathname), '/popup.html', 'still the popup: no tab of its own');
    // nothing is focused for you, and the password is no password field Firefox's password manager would take over (no
    // "use a generated password" over it): plain text drawn as *s
    assert.equal(await popup.evaluate(() => document.activeElement?.tagName), 'BODY', 'nothing focused');
    assert.equal((await popup.$$('input[type=password]')).length, 0, 'no password field');
    const security = () => popup.$eval('.secret-field input', (el) => getComputedStyle(el).getPropertyValue('-webkit-text-security'));
    assert.equal(await security(), 'disc');
    await check(popup, '02-create');
    await popup.locator('button.face-square').click();
    await sleep(700);
    await check(popup, '03-create-icons');
    await popup.locator('button.face-pick[title="whale"]').click();
    await sleep(600);
    await popup.type('input[placeholder="a name (optional)"]', 'main');
    await click(popup, '24 words');
    await popup.type('.secret-field input', PASSWORD);
    // [ show ] reveals what's typed and hides it again; caps lock on puts a line under the field
    await popup.locator('.secret-field button::-p-text(show)').click();
    assert.equal(await security(), 'none', '[ show ] shows the password');
    await popup.locator('.secret-field button::-p-text(hide)').click();
    assert.equal(await security(), 'disc', '[ hide ] hides it again');
    await popup.$eval('.secret-field input', (el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'A', modifierCapsLock: true, bubbles: true })));
    assert.equal(await popup.$eval('.caps-on', (el) => el.hidden), false, 'caps lock is on, said under the field');
    await popup.$eval('.secret-field input', (el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true })));
    assert.equal(await popup.$eval('.caps-on', (el) => el.hidden), true);
    await check(popup, '04-create-filled');
    await click(popup, 'next ->');
    await waitText(popup, /your recovery phrase/, 40_000);
    await check(popup, '05-phrase-hidden');
    await click(popup, 'show the words');
    const words = await popup.$$eval('.words b', (bs) => bs.map((b) => b.textContent));
    assert.equal(words.length, 24);
    await check(popup, '06-phrase-shown');
    assert.equal(await popup.$eval('.btn-go', (b) => b.disabled), true, 'done waits for "i wrote them down"');
    // the popup closing here loses nothing: the wallet is already sealed, and home reminds you
    await open();
    await waitText(popup, /isn't backed up yet/);
    await check(popup, '07-home-reminder');
    await click(popup, 'back it up');
    await popup.type('.secret-field input', PASSWORD);
    await click(popup, 'show the words ->');
    await click(popup, 'show the words');
    assert.deepEqual(await popup.$$eval('.words b', (bs) => bs.map((b) => b.textContent)), words, 'the same words');
    await click(popup, 'i wrote them down');
    await click(popup, 'done ->');
    await waitText(popup, /accounts/);
  });

  await step('home on three chains: the head, the card, SOL ETH BTC, tokens', async () => {
    await open();
    await waitText(popup, /tokens/);
    await waitText(popup, /\$\d/, 60_000).catch(() => {});
    await sleep(1500);
    // every chain answered: a ? in a coin's line means one could not be read (for example, no working Solana RPC)
    for (let i = 0; i < 120 && await popup.evaluate(() => !!document.querySelector('.sol-box .spin')); i++) await sleep(500);
    assert.doesNotMatch(await popup.$eval('.sol-box', (el) => el.innerText), /\?/, 'every chain answered');
    await check(popup, '08-home');
    assert.deepEqual(await popup.$$eval('.top .copy-chip', (b) => b.map((x) => x.textContent)), ['sol', 'eth', 'btc']);
    assert.equal(await popup.$eval('.top .acct b', (b) => b.textContent), 'main');
    assert.equal(await popup.$eval('.top .who-acct', (b) => b.textContent), 'account 1');
    assert.deepEqual(await popup.$$eval('.sol-box .tk .tk-n b', (b) => b.map((x) => x.textContent)), ['SOL', 'ETH', 'BTC']);
    assert.doesNotMatch(await textOf(popup), /\bnull\b|undefined|NaN/, 'no stray null, undefined or NaN on screen');
    const cursors = await popup.evaluate(() => ['.top .acct', '.top .copy-chip', '.top .tab-btn'].map((s) => getComputedStyle(document.querySelector(s)).cursor));
    assert.deepEqual(cursors, ['default', 'pointer', 'default'], 'a hand only over what copies');
  });

  await step('accounts: "+ new wallet", a wallet\'s tools, an account\'s tools', async () => {
    await popup.locator('button.acct').click();
    await waitText(popup, /\+ new wallet/);
    await check(popup, '09-accounts');
    await click(popup, '+ new wallet');
    await waitText(popup, /wallet 2/);
    await check(popup, '10-accounts-two-wallets');
    await popup.locator('button[title="manage this wallet"]').click();
    await waitText(popup, /rename/);
    await check(popup, '11-wallet-tools');
    await popup.locator('button[title="manage this account"]').click();
    await waitText(popup, /remove this account/);
    await check(popup, '12-account-tools');
  });

  await step('+ new account: a second recovery phrase, 12 words', async () => {
    await open();
    await popup.locator('button.acct').click();
    await click(popup, '+ new account');
    await waitText(popup, /new account/);
    await waitText(popup, /account name/);
    await check(popup, '13-new-account');
    await popup.type('input[placeholder="a name (optional)"]', 'savings');
    await click(popup, 'next ->');
    await waitText(popup, /recovery phrase/, 40_000);
    await click(popup, 'show the words');
    assert.equal((await popup.$$('.words b')).length, 12);
    await click(popup, 'i wrote them down');
    await click(popup, 'done ->');
    await waitText(popup, /savings/);
    await check(popup, '14-accounts-two');
  });

  await step('+ import an account: the "abandon" phrase, its used wallets found on every chain', async () => {
    await click(popup, '+ import an account');
    await waitText(popup, /import an account/);
    await popup.type('textarea', ABANDON);
    await check(popup, '15-import-phrase');
    await click(popup, 'next ->');
    await waitText(popup, /its wallets/, 300_000);
    await check(popup, '16-import-pick');
    await popup.type('input[placeholder="a name (optional)"]', 'abandon');
    await click(popup, 'import ->');
    await waitText(popup, /tokens/, 30_000);
    assert.equal(await popup.$eval('.top .who-acct', (b) => b.textContent), 'abandon');
    await sleep(4000);
    await check(popup, '17-home-imported');
  });

  await step('+ import a private key: an Ethereum key, told apart by its shape', async () => {
    await popup.locator('button.acct').click();
    await click(popup, '+ import a private key');
    await popup.type('.secret-field input', ETH_KEY);
    await click(popup, 'next ->');
    await waitText(popup, /ethereum/);
    await check(popup, '18-import-key');
    await click(popup, 'import ->');
    await waitText(popup, /tokens/);
    await popup.locator('button.acct').click();
    await waitText(popup, /imported keys/);
    await check(popup, '19-accounts-all');
  });

  await step('receive on each chain, send, history, settings', async () => {
    // back to the abandon wallet (it has history on every chain)
    await popup.locator('.acct-row .pick::-p-text(wallet 1)').setTimeout(10_000).click().catch(() => {});
    await open();
    const abandon = await popup.evaluate(() => document.querySelector('.top .who-acct')?.textContent);
    if (abandon !== 'abandon') {
      await popup.locator('button.acct').click();
      const rows = await popup.$$('.acct-box');
      for (const r of rows) {
        if ((await r.evaluate((el) => el.querySelector('h3')?.textContent)) === 'abandon') { await (await r.$('.acct-row .pick')).click(); break; }
      }
      await waitText(popup, /tokens/);
    }
    await click(popup, 'receive');
    await waitText(popup, /copy address/);
    await check(popup, '20-receive-sol');
    await click(popup, 'ethereum');
    await waitText(popup, /0x98/);
    await check(popup, '21-receive-eth');
    await click(popup, 'bitcoin');
    await waitText(popup, /bc1q/);
    await check(popup, '22-receive-btc');
    await click(popup, 'back');
    await click(popup, 'send');
    await waitText(popup, /review/, 30_000);
    await check(popup, '23-send');
    await popup.locator('.tok-btn').click();
    await waitText(popup, /pick a token/);
    await check(popup, '24-send-pick');
    await popup.locator('.tk::-p-text(BTC)').click();
    await waitText(popup, /speed/);
    assert.match(await popup.$eval('.field input:not(.masked)', (el) => el.placeholder), /Bitcoin address/);
    await check(popup, '25-send-btc');
    await click(popup, 'back');
    await click(popup, 'history');
    await sleep(6000);
    await check(popup, '26-history');
    await click(popup, 'back');
    await click(popup, '[ = ]');
    await waitText(popup, /connected sites/);
    await check(popup, '27-settings');
  });

  const dapp = await dappPage(blank);
  await dapp.goto(DAPP_URL, { waitUntil: 'load' });
  await step('a dApp finds plum twice: the Wallet Standard (Solana) and EIP-6963 (Ethereum)', async () => {
    // (two Wallet Standard wallets: Solana's, and Bitcoin's with the bitcoin:* features)
    assert.deepEqual(await dapp.evaluate(() => window.dapp.names()), ['Plum', 'Plum']);
    const features = await dapp.evaluate(() => window.dapp.features());
    for (const f of ['standard:connect', 'solana:signTransaction', 'solana:signAndSendTransaction', 'solana:signMessage', 'solana:signIn']) assert.ok(features.includes(f), `the wallet has ${f}`);
    const info = await dapp.evaluate(() => window.dapp.providers());
    assert.equal(info.length, 1);
    assert.deepEqual([info[0].name, info[0].rdns], ['Plum', 'fun.plum']);
    assert.equal(await dapp.evaluate(() => window.ethereum), undefined, 'plum never takes window.ethereum');
  });

  await step('Ethereum: connect, personal_sign, a permit (a danger), a transaction (rejected)', async () => {
    await dapp.evaluate(() => window.dapp.ethWatch());
    const asked = pendingCall(dapp, () => window.dapp.ethConnect());
    let ap = await approvalPage(/wants to see your Ethereum address/);
    await check(ap, '28-approve-eth-connect');
    await answer(ap, true);
    const connected = await asked;
    assert.equal(connected.ok?.length, 1, JSON.stringify(connected));
    const me = connected.ok[0];
    const msg = 'sign in to the test dapp\nnonce: 7d1e';
    const signing = pendingCall(dapp, (m, a) => window.dapp.ethCall('personal_sign', [m, a]), msg, me);
    ap = await approvalPage(/nonce: 7d1e/);
    await check(ap, '29-approve-eth-message');
    await answer(ap, true);
    const sig = await signing;
    assert.equal(await recoverMessageAddress({ message: msg, signature: sig.ok }), me);
    const permit = {
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
      },
      primaryType: 'Permit',
      domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      message: { owner: me, spender: '0x000000000000000000000000000000000000dEaD', value: ((1n << 256n) - 1n).toString(), nonce: '0', deadline: '9999999999' },
    };
    const typed = pendingCall(dapp, (a, t) => window.dapp.ethCall('eth_signTypedData_v4', [a, t]), me, JSON.stringify(permit));
    ap = await approvalPage(/permit/);
    await check(ap, '30-approve-eth-permit');
    await answer(ap, true, { ack: true });
    const tsig = (await typed).ok;
    assert.equal(await recoverTypedDataAddress({ ...permit, message: { ...permit.message, value: (1n << 256n) - 1n, nonce: 0n, deadline: 9999999999n }, signature: tsig }), me);
    const tx = pendingCall(dapp, (a) => window.dapp.ethCall('eth_sendTransaction', [{ from: a, to: '0x000000000000000000000000000000000000dEaD', value: '0x38d7ea4c68000' }]), me);
    ap = await approvalPage(/send a transaction/);
    await waitText(ap, /what changes|simulate/, 40_000);
    await sleep(1500);
    await check(ap, '31-approve-eth-tx');
    await answer(ap, false);
    assert.equal((await tx).code, 4001, 'rejected: nothing was sent');
  });

  await step('Solana: connect in the same window style', async () => {
    // a silent connect from a site plum doesn't know gets nothing, and no window
    assert.deepEqual(await dapp.evaluate(() => window.dapp.sol(true)), { ok: [] });
    const asked = pendingCall(dapp, () => window.dapp.sol(false));
    const ap = await approvalPage(/wants to see your Solana address/);
    await check(ap, '32-approve-sol-connect');
    await answer(ap, true);
    const r = await asked;
    assert.equal(r.ok?.length, 1, JSON.stringify(r));
  });

  await step('switching wallets tells the Ethereum site (accountsChanged)', async () => {
    await open();
    await popup.locator('button.acct').click();
    const picks = await popup.$$('.acct-row:not(.on) .pick');
    await picks[0].click();
    await waitText(popup, /tokens/);
    await sleep(800);
    const seen = await dapp.evaluate(() => window.dapp.ethChanges());
    assert.ok(seen.some((list) => Array.isArray(list) && list.length === 0), `the site heard the switch (${JSON.stringify(seen)})`);
  });

  await step('lock and unlock (a wrong password first)', async () => {
    await click(popup, '[ = ]');
    await click(popup, 'lock plum now');
    await waitText(popup, /unlock/);
    await check(popup, '33-locked');
    await popup.type('.secret-field input', 'not the password');
    await click(popup, 'unlock ->');
    await waitText(popup, /wrong password/);
    await popup.$eval('.secret-field input', (el) => { el.value = ''; });
    await popup.type('.secret-field input', PASSWORD);
    await click(popup, 'unlock ->');
    await waitText(popup, /tokens/, 30_000);
  });
} catch (e) {
  failures++;
  console.log('the run stopped:', e.message);
} finally {
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
}
if (pageErrors.length) console.log(`\n${pageErrors.length} error(s) on the pages (see each step above)`);
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
