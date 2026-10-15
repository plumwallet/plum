// Bitcoin in real Chrome, end to end: the installed Chrome, headless, in a throwaway profile, with dist/chromium/
// loaded. What plum reads about Bitcoin (mempool.space, ordinals.com, prices) is answered by this script from the
// service worker's own requests (CDP's Fetch domain), so every screen is the same each run; everything else is read as
// usual. It goes through the popup's Bitcoin screens (receive on both addresses, a wallet's addresses, a send that
// keeps an inscribed coin out, a key import) and a test dApp on localhost that finds plum through WBIP-004
// (window.btc_providers) and asks for a connection, messages, PSBTs and a send, each in plum's approval window. Every
// signature is checked here, every screen for one text size, and each is saved as btc-*.png.
//   node build.mjs && node scripts/e2e-btc-chromium.mjs [--shots <dir>] [--chrome "C:\path\to\chrome.exe"] [--headful]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { hex, utf8 } from '../src/shared/bytes.js';
import { verifyBip322 } from '../src/background/bip322.js';
import { addressScript } from '../src/background/btc.js';
import { buildPsbt, p2wpkhAddress, stranger, txidOf, validator } from '../test/btc-helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'chromium');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = resolve(arg('--shots') ?? join(ROOT, 'shots'));
mkdirSync(SHOTS, { recursive: true });
const CHROME = arg('--chrome') ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HEADLESS = !process.argv.includes('--headful');
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'plum btc e2e password';
const SEGWIT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const SEG_SCRIPT = addressScript(SEGWIT).script, TR_SCRIPT = addressScript(TAPROOT).script;
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

/* ------------------------------------------------------------ the chain, as this run sees it */
const INSCRIPTION = `${'5e'.repeat(32)}i0`;
const coins = {
  [SEGWIT]: [{ txid: 'a1'.repeat(32), vout: 0, value: 184_000 }, { txid: 'a2'.repeat(32), vout: 1, value: 52_500 }],
  [TAPROOT]: [{ txid: 'b1'.repeat(32), vout: 0, value: 310_000 }, { txid: 'b2'.repeat(32), vout: 0, value: 546 }],
};
const ordinals = new Map([[`${'b2'.repeat(32)}:0`, { inscriptions: [INSCRIPTION], runes: {} }], [`${'b1'.repeat(32)}:0`, {}], [`${'a1'.repeat(32)}:0`, {}], [`${'a2'.repeat(32)}:1`, {}]]);
const satpoints = new Map([[INSCRIPTION, `${'b2'.repeat(32)}:0:0`]]);
const txs = new Map(); // txid -> outputs, for PSBT checks
const broadcast = [];
const onChain = (built) => {
  for (const [op, prev] of built.chain) {
    if (!prev) continue;
    const [txid, vout] = op.split(':');
    const outs = txs.get(txid) ?? [];
    outs[Number(vout)] = { scriptpubkey: hex(prev.script), value: Number(prev.value) };
    for (let i = 0; i < outs.length; i++) outs[i] ??= { scriptpubkey: '6a', value: 0 };
    txs.set(txid, outs);
  }
};

/** What this run answers for the service worker's request, or null to let it through. */
function answer(url, method, body) {
  const u = new URL(url);
  const json = (v, status = 200) => ({ status, body: typeof v === 'string' ? v : JSON.stringify(v) });
  if (u.host === 'mempool.space' || u.host === 'blockstream.info') {
    const path = u.pathname.replace(/^\/api/, '');
    let m;
    if (path === '/v1/fees/recommended') return json({ fastestFee: 9, halfHourFee: 6, hourFee: 4, economyFee: 2, minimumFee: 1 });
    if (path === '/tx' && method === 'POST') { broadcast.push(body); return json(Transaction.fromHex(body).getId()); }
    if ((m = /^\/address\/([^/]+)\/utxo$/.exec(path))) return json((coins[m[1]] ?? []).map((c) => ({ ...c, status: { confirmed: true } })));
    if ((m = /^\/address\/([^/]+)\/txs$/.exec(path))) return json([]);
    if ((m = /^\/address\/([^/]+)$/.exec(path))) { const sum = (coins[m[1]] ?? []).reduce((n, c) => n + c.value, 0); return json({ chain_stats: { funded_txo_sum: sum, spent_txo_sum: 0, tx_count: sum ? 2 : 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }); }
    if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path))) return json({ confirmed: false });
    if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) return txs.has(m[1]) ? json({ txid: m[1], vout: txs.get(m[1]) }) : json('Transaction not found', 404);
    return json('not found', 404);
  }
  if (u.host === 'ordinals.com') {
    let m;
    if ((m = /^\/r\/utxo\/(.+)$/.exec(u.pathname))) return ordinals.has(m[1]) ? json({ inscriptions: [], runes: {}, ...ordinals.get(m[1]) }) : json('not found', 404);
    if ((m = /^\/r\/inscription\/(.+)$/.exec(u.pathname))) return satpoints.has(m[1]) ? json({ id: m[1], satpoint: satpoints.get(m[1]) }) : json('not found', 404);
    return json('not found', 404);
  }
  if (u.host === 'api.coingecko.com') return json({ bitcoin: { usd: 81_250, usd_24h_change: 1.2 }, ethereum: { usd: 2510, usd_24h_change: -0.4 }, solana: { usd: 178, usd_24h_change: 2.1 } });
  return null;
}

/** Answer the service worker's requests (it's restarted at times: each new one is caught too). */
async function intercept(target) {
  const s = await target.createCDPSession();
  s.on('Fetch.requestPaused', async (e) => {
    const a = answer(e.request.url, e.request.method, e.request.postData);
    try {
      if (!a) { await s.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
      await s.send('Fetch.fulfillRequest', {
        requestId: e.requestId, responseCode: a.status,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
        body: Buffer.from(a.body).toString('base64'),
      });
    } catch { /* the worker went away */ }
  });
  await s.send('Fetch.enable', { patterns: ['mempool.space', 'blockstream.info', 'ordinals.com', 'api.coingecko.com'].map((h) => ({ urlPattern: `https://${h}/*` })) });
}

/* ------------------------------------------------------------ a test dApp: finds plum through WBIP-004 */
const DAPP = `<!doctype html><meta charset="utf-8"><title>plum btc dapp</title><link rel="icon" href="data:,"><body style="background:#fff;font:14px sans-serif"><h1>btc dapp</h1><script>
const provider = () => {
  const e = (window.btc_providers || []).find((p) => p.name === 'Plum');
  return e && e.id.split('.').reduce((acc, part) => acc && acc[part], window);
};
window.dapp = {
  listed: () => (window.btc_providers || []).map((p) => [p.id, p.name]),
  ask: (method, params) => provider().request(method, params),
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
    log('FAIL', name, '\n     ', e.message.split('\n').slice(0, 8).join('\n      '));
    let n = 0;
    for (const p of await browser.pages()) await p.screenshot({ path: join(SHOTS, `btc-fail-${failures}-${n++}.png`) }).catch(() => {});
  }
}
async function newPage(viewport) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(CAP_60FPS);
  await p.setViewport({ ...(viewport ?? { width: 1280, height: 720 }), deviceScaleFactor: 1 });
  return p;
}
const shot = async (p, name) => {
  await sleep(300);
  const h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  const w = await p.evaluate(() => Math.ceil(document.documentElement.scrollWidth));
  await p.screenshot({ path: join(SHOTS, `btc-${name}.png`), clip: { x: 0, y: 0, width: Math.min(w, 1280), height: Math.min(h, 2400) }, captureBeyondViewport: true });
};
const click = async (p, text, tag = 'button') => { await p.locator(`${tag}::-p-text(${text})`).setTimeout(20_000).click(); };
const textOf = (p) => p.evaluate(() => document.body.innerText);
async function waitText(p, re, timeout = 25_000) {
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (re.test(await textOf(p))) return; await sleep(200); }
  throw new Error(`timed out waiting for ${re} in:\n${(await textOf(p)).slice(0, 600)}`);
}
/** Every character on the screen is the same size (only the wallets' icons, drawn in characters, keep their own). */
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
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content && !['none', 'normal', '""'].includes(cs.content)) note(cs.fontSize, `${el.className}${pseudo} ${cs.content}`);
      }
    }
    return [...seen];
  });
  assert.deepEqual(sizes.map(([s]) => s), ['12.5px'], `${where}: every character the same size, but found ${sizes.map(([s, w]) => `${s} (${w})`).join(', ')}`);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `${where}: ${over}px wider than its window`);
  // no picture from anywhere: plum draws in characters
  assert.equal(await p.evaluate(() => [...document.images].filter((i) => !i.src.startsWith('chrome-extension:') && !i.src.startsWith('data:')).length), 0, `${where}: a remote picture`);
}
const check = async (p, name) => { await shot(p, name); await oneSize(p, name); };

async function approvalPage(re) {
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    for (const t of browser.targets().filter((x) => x.url().includes('/approve.html'))) {
      const p = await t.page().catch(() => null);
      const text = p ? await p.evaluate(() => (document.querySelector('main.approve') && !document.querySelector('main.approve .spin') ? document.body.innerText : '')).catch(() => '') : '';
      if (re.test(text)) {
        await p.setViewport({ width: 400, height: 660, deviceScaleFactor: 1 }).catch(() => {});
        return p;
      }
    }
    await sleep(250);
  }
  throw new Error(`no approval window showed ${re}`);
}
async function answerIt(ap, yes, { ack = false } = {}) {
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
  browser.on('targetcreated', async (t) => {
    if (t.type() === 'page') { const p = await t.page().catch(() => null); await p?.evaluateOnNewDocument(CAP_60FPS).catch(() => {}); }
    if (t.type() === 'service_worker' && t.url().startsWith('chrome-extension://')) await intercept(t).catch(() => {});
  });
  const id = await browser.installExtension(DIST);
  const EXT = `chrome-extension://${id}/`;
  log(`plum in ${await browser.version()}, extension ${id}`);
  for (const t of browser.targets()) if (t.type() === 'service_worker' && t.url().startsWith(EXT)) await intercept(t).catch(() => {});
  // the welcome window plum opens on install
  const welcomeWin = await browser.waitForTarget((t) => t.url() === `${EXT}popup.html?window=1`, { timeout: 15_000 }).catch(() => null);
  await (await welcomeWin?.page())?.close().catch(() => {});

  const popup = await newPage({ width: 380, height: 600 });
  const open = async () => { await popup.bringToFront(); await popup.goto(`${EXT}popup.html`, { waitUntil: 'load' }); await popup.waitForSelector('#app > :not(.boot)', { timeout: 20_000 }); };
  const ui = (method, params) => popup.evaluate((m, p) => chrome.runtime.sendMessage({ type: 'plum-ui', method: m, params: p }), method, params);

  await step('a wallet from the "abandon" phrase: its bc1q and bc1p addresses', async () => {
    await open();
    const r = await ui('restore', { password: PASSWORD, mnemonic: ABANDON });
    assert.ok(r.ok, r.error);
    const btc = r.result.wallets[0].chains.btc;
    assert.equal(btc.address, SEGWIT);
    assert.equal(btc.taproot.address, TAPROOT);
  });

  await step('receive: the bitcoin tab shows both addresses, one at a time, with what each is for', async () => {
    await open();
    await click(popup, 'receive');
    await click(popup, 'bitcoin');
    await waitText(popup, /segwit bc1q/);
    await waitText(popup, /bc1q/);
    await check(popup, 'receive-segwit');
    await click(popup, 'taproot bc1p');
    await waitText(popup, /ordinals and runes sites/);
    assert.match(await popup.$eval('.addr', (el) => el.innerText.replace(/\s+/g, '')), /^bc1p5cyx/);
    await check(popup, 'receive-taproot');
  });

  await step("a wallet's tools list its taproot address beside the others", async () => {
    await open();
    await popup.locator('button.acct').click();
    await waitText(popup, /new wallet/);
    await popup.locator('.acct-row button.mini').click();
    await waitText(popup, /bitcoin taproot/);
    await check(popup, 'wallet-addresses');
  });

  await step('send: coins from both addresses, the inscribed one kept out, change back to bc1q', async () => {
    await open();
    await popup.locator('button.tk[title="send BTC"]').setTimeout(60_000).click();
    await popup.locator('input[placeholder^="a Bitcoin address"]').setTimeout(30_000).fill(p2wpkhAddress('a friend'));
    // more than the biggest coin (bc1p, 0.0031) holds: the bc1q one comes in too; the inscribed 546 sats never
    await popup.type('input[inputmode="decimal"]', '0.0035');
    await click(popup, 'review ->');
    await waitText(popup, /kept out of this send/, 40_000);
    assert.match(await textOf(popup), /coins spent\s*\.*\s*2 \(1 from bc1p\)/i);
    await check(popup, 'send-review');
  });

  await step('importing a Bitcoin key shows both of its addresses first', async () => {
    await open();
    await popup.locator('button.acct').click();
    await click(popup, 'import a private key');
    // BIP-322's test key (public): a bc1q and a bc1p address
    await popup.type('.secret-field input', 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k');
    await click(popup, 'next ->');
    await waitText(popup, /bitcoin taproot/);
    await check(popup, 'import-key');
  });

  const dapp = await newPage();
  await dapp.goto(DAPP_URL, { waitUntil: 'load' });
  const ask = (method, params) => dapp.evaluate((m, p) => window.dapp.ask(m, p), method, params).catch((e) => ({ err: e.message }));

  await step('a dApp finds plum in window.btc_providers (WBIP-004), and connecting is approved in plum\'s window', async () => {
    assert.deepEqual(await dapp.evaluate(() => window.dapp.listed()), [['PlumProviders.BitcoinProvider', 'Plum']]);
    const info = await ask('getInfo', null);
    assert.equal(info.jsonrpc, '2.0');
    const pending = ask('getAddresses', { purposes: ['payment', 'ordinals'], message: 'connect to trade ordinals' });
    const ap = await approvalPage(/wants to see your Bitcoin addresses/);
    await check(ap, 'approve-connect');
    await answerIt(ap, true);
    const r = await pending;
    assert.deepEqual(r.result.addresses.map((a) => [a.purpose, a.address]), [['payment', SEGWIT], ['ordinals', TAPROOT]]);
  });

  await step('signMessage (BIP-322) for the taproot address: shown, signed, verified', async () => {
    const pending = ask('signMessage', { address: TAPROOT, message: 'gm from the btc dapp\nnonce: 81733' });
    const ap = await approvalPage(/gm from the btc dapp/);
    await check(ap, 'approve-message');
    await answerIt(ap, true);
    const r = await pending;
    assert.ok(verifyBip322(TAPROOT, utf8('gm from the btc dapp\nnonce: 81733'), r.result.signature));
  });

  await step('a sign-in message for another site is a named danger', async () => {
    const msg = `magiceden.io wants you to sign in with your Bitcoin account:\n${SEGWIT}\n\nWelcome back\n\nURI: https://magiceden.io\nNonce: 55ce2`;
    const pending = ask('signMessage', { address: SEGWIT, message: msg });
    const ap = await approvalPage(/it signs you in to magiceden\.io/);
    assert.equal(await ap.$eval('.answer .btn-go', (b) => b.disabled), true, 'approve waits for "i understand"');
    await check(ap, 'approve-message-danger');
    await answerIt(ap, false);
    assert.equal((await pending).error.code, -32000);
  });

  const merchant = p2wpkhAddress('an ordinals shop');
  await step('signPsbt: a payment from both addresses, checked on the chain; plum signs, bitcoinjs agrees', async () => {
    const built = buildPsbt({
      inputs: [{ txid: txidOf('e2e pay 1'), vout: 0, value: 120_000n, script: SEG_SCRIPT }, { txid: txidOf('e2e pay 2'), vout: 1, value: 64_000n, script: TR_SCRIPT }],
      outputs: [{ address: merchant, value: 150_000n }, { address: SEGWIT, value: 32_700n }],
    });
    onChain(built);
    const pending = ask('signPsbt', { psbt: built.b64, signInputs: { [SEGWIT]: [0], [TAPROOT]: [1] } });
    const ap = await approvalPage(/what changes/);
    await waitText(ap, /checked on chain/);
    await check(ap, 'approve-psbt');
    await answerIt(ap, true);
    const r = await pending;
    const signed = Psbt.fromBase64(r.result.psbt);
    assert.ok(signed.validateSignaturesOfInput(0, validator) && signed.validateSignaturesOfInput(1, validator));
  });

  await step('signPsbt: a marketplace listing (SINGLE|ANYONECANPAY) of an inscribed coin, every danger named', async () => {
    const built = buildPsbt({ inputs: [{ txid: 'b2'.repeat(32), vout: 0, value: 546n, script: TR_SCRIPT, sighashType: 0x83 }], outputs: [{ address: SEGWIT, value: 4_200_000n }] });
    onChain(built);
    const pending = ask('signPsbt', { psbt: built.b64, signInputs: { [TAPROOT]: [0] } });
    const ap = await approvalPage(/what your signature fixes/);
    await waitText(ap, /SINGLE\|ANYONECANPAY/);
    await check(ap, 'approve-psbt-listing');
    await answerIt(ap, false);
    assert.equal((await pending).error.code, -32000);
  });

  await step('signPsbt: a PSBT that lies about a coin is refused outright, no way to approve it', async () => {
    const built = buildPsbt({ inputs: [{ txid: txidOf('e2e lie'), vout: 0, value: 2_000_000n, claimValue: 20_000n, script: SEG_SCRIPT }], outputs: [{ address: merchant, value: 15_000n }] });
    onChain(built);
    const pending = ask('signPsbt', { psbt: built.b64 });
    const ap = await approvalPage(/plum won't sign this/);
    assert.equal(await ap.$eval('.answer .btn-go', (b) => b.disabled), true);
    await check(ap, 'approve-psbt-lie');
    await answerIt(ap, false);
    assert.equal((await pending).error.code, -32000);
  });

  await step('sendTransfer: built by plum from both addresses, approved, sent; one signer', async () => {
    const pending = ask('sendTransfer', { recipients: [{ address: stranger('e2e payee').address, amount: 90_000 }] });
    const ap = await approvalPage(/wants you to send bitcoin/);
    await waitText(ap, /fee rate/);
    await check(ap, 'approve-send');
    await answerIt(ap, true);
    const r = await pending;
    const tx = Transaction.fromHex(broadcast.at(-1));
    assert.equal(r.result.txid, tx.getId());
    assert.equal(hex(tx.outs.at(-1).script), hex(SEG_SCRIPT), 'change back to bc1q');
  });

  await step('settings list the site as connected on bitcoin', async () => {
    await open();
    await popup.locator('button.tab-btn').click();
    await waitText(popup, /connected sites/);
    await waitText(popup, /localhost/);
    assert.match(await popup.$eval('.sites', (el) => el.innerText), /btc/);
    await popup.$eval('.sites', (el) => el.scrollIntoView());
    await check(popup, 'settings-sites');
  });
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
console.log(failures ? `\n${failures} step(s) failed` : `\nall steps passed; screens in ${SHOTS}`);
process.exit(failures ? 1 : 0);
