// Ledgers in plum's pages: the device drawn in characters (its screen shows what yours should be showing: the PIN, the
// app to open, the review), what plum is waiting for in plain words, and adding a Ledger from the accounts screen.
// Adding one happens in a window of its own: Chromium asks which USB device to share in a dialog that would close the
// toolbar popup. Firefox has no WebHID at all, so there plum says so instead.
import { ext } from '../shared/ext.js';
import { prettyAmount, short } from '../shared/format.js';
import { call } from './api.js';
import { busyButton, h, mount } from './dom.js';
import { ctx, errLine, field, forget, go, screen, show, showErr } from './app.js';
import { CHAIN, CHAIN_ORDER, actions, box, iconPicker, kv, spinner } from './parts.js';

const VENDOR = 0x2c97;
export const APP = { sol: 'Solana', eth: 'Ethereum', btc: 'Bitcoin' };
export const hidAvailable = () => typeof navigator !== 'undefined' && !!navigator.hid;

/** Ask the browser to let plum use a Ledger (it shows its own list of USB devices). Only from a click. */
export async function pickDevice() {
  if (!hidAvailable()) return false;
  const got = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR }] });
  return got.length > 0;
}

const hasGranted = async () => hidAvailable() && (await navigator.hid.getDevices()).some((d) => d.vendorId === VENDOR);

/* ------------------------------------------------------------ the device, typed */

const INNER = 24;
const TONE = {
  confirm: 'hw-go', ok: 'hw-go',
  connect: 'hw-wait', locked: 'hw-wait', 'open-app': 'hw-wait', 'wrong-app': 'hw-wait', 'blind-sign': 'hw-wait', 'old-app': 'hw-wait', 'not-installed': 'hw-wait', timeout: 'hw-wait',
  rejected: 'hw-no', mismatch: 'hw-no', refused: 'hw-no', 'too-large': 'hw-no', error: 'hw-no', unsupported: 'hw-no', busy: '', cancelled: '',
};
const WAITING = new Set(['busy', 'connect', 'locked', 'open-app', 'wrong-app', 'confirm']);

/** What your device's screen shows (or should), for each state. */
function screenWords(state, app) {
  return {
    connect: '', locked: 'PIN  _ _ _ _', 'open-app': `<  ${app ?? 'app'}  >`, 'wrong-app': `<  ${app ?? 'app'}  >`,
    confirm: 'review it  >', ok: 'it matches', rejected: 'rejected', mismatch: 'another ledger?',
    'blind-sign': 'settings  >', 'old-app': `update ${app ?? 'the app'}`, 'not-installed': `install ${app ?? 'the app'}`,
    refused: "can't sign this", 'too-large': 'too large', timeout: '. . .', error: '?', unsupported: '',
  }[state] ?? (app ? `${app} is ready` : 'ledger');
}

/** The device in characters, at the text's size: its frame, its two buttons (lit when it wants both pressed), its
 * screen's words, and the cable when it's waiting to be plugged in. */
export function deviceArt(words, { lit = false, cable = false, tone = '' } = {}) {
  const text = String(words).slice(0, INNER - 2);
  const left = Math.floor((INNER - text.length) / 2);
  const shown = ' '.repeat(left) + text + ' '.repeat(INNER - text.length - left);
  const f = (s) => h('span', { class: 'hw-f' }, s);
  const b = () => h('span', { class: lit ? 'hw-b lit' : 'hw-b' }, '[]');
  return h('pre', { class: `hw-art ${tone}`.trim(), 'aria-hidden': 'true' },
    f(' .-'), b(), f('-'.repeat(INNER - 2)), b(), f('-.'), '\n',
    f(` | .${'-'.repeat(INNER)}. |`), '\n',
    f(' | |'), h('span', { class: 'hw-s' }, shown), f('| |'), cable ? h('span', { class: 'hw-c' }, '=~~~') : f('='), '\n',
    f(` | '${'-'.repeat(INNER)}' |`), '\n',
    f(` '${'-'.repeat(INNER + 4)}'`));
}

/**
 * The device's state while plum works with it: the drawing, what it's waiting for in words, and, when plum can't find
 * it, a way to let plum use it. watch() follows the background while a call is out; failed(e) draws a Ledger error
 * that call threw (and says whether it was one).
 */
export function deviceBox(app, { title = 'your ledger', hidden = false, text = null } = {}) {
  const side = h('span', { class: 'hw-spin' });
  const art = h('div', { class: 'hw-art-box' });
  const line = h('p', { class: 'hw-line' });
  const find = h('button', { class: 'btn-go btn-sm', type: 'button', hidden: true }, 'let plum use it ->');
  find.addEventListener('click', () => { pickDevice().catch(() => {}); });
  const node = box(title, { tone: 'soft', side, className: 'hw-box' }, art, line, find, text);
  // (`hidden`: only once plum is working with the device, or has something to say about it)
  node.hidden = hidden;
  let timer = null;
  const paint = (s) => {
    const state = s?.state ?? 'idle';
    mount(art, deviceArt(screenWords(state, s?.app ?? app), { lit: state === 'confirm', cable: state === 'connect', tone: TONE[state] ?? '' }));
    line.textContent = s?.message || '';
    line.className = `hw-line ${TONE[state] ?? ''}`.trim();
    line.hidden = !line.textContent;
    find.hidden = !(state === 'connect' && hidAvailable());
    mount(side, WAITING.has(state) && timer ? spinner() : null);
  };
  const stop = () => { clearInterval(timer); timer = null; };
  const watch = () => {
    stop();
    node.hidden = false;
    const tick = async () => {
      if (!node.isConnected) { stop(); return; }
      try { const s = await call('ledger.status'); if (timer) paint(s); } catch { /* the next tick */ }
    };
    timer = setInterval(tick, 400);
    paint({ state: 'busy', app });
    tick();
  };
  paint({ state: 'idle', app });
  return {
    node, paint, watch, stop,
    failed(e) {
      stop();
      const code = String(e?.code ?? '');
      if (!code.startsWith('ledger-')) { paint({ state: 'idle', app }); return false; }
      node.hidden = false;
      paint({ state: code.slice(7), message: e.message, app });
      return true;
    },
  };
}

/** Firefox, or any browser without WebHID: no Ledger here, in plain words. */
export const noHid = () => box('ledger', { tone: 'soft' },
  h('p', null, "this browser can't reach USB devices (Firefox has no WebHID), so plum can't talk to a Ledger here."),
  h('p', { class: 'dim' }, 'Ledgers work in plum on Chrome, Brave, Edge and Opera.'));

/** In the approval window: what happens on the device for this request (and typed data's two hashes). */
export function ledgerNote(view) {
  const l = view.ledger;
  return box('signed on your ledger', { tone: 'soft' },
    l.note ? h('p', null, l.note) : null,
    l.hashes ? h('div', { class: 'kvs' }, kv('domain hash', short(l.hashes.domain, 10)), l.hashes.message ? kv('message hash', short(l.hashes.message, 10)) : null) : null);
}

/** Has the wallet you're in a Ledger behind it? */
export const isLedgerWallet = (w) => w?.scheme === 'ledger';

/** "check it on your ledger": the device shows the address too, to compare with the one here. */
export function checkOnLedger(chain, address) {
  const device = deviceBox(APP[chain], { hidden: true });
  const err = errLine();
  const btn = h('button', { class: 'btn btn-sm', type: 'button', dataset: { busyText: 'waiting for your ledger' } }, 'check it on your ledger');
  busyButton(btn, async () => {
    err.hidden = true;
    device.watch();
    try {
      await call('ledger.show', { chain, address });
      device.stop();
      device.paint({ state: 'ok', message: 'your Ledger showed this same address, and you confirmed it there.', app: APP[chain] });
    } catch (e) { if (!device.failed(e)) showErr(err, e); }
  });
  return h('div', { class: 'stack tight hw-check' }, btn, device.node, err);
}

/* ------------------------------------------------------------ adding a Ledger */

/** Add a Ledger's wallets, or with `account` more wallets from a Ledger you added before. */
export function addLedger({ account = null } = {}) {
  if (!hidAvailable()) { show(...screen('connect a ledger', () => go.accounts(), noHid())); return; }
  if (!document.documentElement.classList.contains('window')) {
    // the device dialog would close the toolbar popup: plum carries on in a window of its own
    const url = ext().runtime.getURL(`popup.html?window=1&ledger=${encodeURIComponent(account ?? 'new')}`);
    ext().windows.create({ url, type: 'popup', width: 420, height: 680 }).then(() => window.close(), () => connectStep({ account }));
    return;
  }
  connectStep({ account });
}

/** Step 1: which chains, then the device. */
function connectStep({ account = null, chains = ['sol', 'eth', 'btc'] } = {}) {
  const picked = new Set(chains);
  const acct = account ? ctx.S.accounts.find((a) => a.id === account) : null;
  const toggles = CHAIN_ORDER.map((c) => {
    const t = h('button', { class: `toggle ${picked.has(c) ? 'on' : ''}`, type: 'button', 'aria-pressed': String(picked.has(c)) }, CHAIN[c].name, h('span', { class: 'dim' }, `the ${APP[c]} app`));
    t.addEventListener('click', () => {
      if (picked.has(c)) picked.delete(c); else picked.add(c);
      t.classList.toggle('on', picked.has(c));
      t.setAttribute('aria-pressed', String(picked.has(c)));
    });
    return t;
  });
  const device = deviceBox(null, {
    text: [
      h('p', null, 'plug in your Ledger and unlock it. plum reads its addresses here; its keys never leave the device, and everything it signs you approve twice: in plum, then on the Ledger.'),
      h('p', { class: 'dim' }, 'plum opens each app on the device for you when the Ledger lets it; otherwise open it yourself when plum says so.'),
    ],
  });
  const err = errLine();
  const next = h('button', { class: 'btn-go', type: 'button', dataset: { busyText: 'reading your ledger' } }, 'read my ledger ->');
  busyButton(next, async () => {
    err.hidden = true;
    const want = CHAIN_ORDER.filter((c) => picked.has(c));
    if (!want.length) { showErr(err, new Error('pick at least one chain')); return; }
    try {
      // the browser asks which device only from a click, so this comes first
      if (!(await hasGranted())) await pickDevice();
    } catch { /* closed the browser's list: plum waits for the device below */ }
    device.watch();
    try {
      const found = await call('ledger.scan', { chains: want, account });
      device.stop();
      pickStep({ account, chains: want, found });
    } catch (e) { if (!device.failed(e)) showErr(err, e); }
  });
  show(...screen(acct ? `more from ${acct.name}` : 'connect a ledger', 'step 1 of 2',
    device.node,
    field('chains', h('div', { class: 'stack tight' }, toggles)),
    err, actions(() => go.accounts(), next)));
}

/** A row's holdings, the way the phrase import shows them. */
function holdings(r) {
  const parts = CHAIN_ORDER.filter((c) => r.chains[c]?.used).map((c) => `${prettyAmount(BigInt(r.chains[c].amount ?? 0), CHAIN[c].decimals, { sig: 4 })} ${CHAIN[c].ticker}`);
  if (parts.length) return parts.join(' · ');
  return r.unknown ? '?' : 'empty';
}

/** Step 2: which wallets, then a name and an icon. */
function pickStep({ account, chains, found }) {
  const rows = found.rows;
  const chosen = new Set(rows.filter((r) => r.used && !r.added).map((r) => r.key));
  if (!chosen.size) { const first = rows.find((r) => !r.added); if (first) chosen.add(first.key); }
  const list = rows.map((r) => {
    const first = CHAIN_ORDER.map((c) => r.chains[c]?.address).find(Boolean);
    const label = r.layout === 'live' ? `live ${r.index + 1}` : `wallet ${r.index + 1}`;
    const t = h('button', { class: `toggle acct-pick ${chosen.has(r.key) ? 'on' : ''}`, type: 'button', disabled: r.added, 'aria-pressed': String(chosen.has(r.key)), title: CHAIN_ORDER.filter((c) => r.chains[c]).map((c) => r.chains[c].path).join('  ') },
      h('span', { class: 'pk-l' }, h('b', null, label), ' ', h('span', { class: 'dim' }, short(first, 4)), r.layout === 'live' ? h('span', { class: 'dim' }, '  ledger live') : null),
      h('span', { class: `pk-r ${r.used ? 't-go' : 'dim'}` }, r.added ? 'already in plum' : holdings(r)));
    t.addEventListener('click', () => {
      if (r.added) return;
      if (chosen.has(r.key)) chosen.delete(r.key); else chosen.add(r.key);
      t.classList.toggle('on', chosen.has(r.key));
      t.setAttribute('aria-pressed', String(chosen.has(r.key)));
    });
    return t;
  });
  const used = rows.filter((r) => r.used && !r.added).length;
  const name = h('input', { class: 'input', maxlength: '20', placeholder: 'a name (optional)', autocomplete: 'off', spellcheck: 'false' });
  const icon = iconPicker(null);
  const err = errLine();
  const next = h('button', { class: 'btn-go', type: 'button', dataset: { busyText: 'adding' } }, 'add ->');
  busyButton(next, async () => {
    err.hidden = true;
    try {
      const keys = [...chosen];
      if (!keys.length) throw new Error('pick at least one wallet');
      ctx.S = await call('ledger.add', { id: found.id, keys, name: name.value.trim(), icon: icon.value() });
      forget();
      go.home();
    } catch (e) { showErr(err, e); }
  });
  show(...screen('its wallets', 'step 2 of 2',
    icon.node,
    field('name', name),
    h('div', { class: 'stack tight' },
      h('p', { class: 'dim' }, used ? `${used} wallet${used === 1 ? '' : 's'} with funds or history, picked. Add or remove any.` : 'nothing used yet: wallet 1 is picked.'),
      h('div', { class: 'picks' }, list)),
    h('p', { class: 'fine' }, `read from your Ledger on ${chains.map((c) => CHAIN[c].name).join(', ')}. "live" wallets are on Ledger Live's paths.`),
    err, actions(() => connectStep({ account, chains }), next)));
}

/** Where the popup goes when it was opened to add a Ledger (?ledger=new, or an account's id). */
export function ledgerFromUrl() {
  const p = new URLSearchParams(location.search).get('ledger');
  if (!p) return false;
  addLedger({ account: p === 'new' ? null : p });
  return true;
}
