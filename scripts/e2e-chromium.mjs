// plum in real Chrome, end to end: the installed Chrome, headless, in a throwaway profile (your own profile is never
// touched), with dist/chromium/ loaded. It goes through every screen the way you would and saves each to shots/:
// the welcome in the popup, a new wallet made right there (icon, name, 24 words, password, the phrase, done), home on
// three chains, accounts (a new wallet, a new account, an account brought from a phrase with its wallets found, a
// private key), receive on each chain, send, history, settings, locking. Then a test dApp on localhost finds plum
// through the Wallet Standard and EIP-6963, and asks for Solana and Ethereum connections, messages, typed data and a
// transaction, each in plum's approval window. Every screen is checked for one text size.
//   node build.mjs && node scripts/e2e-chromium.mjs [--chrome "C:\path\to\chrome.exe"] [--headful]
// Nothing is ever sent to a chain: transactions are rejected, only signatures are approved (and checked here).
// Mainnet is read (balances, the phrase scan, simulations).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { recoverMessageAddress, recoverTypedDataAddress } from 'viem';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'chromium');
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const CHROME = arg('--chrome') ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HEADLESS = !process.argv.includes('--headful');
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'plum e2e password';
const ETH_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'; // a well-known throwaway test key
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('>', ...a);

if (!existsSync(join(DIST, 'manifest.json'))) { console.error('no dist/chromium/ yet: run npm run build first'); process.exit(1); }

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
async function step(name, fn) {
  try { await fn(); log('ok  ', name); } catch (e) {
    failures++;
    log('FAIL', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      '));
    let n = 0;
    for (const p of await browser.pages()) {
      const href = p.url();
      const text = await p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      console.log(`      tab ${n}: ${href}\n        ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
      await p.screenshot({ path: join(SHOTS, `fail-c${failures}-${n++}.png`) }).catch(() => {});
    }
  }
}
async function newPage(viewport) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(CAP_60FPS);
  await p.setViewport({ ...(viewport ?? { width: 1280, height: 720 }), deviceScaleFactor: 1 });
  return p;
}
/** The whole page, as tall as it is (up to 2400px), at the popup's width. */
/** A call into the dApp page that's still waiting while plum's window is answered: if the run stops meanwhile, its
 * failure is kept as the answer instead of crashing the script. */
const pendingCall = (p, fn, ...args) => p.evaluate(fn, ...args).catch((e) => ({ err: e.message }));
const shot = async (p, name) => {
  await sleep(250);
  const h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  const w = await p.evaluate(() => Math.ceil(document.documentElement.scrollWidth));
  await p.screenshot({ path: join(SHOTS, `c-${name}.png`), clip: { x: 0, y: 0, width: Math.min(w, 1280), height: Math.min(h, 2400) }, captureBeyondViewport: true });
};
const click = async (p, text, tag = 'button') => { await p.locator(`${tag}::-p-text(${text})`).setTimeout(20_000).click(); };
const textOf = (p) => p.evaluate(() => document.body.innerText);
async function waitText(p, re, timeout = 25_000) {
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (re.test(await textOf(p))) return; await sleep(200); }
  throw new Error(`timed out waiting for ${re} in:\n${(await textOf(p)).slice(0, 500)}`);
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
    for (const t of browser.targets().filter((x) => x.url().includes('/approve.html'))) {
      const p = await t.page().catch(() => null);
      const text = p ? await p.evaluate(() => (document.querySelector('main.approve') ? document.body.innerText : '')).catch(() => '') : '';
      if (re.test(text)) {
        await p.setViewport({ width: 400, height: 660, deviceScaleFactor: 1 }).catch(() => {});
        return p;
      }
    }
    await sleep(250);
  }
  throw new Error(`no approval window showed ${re}`);
}
/** Approve (or reject) what the approval window shows, once its button has armed. */
async function answer(ap, yes, { ack = false } = {}) {
  await ap.bringToFront();
  await sleep(1300);
  if (ack) { const a = await ap.$('.ack-row:not([hidden]) .toggle'); if (a) await a.click(); }
  if (yes) await ap.locator('.answer .btn-go').setTimeout(20_000).click();
  else await click(ap, 'reject').catch(() => click(ap, 'cancel'));
}

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    pipe: true,
    enableExtensions: true,
    args: ['--enable-unsafe-extension-debugging', ...(HEADLESS ? ['--screen-info={0,0 1280x800}'] : [])],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    protocolTimeout: 120_000,
  });
  try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  // pages plum opens itself (its windows) get the 60 fps cap as soon as they appear
  browser.on('targetcreated', async (t) => { if (t.type() === 'page') { const p = await t.page().catch(() => null); await p?.evaluateOnNewDocument(CAP_60FPS).catch(() => {}); } });
  const id = await browser.installExtension(DIST);
  const EXT = `chrome-extension://${id}/`;
  log(`plum in ${await browser.version()}, extension ${id}`);
  const popup = await newPage({ width: 380, height: 600 });
  // (a tab in the background gets no animation frames, which puppeteer's clicks wait for: the popup comes to the front)
  const open = async () => { await popup.bringToFront(); await popup.goto(`${EXT}popup.html`, { waitUntil: 'load' }); await popup.waitForSelector('#app > :not(.boot)', { timeout: 20_000 }); };

  await step('the welcome, in the popup (and the window plum opens on install)', async () => {
    const welcomeWin = await browser.waitForTarget((t) => t.url() === `${EXT}popup.html?window=1`, { timeout: 15_000 }).catch(() => null);
    assert.ok(welcomeWin, 'installing opened the welcome window');
    await (await welcomeWin.page())?.close().catch(() => {});
    await open();
    await waitText(popup, /new here/);
    await check(popup, '01-welcome');
  });

  await step('a new wallet, right in the popup: icon, name, 24 words, password, phrase, done', async () => {
    await click(popup, 'create a new wallet');
    await waitText(popup, /create a wallet/);
    await waitText(popup, /step 1 of 2/);
    assert.equal(await popup.evaluate(() => location.pathname), '/popup.html', 'still the popup: no tab of its own');
    await check(popup, '02-create');
    await popup.locator('button.face-square').click();
    await sleep(700);
    await check(popup, '03-create-icons');
    await popup.locator('button.face-pick[title="whale"]').click();
    await sleep(600);
    await popup.type('input[placeholder="a name (optional)"]', 'main');
    await click(popup, '24 words');
    await popup.type('.secret-field input', PASSWORD);
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

  const dapp = await newPage();
  await dapp.goto(DAPP_URL, { waitUntil: 'load' });
  await step('a dApp finds plum twice: the Wallet Standard (Solana) and EIP-6963 (Ethereum)', async () => {
    // (two Wallet Standard wallets: Solana's, and Bitcoin's with the bitcoin:* features)
    assert.deepEqual(await dapp.evaluate(() => window.dapp.names()), ['Plum', 'Plum']);
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
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
