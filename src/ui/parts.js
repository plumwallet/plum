// Pieces every plum page uses: typed boxes, key-value lines, the preview of a transaction, warnings.
import { prettyAmount, short } from '../shared/format.js';
import { ASK, DEFAULT_ICON, ICON_IDS, ICONS, PALETTE } from '../shared/icons.js';
import { h } from './dom.js';

/** A typed box with a '# TITLE' head: +---+ | +---+ */
export function box(title, { tone = 'soft', side = null, className = '' } = {}, ...children) {
  return h('section', { class: `box ${tone} ${className}`.trim() },
    title ? h('div', { class: 'box-head' }, h('h3', null, title), side) : null,
    ...children);
}

/** plum's one loading sign: a character turning | / - \ in place. */
export const spinner = () => h('span', { class: 'spin', 'aria-hidden': 'true' });

/** A dashed rule between the parts of a box. */
export const rule = () => h('div', { class: 'rule', 'aria-hidden': 'true' });

/**
 * Something you can copy: its text and a [copy] tag, in one button, the only place the pointer turns into a hand. A
 * click copies `text` (which can be longer than what's shown) and the tag says [copied] for a moment.
 */
export function copyable(text, shown = text, { title = 'copy' } = {}) {
  const tag = h('span', { class: 'cp-tag' }, 'copy');
  const b = h('button', { class: 'copy-me', type: 'button', title }, h('span', { class: 'cp-text' }, shown), tag);
  let timer = null;
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    b.classList.add('done');
    tag.textContent = 'copied';
    clearTimeout(timer);
    timer = setTimeout(() => { b.classList.remove('done'); tag.textContent = 'copy'; }, 1400);
  });
  return b;
}

/** A way back: [ back ] (or cancel, reject) in red brackets. */
export const backButton = (onclick, label = 'back') => h('button', { class: 'btn no', type: 'button', onclick }, label);

/** The answers at the foot of a box or screen: the way back on the left, the way on (a .btn-go) on the right. */
export const actions = (back, go) => h('div', { class: 'actions' }, back ? backButton(back) : h('span'), go);

/** A password (or private key) field Firefox's password manager leaves alone: a plain text input drawn as `*`s, so no
 * "manage passwords" or "use a generated password" pops up over it (a Firefox too old to draw them falls back to a
 * real password field). [ show ] reveals what's typed; a line warns while caps lock is on. Any text goes, blank
 * included. A hidden one keeps its text off the clipboard, as a password field does. { node, input } */
export function secretField({ placeholder = '', caps = true } = {}) {
  const drawn = typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc');
  const input = h('input', { class: 'input masked', type: drawn ? 'text' : 'password', placeholder, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
  const eye = h('button', { class: 'mini', type: 'button', title: 'show what you typed' }, 'show');
  const capsLine = caps ? h('div', { class: 'caps-on', hidden: true }, 'caps lock is on') : null;
  let shown = false;
  eye.addEventListener('click', () => {
    shown = !shown;
    input.classList.toggle('masked', !shown);
    if (!drawn) input.type = shown ? 'text' : 'password';
    eye.textContent = shown ? 'hide' : 'show';
    eye.title = shown ? 'hide it again' : 'show what you typed';
  });
  for (const type of ['copy', 'cut']) input.addEventListener(type, (e) => { if (!shown) e.preventDefault(); });
  if (capsLine) {
    for (const type of ['keydown', 'keyup']) input.addEventListener(type, (e) => { capsLine.hidden = !e.getModifierState?.('CapsLock'); });
    input.addEventListener('blur', () => { capsLine.hidden = true; });
  }
  return { node: h('div', { class: 'secret-field' }, h('div', { class: 'input-group' }, input, h('span', { class: 'suffix-btn' }, eye)), capsLine), input };
}

/** An account's icon, drawn in its colours: 'big' (home, at the text's size), 'pick' (the picker's square), 'tiny'
 * (beside a name). One span per run of a colour; the gaps stay empty, so the page's dark shows through them. */
export function iconArt(id, size = 'tiny') {
  const icon = ICONS[id] ?? ICONS[DEFAULT_ICON];
  const line = (text, paint) => {
    const runs = [];
    let run = '', colour = null;
    const flush = () => {
      if (run) runs.push(colour ? h('span', { vars: { color: PALETTE[colour] } }, run) : run);
      run = '';
    };
    for (let c = 0; c < text.length; c++) {
      const k = text[c] === ' ' ? colour : paint[c];
      if (k !== colour) { flush(); colour = k; }
      run += text[c];
    }
    flush();
    return runs;
  };
  return h('pre', { class: `icon-art ${size}`, 'aria-hidden': 'true', vars: shifted(icon) }, icon.art.map((text, r) => [r ? '\n' : null, line(text, icon.paint[r])]));
}
/** An icon's nudge (built from its characters' ink), so what's drawn sits in the middle of its square, not its box. */
const shifted = ({ shift: [x, y] }) => ({ '--dx': `${x}em`, '--dy': `${y}em` });

/** What the icon square shows until an icon is picked: a typed question mark in the icons' own 15 x 9 box (ask.txt),
 * centred by its ink like the icons. Strokes and fill are coloured by CSS (.ask-l, .ask-f), grey until the square is
 * pointed at, then plum. */
const askArt = () => h('pre', { class: 'icon-art big ask', 'aria-hidden': 'true', vars: shifted(ASK) },
  ASK.art.map((line, r) => [r ? '\n' : null, line.split(/(#+)/).filter(Boolean).map((run) => h('span', { class: run[0] === '#' ? 'ask-f' : 'ask-l' }, run))]));

/** The account's icon, picked from a typed square at the top of a form: a question mark until one is picked. A click
 * lays every icon out under it, in the place of the rest of the form (its fields and answers step aside, so nothing is
 * pushed down); a pick folds them away, brings the form back and pops the chosen icon into the square, big.
 * { node, value() }: value() is the picked id, or null for none (the account then wears plum's own). */
export function iconPicker(current = null, onPick = null) {
  let chosen = ICONS[current] ? current : null;
  const face = h('span', { class: 'face-show' });
  const square = h('button', { class: 'face-square', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, face);
  const cap = h('span', { class: 'face-cap' });
  const cells = ICON_IDS.map((id, i) => h('button', { class: 'face-pick', type: 'button', role: 'radio', title: id, 'aria-label': id, vars: { '--i': String(i) } }, iconArt(id, 'pick')));
  const grid = h('div', { class: 'faces', role: 'radiogroup', 'aria-label': 'icons' }, cells);
  const drop = h('div', { class: 'face-drop' }, grid);
  const node = h('div', { class: 'face' }, square, cap, drop);

  const show = (pop) => {
    face.replaceChildren(chosen ? iconArt(chosen, 'big') : askArt());
    square.classList.toggle('set', !!chosen);
    square.setAttribute('aria-label', chosen ? `icon: ${chosen}, click to change it` : 'pick an icon');
    cap.textContent = chosen ?? 'pick an icon';
    cells.forEach((c, k) => { c.classList.toggle('on', ICON_IDS[k] === chosen); c.setAttribute('aria-checked', String(ICON_IDS[k] === chosen)); });
    if (pop) { face.classList.remove('pop'); void face.offsetWidth; face.classList.add('pop'); }
  };
  // the form the square sits in (a box, a screen, an account's tools): its other parts step aside while picking
  const open = (yes) => {
    const form = node.parentElement;
    node.classList.toggle('open', yes);
    form?.classList.toggle('picking', yes);
    if (!yes && form) { form.classList.add('back-in'); setTimeout(() => form.classList.remove('back-in'), 400); }
    square.setAttribute('aria-expanded', String(yes));
    drop.inert = !yes;
    if (yes) (cells[ICON_IDS.indexOf(chosen)] ?? cells[0]).focus({ preventScroll: true });
  };
  square.addEventListener('click', () => open(!node.classList.contains('open')));
  cells.forEach((cell, i) => cell.addEventListener('click', () => {
    chosen = ICON_IDS[i];
    show(true);
    open(false);
    square.focus({ preventScroll: true });
    onPick?.(chosen);
  }));
  // in the open grid the arrows move between icons and Escape folds it away
  grid.addEventListener('keydown', (e) => {
    const at = cells.indexOf(document.activeElement);
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, ArrowUp: at - cols, ArrowDown: at + cols, Home: 0, End: cells.length - 1 }[e.key];
    if (e.key === 'Escape') { e.preventDefault(); open(false); square.focus(); }
    else if (to != null && at >= 0) { e.preventDefault(); cells[Math.max(0, Math.min(cells.length - 1, to))].focus(); }
  });
  show(false);
  drop.inert = true;
  return { node, value: () => chosen };
}

/** The other ways in, under "create a new wallet": a wallet you already have, two square tiles side by side. */
export function haveOne({ phrase, key }) {
  const opt = (label, hint, onclick) => h('button', { class: 'opt', type: 'button', onclick },
    h('span', { class: 'lb' }, label), h('span', { class: 'ht' }, hint));
  return [
    h('div', { class: 'or' }, 'already have a wallet?'),
    h('div', { class: 'opts' }, opt('recovery phrase', '12 or 24 words', phrase), opt('private key', 'one wallet', key)),
  ];
}

/** The chains a wallet lives on, in the order plum shows them. */
export const CHAIN = {
  sol: { id: 'sol', name: 'solana', title: 'Solana', ticker: 'SOL', decimals: 9, hint: 'a Solana address', explorer: 'solscan' },
  eth: { id: 'eth', name: 'ethereum', title: 'Ethereum', ticker: 'ETH', decimals: 18, hint: 'an Ethereum address (0x...)', explorer: 'etherscan' },
  btc: { id: 'btc', name: 'bitcoin', title: 'Bitcoin', ticker: 'BTC', decimals: 8, hint: 'a Bitcoin address (bc1...)', explorer: 'mempool' },
};
export const CHAIN_ORDER = ['sol', 'eth', 'btc'];
/** A wallet's chains, in plum's order. */
export const chainsOf = (w) => CHAIN_ORDER.filter((c) => w?.chains?.[c]?.address);

/** A row of choices, the chosen one in brackets: [[value, label], ...]. */
export function seg(choices, current, onPick, { label = null } = {}) {
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label ?? undefined });
  const buttons = choices.map(([v, text]) => {
    const b = h('button', { role: 'radio', type: 'button', class: v === current ? 'on' : '', 'aria-checked': String(v === current) }, text);
    b.addEventListener('click', () => {
      for (const x of buttons) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }
      onPick(v);
    });
    return b;
  });
  el.append(...buttons);
  return el;
}

export const kv = (label, value, cls = '') => h('div', { class: `kv ${cls}`.trim() }, h('span', null, label), h('span', null, value));

export const chip = (text, tone = '') => h('span', { class: `chip ${tone}`.trim() }, text);

/** Which network plum is on, but only when it's a test one (devnet, testnet, localnet): the main one goes unsaid. */
export function netChip(network) {
  if (network === 'mainnet') return null;
  return h('span', { class: `net ${network}`, title: `plum is on ${network}` }, network);
}

/** SOL's mark, typed: Solana's three bars, each character in Solana's own gradient (its logo's stops), purple at the
 * bottom left to green at the top right. Never a picture. */
const SOL_BARS = ['/###/', '\\###\\', '/###/'];
const SOL_STOPS = [[0.08, 0x9945ff], [0.3, 0x8752f3], [0.5, 0x5497d5], [0.6, 0x43b4ca], [0.72, 0x28e0b9], [0.97, 0x19fb9b]];
/** A gradient's colour at u, from 0 to 1. */
function stopColour(stops, u) {
  const next = stops.findIndex(([at]) => u <= at), i = next < 0 ? stops.length - 1 : Math.max(1, next);
  const [a, from] = stops[i - 1], [b, to] = stops[i], k = Math.min(1, Math.max(0, (u - a) / (b - a)));
  const mix = (shift) => Math.round(((from >> shift) & 255) * (1 - k) + ((to >> shift) & 255) * k);
  return `rgb(${mix(16)} ${mix(8)} ${mix(0)})`;
}
const SOL_MARK = SOL_BARS.map((bar, r) => [...bar].map((ch, c) => [ch, stopColour(SOL_STOPS, (1 - r / (SOL_BARS.length - 1) + c / (bar.length - 1)) / 2)]));

/** ETH's mark, typed: Ethereum's diamond, its facets lit from the top left like the logo's, in Ethereum's own blue. */
const ETH_ART = [' /#\\ ', '<###>', ' \\#/ '];
const ETH_PAINT = [' aab ', 'accdd', ' cee '];
const ETH_INKS = { a: '#d6dcfa', b: '#9aa9f3', c: '#7f93ef', d: '#627eea', e: '#4c63c8' };
const ETH_MARK = ETH_ART.map((row, r) => [...row].map((ch, c) => [ch, ETH_INKS[ETH_PAINT[r][c]] ?? null]));

/** BTC's mark, typed: a B with the two strokes of the bitcoin sign doubled through its top and bottom, in Bitcoin's
 * orange, lit from the top left like the ether mark. */
const BTC_BARS = ['||##\\', '|###<', '||##/'];
const BTC_STOPS = [[0, 0xffd08a], [0.35, 0xffad45], [0.6, 0xf7931a], [1, 0xb85f00]];
const BTC_MARK = BTC_BARS.map((bar, r) => [...bar].map((ch, c) => [ch, stopColour(BTC_STOPS, (r / (BTC_BARS.length - 1) + c / (bar.length - 1)) / 2)]));

/** POL's mark, typed: two hexagons joined at an edge (Polygon's link), in Polygon's own purple, lit from the left. */
const POL_ART = ['/#\\#\\', '|#|#|', '\\#/#/'];
const POL_PAINT = ['aabcc', 'aabcc', 'aabcc'];
const POL_INKS = { a: '#cbb6fb', b: '#a580f2', c: '#8a52ea' };
const POL_MARK = POL_ART.map((row, r) => [...row].map((ch, c) => [ch, POL_INKS[POL_PAINT[r][c]] ?? null]));

const MARKS = { sol: SOL_MARK, eth: ETH_MARK, btc: BTC_MARK, pol: POL_MARK };

/** A coin's typed mark, 5 characters by 3 lines at the text's size (SOL, ETH, BTC or POL). */
export function coinMark(chain) {
  const mark = MARKS[chain] ?? SOL_MARK;
  return h('pre', { class: 'sol-mark coin-mark', role: 'img', 'aria-label': CHAIN[chain]?.ticker ?? (chain === 'pol' ? 'POL' : 'SOL') },
    mark.map((row, r) => [r ? '\n' : null, row.map(([ch, colour]) => (colour ? h('span', { vars: { color: colour } }, ch) : ch))]));
}
export const solMark = () => coinMark('sol');

/** "+ 53.84 USDC" in green, "- 1.25 SOL" in red. */
export function deltaLine(delta, decimals, symbol, { usd } = {}) {
  const v = BigInt(delta);
  const up = v > 0n;
  return h('div', { class: `chg ${up ? 'up' : 'down'}` },
    h('span', { class: 'sign' }, up ? '+' : '-'),
    h('span', { class: 'amt' }, prettyAmount(up ? v : -v, decimals, { sig: 8 })),
    h('span', { class: 'sym' }, symbol),
    usd ? h('span', { class: 'usd' }, usd) : null);
}

const LEVEL = { danger: 'err', warn: 'hot', info: '' };

export function warnings(list) {
  if (!list?.length) return null;
  return h('div', { class: 'warns' }, list.map((w) => h('div', { class: `note ${LEVEL[w.level] ?? ''} lvl-${w.level}` }, w.text)));
}

/** Everything a transaction will do, from plum's preview (Solana's, Ethereum's or Bitcoin's). */
export function previewBlock(p, opts = {}) {
  if (p?.chain === 'eth') return evmPreviewBlock(p, opts);
  if (p?.chain === 'btc') return btcPreviewBlock(p, opts);
  return solPreviewBlock(p, opts);
}

/** What an Ethereum transaction changes: ETH and tokens in and out (simulated when the RPC can), approvals it gives,
 * its fee and what it calls. */
function evmPreviewBlock(p, { extra = [] } = {}) {
  const changes = (p.changes ?? []).map((c) => h('div', { class: 'chg-row' }, deltaLine(c.delta, c.decimals ?? 0, c.symbol), c.verified === false ? chip('unverified', 'hot') : null));
  const ok = p.sim?.ok;
  const side = ok === true ? chip('simulated', 'green') : ok === false ? chip('fails', 'hot') : chip('not simulated', 'hot');
  // amounts in the network's own coin (POL on Polygon), and the network named where the changes are
  const coin = p.net?.symbol ?? 'ETH';
  const where = (p.net?.title ?? 'Ethereum').toLowerCase();
  const eth = (wei) => `${prettyAmount(BigInt(wei), 18, { sig: 6 })} ${coin}`;
  return h('div', { class: 'preview' },
    box(p.net ? `what changes on ${where}` : 'what changes', { tone: ok === false ? 'red' : 'soft', side },
      ok === false ? h('p', { class: 't-red' }, p.sim.error ?? 'it fails') : changes.length ? changes : h('p', { class: 'dim' }, ok ? 'no change to your ETH or tokens (besides the fee)' : 'not known without a simulation')),
    warnings([...extra, ...(p.warnings ?? [])]),
    h('div', { class: 'kvs' },
      BigInt(p.call?.value ?? 0) > 0n ? kv('sends', eth(p.call.value)) : null,
      p.call?.name ? kv('calls', `${p.call.name} on ${short(p.call.to ?? 'a new contract', 6)}`) : p.call?.to ? kv('to', short(p.call.to, 6)) : null,
      p.fee ? kv(p.txs > 1 ? `network fees (${p.txs})` : 'network fee', `about ${eth(p.fee.est)}`) : null,
      p.fee ? kv('at most', eth(p.fee.max)) : null,
      kv('signers', p.txs > 1 ? '1 each (you)' : '1 (you)', 'good')),
    // where it goes, in full: a lookalike of an address you know stands out by its middle
    p.call?.to ? addressBlock(p.call.to) : null,
    h('details', { class: 'more' },
      h('summary', null, h('span', null, '-- details'), h('span', { class: 'dim' }, `${where} · ${p.call?.bytes ?? 0} bytes of data`)),
      h('div', { class: 'kvs' },
        p.call?.to ? kv('contract or address', short(p.call.to, 8)) : kv('creates', 'a contract'),
        BigInt(p.call?.value ?? 0) > 0n ? kv('sends', eth(p.call.value)) : null,
        p.fee ? kv('gas limit', BigInt(p.fee.gas).toLocaleString('en-US')) : null)));
}

/** What a Bitcoin send does: exactly what leaves (plum built it, nothing to simulate), the fee and its rate, the coins
 * it spends and the change that comes back. */
function btcPreviewBlock(p, { extra = [] } = {}) {
  const btc = (sats) => `${prettyAmount(BigInt(sats), 8, { sig: 8 })} BTC`;
  return h('div', { class: 'preview' },
    box('what changes', { tone: 'soft', side: chip('exact', 'green') },
      deltaLine(-BigInt(p.amount), 8, 'BTC sent'),
      deltaLine(-BigInt(p.fee), 8, 'BTC network fee')),
    warnings([...extra, ...(p.warnings ?? [])]),
    h('div', { class: 'kvs' },
      kv('fee rate', `${p.feeRate} sat/vB · ${p.vsize} vB`),
      kv('signers', '1 (you)', 'good'),
      kv('coins spent', p.taproot ? `${p.inputs} (${p.taproot} from bc1p)` : String(p.inputs)),
      kv('change back to you', BigInt(p.change) > 0n ? btc(p.change) : 'none')));
}

function solPreviewBlock(p, { extra = [], index = null, count = 1 } = {}) {
  if (p.error) return h('div', { class: 'note err' }, `plum can't preview this transaction: ${p.error}`);
  const changes = [];
  const sol = BigInt(p.sol);
  if (sol !== 0n) changes.push(deltaLine(sol, 9, 'SOL'));
  for (const t of p.tokens) {
    // an unverified token is named by its address too: anyone can call a token "USDC"; an NFT by its name and address
    const label = t.nft?.name ? `${t.nft.name} (${short(t.mint)})` : t.symbol && t.verified ? t.symbol : t.symbol ? `${t.symbol} (${short(t.mint)})` : short(t.mint);
    changes.push(h('div', { class: 'chg-row' }, deltaLine(t.delta, t.decimals, label), t.symbol && !t.verified ? chip('unverified', 'hot') : null));
  }
  const nothing = p.sim.ok && !changes.length;
  return h('div', { class: 'preview' },
    box(count > 1 ? `what changes (${index + 1} of ${count})` : 'what changes', { tone: p.sim.ok ? 'soft' : 'red', side: p.sim.ok ? chip('simulated', 'green') : chip('failed', 'hot') },
      p.sim.ok
        ? (nothing ? h('p', { class: 'dim' }, 'no change to your SOL or tokens (besides the fee)') : changes)
        : h('p', { class: 't-red' }, p.sim.error)),
    warnings([...extra, ...p.warnings]),
    h('div', { class: 'kvs' },
      kv('network fee', `${prettyAmount(BigInt(p.fee), 9, { sig: 9 })} SOL${p.youPayFee ? '' : ' (not you)'}`),
      kv('signers', p.required === 1 ? '1 (you)' : `${p.required} (you + ${p.required - 1})`, p.required === 1 ? 'good' : 'warn'),
      kv('programs', p.programs.map((x) => x.name ?? short(x.id)).join(', '))),
    details(p));
}

function details(p) {
  return h('details', { class: 'more' },
    h('summary', null, h('span', null, '-- details'), h('span', { class: 'dim' }, `${p.version === 'legacy' ? 'legacy' : `v${p.version}`} · ${p.size} bytes`)),
    h('div', { class: 'kvs' },
      kv('accounts', `${p.accounts} (${p.writable} writable)`),
      kv('fee payer', short(p.feePayer, 6)),
      kv('signers', p.signers.map((s) => short(s)).join(', ')),
      p.sim.units != null ? kv('compute used', p.sim.units.toLocaleString('en-US')) : null,
      kv('priority fee', `${prettyAmount(BigInt(p.priority), 9, { sig: 9 })} SOL`),
      p.config ? kv('compute limit', (p.config.units ?? 0).toLocaleString('en-US')) : null,
      BigInt(p.wrappedSol ?? 0) !== 0n ? kv('wrapped SOL in that', `${prettyAmount(BigInt(p.wrappedSol), 9)} SOL`) : null),
    h('ol', { class: 'ixs' }, p.instructions.map((ix) => h('li', null, h('b', null, ix.name ?? short(ix.program, 6)), h('span', { class: 'dim' }, ` ${ix.accounts} accounts · ${ix.bytes} bytes`)))),
    p.sim.logs?.length ? h('pre', { class: 'logs' }, p.sim.logs.join('\n')) : null);
}

/** A site's standing: blocklisted, a lookalike, or fine. */
export function riskBanner(risk) {
  if (!risk?.level) return null;
  if (risk.level === 'blocked') {
    return h('div', { class: 'risk box red' },
      h('div', { class: 'risk-t' }, '[!!] phishing site'),
      h('p', null, `this site is on the phishing blocklist (${risk.match}). Sites like this drain wallets. Close it.`));
  }
  return h('div', { class: 'risk box hot' },
    h('div', { class: 'risk-t' }, '[!] lookalike'),
    h('p', null, `this site's name looks like ${risk.match}, but it isn't ${risk.match}. Check the address bar letter by letter.`));
}

/** An address split in fours, its ends lit, so a lookalike stands out. With `copy`, a click copies it (and the pointer
 * is a hand over it). */
export function addressBlock(address, { copy = false } = {}) {
  const groups = address.match(/.{1,4}/g);
  const parts = groups.map((g, i) => h('span', { class: i === 0 || i === groups.length - 1 ? 'end' : '' }, g));
  if (!copy) return h('div', { class: 'addr' }, parts);
  const b = h('button', { class: 'addr copy-me', type: 'button', title: 'copy the address' }, parts, h('span', { class: 'cp-tag' }, 'copy'));
  let timer = null;
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(address); } catch { return; }
    b.classList.add('done');
    b.lastChild.textContent = 'copied';
    clearTimeout(timer);
    timer = setTimeout(() => { b.classList.remove('done'); b.lastChild.textContent = 'copy'; }, 1400);
  });
  return b;
}
