// Red-team, in real Firefox Developer Edition (headless, throwaway profile): the attacks Node can't prove.
//   A. a malicious page floods `connect`: plum opens one approval window for the lot (no window spam, no focus theft),
//      and closing it answers every request "no".
//   B. the approve button can't be clicked the instant its window appears (it arms only after a beat in front), so a
//      click timed for that moment misses; it goes back to sleep when the window loses focus, and wakes a beat after.
//   C. hostile strings (HTML/script markup, invisible TAG characters) in a message render inert and literal (no
//      innerHTML), and a message hiding characters is shown as bytes, not as readable text.
//   D. an Ethereum page firing a burst of eth_requestAccounts + personal_sign gets one window too, connected or not,
//      and "reject all" answers the site's whole burst.
//   node build.mjs && node scripts/redteam/attacks-firefox.mjs [--firefox "C:\path\to\firefox.exe"] [--headful]
// Nothing is sent to any chain. Harness patterns from scripts/e2e-firefox.mjs (why extension pages are opened, found
// and capped the way they are is explained there).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist', 'firefox');
const SHOTS = join(ROOT, 'shots', 'redteam');
mkdirSync(SHOTS, { recursive: true });
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const FIREFOX = arg('--firefox') ?? 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe';
const UUID = '8b1f6c2e-5d3a-4c7e-9f10-0000000000a7';
const EXT = `moz-extension://${UUID}/`;
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'plum redteam password';
const ARM_MS = 900; // src/ui/approve.js: how long the approval window must be in front before its button arms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('>', ...a);

if (!existsSync(join(DIST, 'manifest.json'))) { console.error('no dist/firefox/ yet: run npm run build first'); process.exit(1); }

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

// a hostile dApp: markup and invisible TAG characters in a message, a flood of connect calls, and bursts of Ethereum
// requests (found through EIP-6963)
const MARKUP = '<img src=x onerror="window.__pwned__=1"><script>window.__pwned__=1<\\/script> & "quoted"';
const TAGGED = 'Approve login to app\uDB40\uDC41\uDB40\uDC42\uDB40\uDC43'; // 'app' + three invisible TAG chars (U+E0041..)
const DAPP = `<!doctype html><meta charset="utf-8"><title>redteam dapp</title><link rel="icon" href="data:,"><body style="background:#fff;font:14px sans-serif"><h1>redteam</h1><script>
const wallets = [];
const api = { register: (...ws) => { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); return () => {}; }, get: () => wallets, on: () => () => {} };
window.addEventListener('wallet-standard:register-wallet', (e) => e.detail(api));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
const providers = [];
window.addEventListener('eip6963:announceProvider', (e) => providers.push(e.detail));
window.dispatchEvent(new Event('eip6963:requestProvider'));
const plum = () => wallets.find((w) => w.name === 'Plum');
const eth = () => providers.find((p) => p.info.name === 'Plum')?.provider;
/** How each of a burst's requests ended: 'ok', or the error's code. */
const outcomes = (list) => Promise.allSettled(list).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason?.code ?? r.reason?.message)));
/** A promise's answer, or 'still waiting' after a few seconds (a request plum never answered can't hang the run). */
const soon = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('still waiting'), 5000))]);
window.__pwned__ = 0;
window.dapp = {
  ready: () => !!plum() && !!eth(),
  // fire N connect()s in the same tick, each a fresh promise
  flood: (n) => { const f = plum().features['standard:connect'].connect; const all = []; for (let i = 0; i < n; i++) all.push(f({})); window.__flood = outcomes(all); return n; },
  flooded: () => soon(window.__flood),
  async connect() { try { const r = await plum().features['standard:connect'].connect({}); return { ok: r.accounts.map((a) => a.address) }; } catch (e) { return { err: e.message, code: e.code }; } },
  signMarkup(text) { const r = plum().features['solana:signMessage'].signMessage({ account: plum().accounts[0], message: new TextEncoder().encode(text) }); window.__sig = r.then(() => ({ ok: true })).catch((e) => ({ err: e.message, code: e.code })); return true; },
  signed: () => soon(window.__sig),
  // Ethereum: some eth_requestAccounts, then some personal_signs, all in the same tick
  ethBurst: (accounts, signs) => { const p = eth(); const all = []; for (let i = 0; i < accounts; i++) all.push(p.request({ method: 'eth_requestAccounts' })); for (let i = 0; i < signs; i++) all.push(p.request({ method: 'personal_sign', params: ['burst message ' + i] })); window.__burst = outcomes(all); return all.length; },
  burst: () => soon(window.__burst),
  async ethConnect() { try { return { ok: await eth().request({ method: 'eth_requestAccounts' }) }; } catch (e) { return { err: e.message, code: e.code }; } },
  pwned: () => window.__pwned__,
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
const findings = [];
async function step(name, fn) {
  try { await fn(); log('ok  ', name); } catch (e) { failures++; log('FAIL', name, '\n     ', (e.message || String(e)).split('\n').slice(0, 4).join('\n      ')); }
}
/** A page's address, as it says it (Firefox shows automation about:blank for extension pages). */
const hrefOf = (p) => Promise.race([p.evaluate(() => location.href), sleep(5000).then(() => '?')]).catch(() => '?');
async function findPage(test, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const p of await browser.pages()) if (test(await hrefOf(p))) return p;
    await sleep(250);
  }
  throw new Error('no such tab');
}
/** plum's pages get the 60 fps cap once they're up (Firefox won't add one before), once per document. */
async function capLate(p) {
  if (await p.evaluate(() => !!window.__cap60).catch(() => true)) return;
  await p.evaluate(CAP_60FPS).then(() => p.evaluate(() => { window.__cap60 = true; })).catch(() => {});
}
/** Every approval window open right now. */
async function approvalPages() {
  const out = [];
  for (const p of await browser.pages()) if ((await hrefOf(p)).startsWith(`${EXT}approve.html`)) out.push(p);
  return out;
}
/** The first approval window, as soon as it's there (polled fast: the arming test races its button). */
async function firstApproval(timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const [p] = await approvalPages();
    if (p) return p;
    await sleep(40);
  }
  throw new Error('no approval window opened');
}
/** The approval window, showing its request (and capped). */
async function approval(timeout = 15_000) {
  const p = await firstApproval(timeout);
  await p.waitForSelector('main.approve', { timeout });
  await capLate(p);
  return p;
}
const click = async (p, text, tag = 'button') => p.locator(`${tag}::-p-text(${text})`).setTimeout(12_000).click();
const textOf = (p) => p.evaluate(() => document.body.innerText).catch(() => '');
async function waitText(p, re, timeout = 20_000) {
  if (!re.flags.includes('i')) re = new RegExp(re.source, `${re.flags}i`);
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (re.test(await textOf(p))) return; await sleep(200); }
  throw new Error(`timed out waiting for ${re} in:\n${(await textOf(p)).slice(0, 300)}`);
}
/** The approval window asks for focus itself (automation can't bring a privileged window forward in Firefox). */
const focusOwn = (ap) => ap.evaluate(async () => { const w = await browser.windows.getCurrent(); await browser.windows.update(w.id, { focused: true }); return true; });
/** Whether a page promise is still waiting after `ms` (it would have answered by now if a click had approved it). */
const stillWaiting = (promise, ms) => Promise.race([promise.then(() => false), sleep(ms).then(() => true)]);
/** Every approval window closed, and nothing left waiting in plum. */
async function clearApprovals() {
  for (const ap of await approvalPages()) await ap.close().catch(() => {});
  await sleep(600);
}

try {
  browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: !process.argv.includes('--headful'),
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ 'plum-wallet@plum.fun': UUID }), 'browser.shell.checkDefaultBrowser': false, 'layout.frame_rate': 60 },
  });
  try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  // the dApp gets the tab Firefox opened with, in its normal window (a new page lands in whichever window was used
  // last, which can be one of plum's popup windows)
  const [dapp] = await browser.pages();
  await browser.installExtension(DIST);
  // the window plum opens on install is its own page: the door plum's UI methods come through
  const plumWin = await findPage((href) => href === `${EXT}popup.html?window=1`);
  await capLate(plumWin);
  const ui = (method, params = {}) => plumWin.evaluate((m, p) => browser.runtime.sendMessage({ type: 'plum-ui', method: m, params: p }), method, params);

  await step('set up: the "abandon" phrase restored (restore), from plum\'s own window', async () => {
    const r = await ui('restore', { password: PASSWORD, mnemonic: ABANDON, name: 'redteam' });
    assert.ok(r?.ok, r?.error);
    const S = r.result;
    assert.ok(S.unlocked && S.wallets.length === 1, JSON.stringify(S).slice(0, 200));
    const w = S.wallets.find((x) => x.id === S.active);
    assert.ok(w.chains.sol?.address && w.chains.eth?.address, 'wallet 1 on Solana and Ethereum');
    log('     wallet', w.name, w.chains.sol.address, w.chains.eth.address);
  });
  await plumWin.close().catch(() => {});

  await dapp.evaluateOnNewDocument(CAP_60FPS);
  await dapp.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await dapp.goto(DAPP_URL, { waitUntil: 'load' });
  await step('the dApp sees plum (Wallet Standard and EIP-6963)', async () => { await waitText(dapp, /redteam/); assert.ok(await dapp.evaluate(() => window.dapp.ready())); });

  // A. flood: 6 connect()s at once; count the approval windows
  await step('A: a connect flood opens one approval window, and closing it says no to all of them', async () => {
    await dapp.evaluate(() => window.dapp.flood(6));
    await sleep(2500);
    const windows = await approvalPages();
    log('     approval windows after a 6-request flood:', windows.length);
    assert.ok(windows.length >= 1, 'at least one window opened');
    await capLate(windows[0]);
    await waitText(windows[0], /request 1 of/);
    await windows[0].screenshot({ path: join(SHOTS, 'A-flood-window.png') }).catch(() => {});
    if (windows.length > 1) findings.push(`A: a 6-connect flood opened ${windows.length} approval windows`);
    log('     it says:', (await textOf(windows[0])).match(/request 1 of \d+/i)?.[0], '/', (await textOf(windows[0])).match(/reject all \d+ from [^\n]+/i)?.[0]);
    await clearApprovals();
    const ends = [await dapp.evaluate(() => window.dapp.flooded())].flat();
    log('     how the 6 ended:', ends.join(' '));
    assert.equal(windows.length, 1, `${windows.length} windows opened (expected 1): the page can spawn a window per request`);
    assert.ok(ends.every((x) => x === 4001 || x === 4100), `every request ended in a no (${ends.join(' ')})`);
  });

  // B. the approve button and its timing
  await step('B: the approve button sleeps when its window appears, and again when the window loses focus', async () => {
    const asked = dapp.evaluate(() => window.dapp.connect()).catch((e) => ({ err: e.message }));
    const ap = await firstApproval();
    // read the button the moment it's drawn (in the window itself: no round trips), with how long the window has been open
    const first = await ap.evaluate(async () => {
      const until = performance.now() + 15_000;
      let b = null;
      while (!(b = document.querySelector('main.approve .answer .btn-go')) && performance.now() < until) await new Promise((r) => setTimeout(r, 5));
      return b && { disabled: b.disabled, at: Math.round(performance.now()) };
    });
    assert.ok(first, 'the approval window drew its buttons');
    const early = first.at < ARM_MS - 100; // the window could not have armed yet, whatever it did
    log(`     at first sight (${first.at} ms after the window opened) the button is ${first.disabled ? 'asleep' : 'LIVE'}`);
    if (!first.disabled && early) findings.push(`B: the approve button was live ${first.at} ms after its window opened`);
    // a real click timed for the moment the window shows
    await ap.click('main.approve .answer .btn-go').catch(() => {});
    const missed = await stillWaiting(asked, 400);
    if (!missed && early) findings.push('B: a click the instant the window appeared approved the request');
    if (missed) {
      await capLate(ap);
      await ap.screenshot({ path: join(SHOTS, 'B-just-opened.png') }).catch(() => {});
      // in front for a beat, it arms
      await focusOwn(ap);
      await sleep(ARM_MS + 400);
      assert.equal(await ap.$eval('.answer .btn-go', (b) => b.disabled), false, 'armed after a beat in front');
      // the dApp's tab in front: plum's window loses focus, and its button goes back to sleep
      await dapp.bringToFront();
      await sleep(400);
      const away = await ap.evaluate(() => ({ focus: document.hasFocus(), disabled: document.querySelector('.answer .btn-go').disabled }));
      if (away.focus) log('     (headless Firefox left plum\'s window focused: going back to sleep on blur was not exercised)');
      else {
        if (!away.disabled) findings.push('B: the approve button stayed live after its window lost focus');
        assert.equal(away.disabled, true, 'asleep again once the window lost focus');
        // back in front: a click straight away misses, as the button waits a beat again
        await focusOwn(ap);
        await ap.click('main.approve .answer .btn-go').catch(() => {});
        if (!(await stillWaiting(asked, 400))) findings.push('B: a click the instant the window came back in front approved the request');
      }
      await sleep(ARM_MS + 400);
      await click(ap, 'connect ->');
    } else log(`     (the window was found ${first.at} ms in, after it could arm: the click timing was not exercised; the request was approved)`);
    const r = await asked;
    assert.ok(r.ok?.length, JSON.stringify(r));
    assert.ok(early || missed, `the window was found too late (${first.at} ms) to time a click`);
    assert.ok(first.disabled || !early, 'the approve button is asleep the instant the window opens');
  });

  // C. hostile strings render inert and literal
  await step('C: markup in a message is inert and shown literally; TAG characters make it unreadable bytes', async () => {
    await dapp.evaluate((m) => window.dapp.signMarkup(m), MARKUP);
    const ap = await approval();
    await waitText(ap, /img src|onerror/);
    await ap.screenshot({ path: join(SHOTS, 'C-markup-message.png') }).catch(() => {});
    assert.equal(await dapp.evaluate(() => window.dapp.pwned()), 0, 'no injected script ran in the page');
    assert.equal(await ap.evaluate(() => window.__pwned__ ?? 0), 0, 'no injected script ran in the approval window');
    // the markup is there as TEXT, not as an <img>/<script> element
    assert.equal(await ap.$$eval('main img, main script', (els) => els.length), 0, 'the markup did not become real elements');
    const shown = await ap.$eval('.msg', (el) => el.textContent);
    assert.ok(shown.includes('<img src=x onerror='), 'the markup is shown as literal text');
    await click(ap, 'reject');
    assert.equal((await dapp.evaluate(() => window.dapp.signed())).code, 4001, 'the page heard no');
    await sleep(300);

    await dapp.evaluate((m) => window.dapp.signMarkup(m), TAGGED);
    const ap2 = await approval();
    await waitText(ap2, /the message/);
    await ap2.screenshot({ path: join(SHOTS, 'C-tagchars-message.png') }).catch(() => {});
    const msg = await ap2.$eval('.msg', (el) => el.textContent).catch(() => null);
    const unreadable = /isn't readable/.test(await textOf(ap2));
    if (msg && /Approve login to app/.test(msg) && !unreadable) findings.push('C: a message with invisible U+E00xx TAG characters is shown as ordinary readable text');
    assert.ok(unreadable, 'a message hiding characters is called unreadable');
    await click(ap2, 'reject');
    assert.equal((await dapp.evaluate(() => window.dapp.signed())).code, 4001, 'the page heard no');
  });

  // D. Ethereum: bursts of requests, before and after the site is connected
  await step('D: an Ethereum burst (3 eth_requestAccounts + 3 personal_sign) gets one window', async () => {
    await sleep(500);
    await dapp.evaluate(() => window.dapp.ethBurst(3, 3));
    await sleep(2500);
    const windows = await approvalPages();
    log('     approval windows after the burst:', windows.length);
    assert.ok(windows.length >= 1, 'at least one window opened');
    const ap = windows[0];
    await capLate(ap);
    await waitText(ap, /wants to see your Ethereum address/);
    await ap.screenshot({ path: join(SHOTS, 'D-eth-burst.png') }).catch(() => {});
    if (windows.length > 1) findings.push(`D: an Ethereum burst opened ${windows.length} approval windows`);
    const said = await textOf(ap);
    log('     it says:', said.match(/request 1 of \d+/i)?.[0], '/', said.match(/reject all \d+ from [^\n]+/i)?.[0]);
    // the site's whole burst, answered no at once
    await focusOwn(ap);
    await click(ap, 'reject all');
    await sleep(800);
    const ends = [await dapp.evaluate(() => window.dapp.burst())].flat();
    log('     how the 6 ended:', ends.join(' '));
    assert.equal(windows.length, 1, `${windows.length} windows opened (expected 1)`);
    assert.ok(ends.every((x) => x === 4001 || x === 4100), `every request ended in a no (${ends.join(' ')})`);
    assert.equal((await approvalPages()).length, 0, 'the window closed with nothing left to answer');
  });

  await step('D: connected, a burst of personal_signs (and eth_requestAccounts) still gets one window', async () => {
    const asked = dapp.evaluate(() => window.dapp.ethConnect()).catch((e) => ({ err: e.message }));
    let ap = await approval();
    await waitText(ap, /wants to see your Ethereum address/);
    await focusOwn(ap);
    await sleep(ARM_MS + 400);
    await click(ap, 'connect ->');
    const r = await asked;
    assert.equal(r.ok?.length, 1, JSON.stringify(r));
    await sleep(800);
    await dapp.evaluate(() => window.dapp.ethBurst(2, 3));
    await sleep(2500);
    const windows = await approvalPages();
    log('     approval windows after the burst:', windows.length);
    assert.ok(windows.length >= 1, 'at least one window opened');
    ap = windows[0];
    await capLate(ap);
    await waitText(ap, /burst message/);
    await ap.screenshot({ path: join(SHOTS, 'D-eth-burst-connected.png') }).catch(() => {});
    if (windows.length > 1) findings.push(`D: a connected site's burst of signatures opened ${windows.length} approval windows`);
    const said = await textOf(ap);
    log('     it says:', said.match(/request 1 of \d+/i)?.[0], '/', said.match(/reject all \d+ from [^\n]+/i)?.[0]);
    await focusOwn(ap);
    await click(ap, 'reject all');
    await sleep(800);
    const ends = [await dapp.evaluate(() => window.dapp.burst())].flat();
    log('     how the 5 ended:', ends.join(' '));
    assert.equal(windows.length, 1, `${windows.length} windows opened (expected 1)`);
    assert.deepEqual(ends.slice(0, 2).map((x) => x === 'ok'), [true, true], 'the connected site got its accounts at once');
    assert.ok(ends.slice(2).every((x) => x === 4001), `every signature was answered no (${ends.join(' ')})`);
  });
  await clearApprovals();
} catch (e) {
  failures++; log('harness error', e.message);
} finally {
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
}
console.log('\nfindings reproduced in Firefox:');
for (const f of findings) console.log('  -', f);
if (!findings.length) console.log('  none');
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps ran');
process.exit(failures || findings.length ? 1 : 0);
