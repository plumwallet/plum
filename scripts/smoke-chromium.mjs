// plum in real Chrome, a smoke test. The installed Chrome runs headless in a throwaway profile (your own profile is
// never touched), with dist/chromium/ loaded as an unpacked extension, and this checks that
//   a. the background's service worker starts and logs no errors (anything it logs as one is printed as it is);
//   b. the popup renders, and the background answers it (Chromium only takes an answer given through sendResponse);
//   c. a test page on localhost finds plum through the Wallet Standard, and through EIP-6963 once that's in;
//   d. installing plum with no wallet opens its welcome popup in a little window of its own.
//   node build.mjs && node scripts/smoke-chromium.mjs [--chrome "C:\path\to\chrome.exe"] [--headful]
// Only a, b and the Wallet Standard part of c fail the run (exit 1); EIP-6963 and the welcome window are reported.
// Branded Chrome (137 and later) ignores --load-extension, so plum goes in through CDP's Extensions.loadUnpacked,
// which Chrome only offers over a pipe and with --enable-unsafe-extension-debugging. Nothing is sent to any chain.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'chromium');
const SHOT = join(ROOT, 'shots', 'chromium-smoke-popup.png');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const CHROME = arg('--chrome') ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HEADLESS = !process.argv.includes('--headful');
const STARTUP_MS = 3000; // how long the service worker is watched on its own before the other checks begin
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('no dist/chromium/ yet: run npm run build first');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
mkdirSync(dirname(SHOT), { recursive: true });

// Everything printed goes through redact(): the built-in RPC's URL holds its key (rpc.local.txt), and an error about
// a failed request could quote it.
const secrets = [];
try {
  const raw = readFileSync(join(ROOT, 'rpc.local.txt'), 'utf8').trim();
  const u = new URL(raw);
  secrets.push(raw, u.href, ...u.pathname.split('/'), ...u.searchParams.values());
} catch { /* no rpc.local.txt, so nothing to hide */ }
const hide = secrets.filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
const redact = (text) => hide.reduce((t, s) => t.replaceAll(s, '<rpc.local.txt>'), String(text));

let failures = 0;
/** A check's line (pass, FAIL, or ---- for something that isn't there yet), and its details under it. */
function report(status, text, details = []) {
  console.log(`${status}  ${redact(text)}`);
  for (const d of details) console.log(`        ${redact(d).replaceAll('\n', '\n        ')}`);
}
const pass = (text, details) => report('pass', text, details);
const fail = (text, details) => { failures++; report('FAIL', text, details); };

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

/* ------------------------------------------------------------ a test dApp on localhost */
const DAPP = `<!doctype html><meta charset="utf-8"><title>plum smoke dapp</title><link rel="icon" href="data:,"><body><h1>smoke dapp</h1><script>
// the app side of the Wallet Standard, as scripts/e2e-firefox.mjs has it
const wallets = [];
const api = { register: (...ws) => { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); return () => {}; }, get: () => wallets, on: () => () => {} };
window.addEventListener('wallet-standard:register-wallet', (e) => e.detail(api));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
// EIP-6963: ask for Ethereum providers, and keep whatever announces itself
const providers = [];
window.addEventListener('eip6963:announceProvider', (e) => providers.push(e.detail));
window.dispatchEvent(new Event('eip6963:requestProvider'));
window.smoke = {
  wallets: () => wallets.map((w) => ({ name: w.name, chains: [...(w.chains ?? [])], features: Object.keys(w.features ?? {}) })),
  providers: () => providers.map((p) => ({ name: p?.info?.name, rdns: p?.info?.rdns, request: typeof p?.provider?.request === 'function' })),
};
</script>`;

const server = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DAPP);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const DAPP_URL = `http://localhost:${server.address().port}/`;

/* ------------------------------------------------------------ helpers */

/** What a value the page or worker logged reads as (a CDP RemoteObject). */
const shown = (o) => (o.type === 'string' ? o.value : o.description ?? (o.value !== undefined ? JSON.stringify(o.value) : o.unserializableValue ?? o.type));
/** An uncaught exception, as DevTools would print it. */
const thrown = (d) => {
  const what = `${d.text}${d.exception ? ` ${shown(d.exception)}` : ''}`;
  return d.url && !what.includes(d.url) ? `${what} (${d.url}:${d.lineNumber + 1}:${d.columnNumber + 1})` : what;
};

let browser = null;
async function newPage(viewport) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(CAP_60FPS);
  if (viewport) await p.setViewport({ ...viewport, deviceScaleFactor: 1 });
  // what the page throws or logs as an error, printed under its check
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(`page error: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') p.errors.push(`page console.error: ${m.text()}`); });
  return p;
}

/** One check. If it throws, that's its failure, and the next check still runs (`counts` false: it's reported, but it
 * doesn't fail the run). */
async function attempt(name, fn, counts = true) {
  try { await fn(); } catch (e) {
    const text = `${name} stopped: ${e.message.split('\n')[0]}`;
    if (counts) fail(text);
    else report('FAIL', `${text} (reported, doesn't fail the run)`);
  }
}

/* ------------------------------------------------------------ the checks */

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    // Extensions.loadUnpacked: over a pipe, with extensions left on, and Chrome's flag for it. Headless Chrome's
    // screen is 800x600 unless it's told otherwise, and windows taller than that (plum's 640) get cut to fit.
    pipe: true,
    enableExtensions: true,
    args: ['--enable-unsafe-extension-debugging', ...(HEADLESS ? ['--screen-info={0,0 1280x800}'] : [])],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    protocolTimeout: 60_000,
  });
  try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }

  // every tab and window from here on, so the window plum opens on install is seen even if it's gone by check d
  const created = [];
  browser.on('targetcreated', (t) => created.push(t));

  const id = await browser.installExtension(DIST);
  const EXT = `chrome-extension://${id}/`;
  console.log(`plum ${version} in ${await browser.version()}${HEADLESS ? ' (headless)' : ''}, extension ${id}\n`);

  // a. the service worker, and what it logs
  let sw = null;
  const swErrors = [];
  let phase = 'startup';
  await attempt('a.', async () => {
    sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(EXT), { timeout: 10_000 }).catch(() => null);
    if (!sw) { fail('a. no service worker started for plum within 10 s'); return; }
    const session = await sw.createCDPSession();
    session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => swErrors.push({ phase, text: thrown(exceptionDetails) }));
    session.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' || type === 'assert') swErrors.push({ phase, text: `console.${type}: ${args.map(shown).join(' ')}` });
    });
    session.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') swErrors.push({ phase, text: `${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}` });
    });
    // turning these on also replays what the worker logged before this attached to it
    await session.send('Runtime.enable');
    await session.send('Log.enable').catch(() => {});
    await sleep(STARTUP_MS);
    phase = 'later';
    // by now its script has run (this attaches as the worker starts, maybe before that): are plum's listeners in?
    const probe = await session.send('Runtime.evaluate', {
      expression: "['onMessage', 'onConnect', 'onInstalled'].map((e) => `${e} ${chrome.runtime[e].hasListeners()}`).join(', ')",
      returnByValue: true,
    });
    const listening = probe.exceptionDetails ? `couldn't run code in it: ${thrown(probe.exceptionDetails)}` : `listening: ${probe.result.value}`;
    const startup = swErrors.filter((e) => e.phase === 'startup').map((e) => e.text);
    const name = sw.url().slice(EXT.length);
    if (startup.length) fail(`a. the service worker (${name}) started, but logged ${startup.length} error(s) in its first ${STARTUP_MS / 1000} s`, [...startup, listening]);
    else if (probe.exceptionDetails) fail(`a. the service worker (${name}) started, but code can't run in it`, [listening]);
    else pass(`a. the service worker (${name}) started, and logged no errors in its first ${STARTUP_MS / 1000} s`, [listening]);
  });

  // b. the popup, and the background answering it
  await attempt('b.', async () => {
    const popup = await newPage({ width: 380, height: 600 });
    await popup.goto(`${EXT}popup.html`, { waitUntil: 'load' });
    const rendered = await popup.waitForSelector('#app > :not(.boot)', { timeout: 15_000 }).then(() => true, () => false);
    // a background that never answers would leave this waiting for good: 10 s is plenty
    const answer = await popup.evaluate(() => Promise.race([
      chrome.runtime.sendMessage({ type: 'plum-ui', method: 'state', params: {} }),
      new Promise((r) => setTimeout(() => r({ threw: 'no answer within 10 s' }), 10_000)),
    ]).catch((e) => ({ threw: e.message })));
    // the words on screen (the lines drawn in characters, like the logo, have none)
    const onScreen = await popup.$eval('#app', (el) => el.innerText.split('\n').map((l) => l.trim()).filter((l) => /[a-z]{3}/i.test(l)).join(' / ').slice(0, 110)).catch(() => '');
    await popup.screenshot({ path: SHOT });
    const s = answer?.result;
    const details = [
      `on screen: "${onScreen}"`,
      // only a few of the state's fields: none of them can carry an RPC's URL
      answer?.ok === true ? `state: ok: true (version ${s?.version}, hasVault ${s?.hasVault}, unlocked ${s?.unlocked})` : `state answered: ${JSON.stringify(answer)}`,
      `screenshot: ${relative(ROOT, SHOT).replaceAll('\\', '/')}`,
      ...popup.errors,
    ];
    if (rendered && answer?.ok === true) pass('b. the popup renders, and the background answers it', details);
    else fail(`b. ${rendered ? 'the popup renders' : "the popup didn't render (#app has only .boot)"}; ${answer?.ok === true ? 'the background answers it' : "the background didn't answer state with ok: true"}`, details);
  });

  // c. a dApp page on localhost: the Wallet Standard (counts), EIP-6963 (reported)
  await attempt('c.', async () => {
    const dapp = await newPage();
    await dapp.goto(DAPP_URL, { waitUntil: 'load' });
    const plum = await dapp.waitForFunction(() => window.smoke.wallets().find((w) => w.name === 'Plum'), { timeout: 5000, polling: 100 }).then((h) => h.jsonValue(), () => null);
    if (plum) pass(`c. Wallet Standard: ${DAPP_URL} found Plum`, [`chains: ${plum.chains.join(', ')}`, `features: ${plum.features.join(', ')}`, ...dapp.errors]);
    else fail(`c. Wallet Standard: Plum never registered on ${DAPP_URL}`, [`wallets there: ${JSON.stringify(await dapp.evaluate(() => window.smoke.wallets().map((w) => w.name)))}`, ...dapp.errors]);
    const announced = await dapp.waitForFunction(() => window.smoke.providers().find((p) => p.name === 'Plum'), { timeout: 3000, polling: 100 }).then((h) => h.jsonValue(), () => null);
    if (announced) pass(`c. EIP-6963: Plum announced itself (rdns ${announced.rdns}, ${announced.request ? 'with' : 'but without'} an EIP-1193 request())`);
    else if (readFileSync(join(DIST, 'inject.js'), 'utf8').includes('eip6963:announceProvider')) {
      report('FAIL', "c. EIP-6963: inject.js has it, but nothing named Plum answered eip6963:requestProvider (reported, doesn't fail the run)", [`providers there: ${JSON.stringify(await dapp.evaluate(() => window.smoke.providers()))}`]);
    } else report('----', 'c. EIP-6963: not present yet');
  });

  // d. the welcome window plum opens on install when there's no wallet (plum opens that page itself, so the 60 fps
  // cap can't go in first: it's checked and closed)
  await attempt('d.', async () => {
    const WELCOME = `${EXT}popup.html?window=1`;
    let welcome = null;
    for (let i = 0; i < 20 && !welcome; i++) {
      welcome = [...created, ...browser.targets()].find((t) => t.url() === WELCOME) ?? null;
      if (!welcome) await sleep(250);
    }
    if (!welcome) {
      const pages = created.filter((t) => t.type() === 'page').map((t) => t.url());
      report('FAIL', "d. installing with no wallet opened no popup.html?window=1 (reported, doesn't fail the run)", [`pages opened: ${pages.join(', ') || 'none'}`]);
      return;
    }
    const page = await welcome.page().catch(() => null);
    const win = page && (await page.evaluate(() => chrome.windows.getCurrent()).catch(() => null));
    pass(`d. installing with no wallet opened popup.html?window=1${win ? ` in a ${win.type} window (${win.width}x${win.height})` : ''}`);
    await page?.close().catch(() => {});
  }, false);

  // a, again: anything the service worker logged while the other checks ran (given a moment to arrive)
  if (sw) {
    await sleep(500);
    const later = swErrors.filter((e) => e.phase === 'later').map((e) => e.text);
    if (later.length) fail(`a. the service worker logged ${later.length} error(s) during checks b to d`, later);
    else pass('a. the service worker logged no errors during checks b to d');
  }
} catch (e) {
  fail(`the run stopped: ${e.message.split('\n')[0]}`);
} finally {
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
}
console.log(failures ? `\nsmoke: ${failures} failed` : '\nsmoke: passed');
process.exit(failures ? 1 : 0);

