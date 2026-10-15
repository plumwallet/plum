// The popup (380px wide). With no wallet yet, the welcome and every way in (flows.js), right here. Locked,
// the unlock. Then home: the wallet's card (its icon and name, what it holds on every chain in dollars, what you can
// do), its coins (SOL, ETH, BTC) in a box of their own and its tokens in theirs; send, receive, swap, history,
// accounts (accounts.js) and settings. Every unlocked screen keeps the wallet's box at the top while it scrolls.
// Opened with ?window=1 it's the same popup in a little window of its own (on install, or when a site asks first).
import { ago, formatUnits, parseUnits, prettyAmount, short, usd } from '../shared/format.js';
import { accountsScreen, secretReveal } from './accounts.js';
import { call, keepAlive } from './api.js';
import { active, accountOf, ctx, errLine, field, forget, go, header, redraw, refresh, root, screen, show, showErr } from './app.js';
import { logo } from './art.js';
import { busyButton, h, mount } from './dom.js';
import { btcAddressOf, btcReceivePick } from './btc.js';
import { evmRpcField, netTag, networkErrors, networkHoldings, networkCoins, networkRow } from './evm.js';
import { evmSwapScreen, swapNetSeg, swapNetwork } from './evm-swap.js';
import { backupLater, welcome } from './flows.js';
import { APP, checkOnLedger, deviceBox, isLedgerWallet, ledgerFromUrl } from './ledger.js';
import { CHAIN, actions, addressBlock, box, chainsOf, coinMark, iconArt, kv, previewBlock, rule, secretField, seg, spinner } from './parts.js';
import { qrAscii } from './qr.js';
import './scrollbar.js';
import { nftsScreen } from './nfts.js';
import { stakeScreen } from './stake.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// SOL itself (no mint) or wrapped SOL: known by its mint, never its name, so a token calling itself SOL gets no SOL mark
const isSol = (mint) => !mint || mint === WSOL;
if (new URLSearchParams(location.search).get('window')) document.documentElement.classList.add('window');

/* ------------------------------------------------------------ locked */

function unlock() {
  const pwF = secretField({ placeholder: 'your password' });
  const pw = pwF.input;
  const err = errLine();
  const next = h('button', { class: 'btn-go block lg', type: 'submit', dataset: { busyText: 'unlocking' } }, 'unlock ->');
  const form = h('form', { class: 'unlock-form' }, field('password', pwF.node), err, next);
  form.addEventListener('submit', (e) => e.preventDefault());
  busyButton(next, async () => {
    err.hidden = true;
    try {
      await call('unlock', { password: pw.value });
      pw.value = '';
      await refresh();
      home();
    } catch (e) {
      showErr(err, e);
      pw.select();
    }
  });
  const forgot = h('details', { class: 'more forgot' },
    h('summary', null, h('span', null, '-- forgot your password?')),
    h('p', { class: 'fine' }, "plum can't recover it: it never kept a copy. Reset plum, then bring your wallets back from their recovery phrases (or private keys)."),
    resetForm());
  show(h('div', { class: 'hero' }, logo()), box('unlock', { tone: 'soft' }, form), forgot);
  pw.focus();
}

async function lockNow() {
  await call('lock');
  await refresh();
  unlock();
}

function resetForm() {
  const input = h('input', { class: 'input', placeholder: 'type reset', spellcheck: 'false', autocomplete: 'off' });
  const err = errLine();
  const btn = h('button', { class: 'btn btn-sm danger', type: 'button' }, 'reset plum');
  busyButton(btn, async () => {
    try {
      await call('reset', { confirm: input.value.trim().toLowerCase() });
      await refresh();
      forget();
      welcome();
    } catch (e) { showErr(err, e); }
  });
  return h('div', { class: 'reset' }, h('p', { class: 't-red' }, 'this erases every key in plum from this computer. Without your recovery phrases or keys, the funds are gone for good.'), input, btn, err);
}

/* ------------------------------------------------------------ balances */

const balKey = (w, chain) => `${w.id}:${chain}`;
/** One chain's balances for the wallet you're in (the last ones at once if `cached`). */
async function readBalances(w, chain) {
  const b = await call('balances', { chain });
  ctx.bal.set(balKey(w, chain), b);
  return b;
}

/** What the wallet holds, as one list: its coins (SOL, ETH, BTC), then its tokens on every chain. */
function holdingsOf(w) {
  const coins = [], tokens = [];
  for (const c of chainsOf(w)) {
    const b = ctx.bal.get(balKey(w, c));
    if (!b) continue;
    coins.push({ chain: c, mint: null, symbol: CHAIN[c].ticker, name: CHAIN[c].name, amount: b.native.amount, decimals: b.native.decimals, price: b.native.price, usd: b.native.usd, verified: true });
    if (c === 'eth') coins.push(...networkHoldings(b));
    tokens.push(...b.tokens.map((t) => ({ ...t, chain: c })));
  }
  return { coins, tokens };
}

async function loadHoldings(w) {
  await Promise.all(chainsOf(w).map((c) => (ctx.bal.has(balKey(w, c)) ? null : readBalances(w, c).catch(() => null))));
  return holdingsOf(w);
}

/* ------------------------------------------------------------ home */

/** Home: the wallet's card (its icon, big, and its name; what it holds in dollars, on every chain; the four ways to
 * use it), then its coins in a box of their own and its tokens in theirs. Coming back here shows the last numbers at
 * once and reads fresh ones; [refresh] reads them again where they are, turning while it waits. */
function home() {
  const w = active();
  const chains = chainsOf(w);
  const bal = h('div', { class: 'bal' });
  const coins = h('div', { class: 'tks' });
  const list = h('div', { class: 'tks' });
  const warn = h('div', { hidden: true });
  const err = errLine();
  const again = h('button', { class: 'mini', type: 'button', title: 'read the balances again' }, 'refresh');
  const act = (label, onclick) => h('button', { class: 'btn act', type: 'button', onclick }, label);
  const card = h('section', { class: 'box soft card' },
    h('div', { class: 'me' }, iconArt(w.icon, 'big'), h('div', { class: 'me-name' }, w.name)),
    rule(),
    bal,
    rule(),
    h('nav', { class: 'acts' }, act('send', () => sendScreen()), act('receive', () => receiveScreen()), act('swap', () => swapScreen()), act('stake', () => stakeScreen()), act('nfts', () => nftsScreen()), act('history', () => historyScreen())));
  const waiting = ctx.S.pending
    ? h('div', { class: 'note hot' }, `${ctx.S.pending === 1 ? 'a site is' : `${ctx.S.pending} requests are`} waiting for your answer `,
      h('button', { class: 'mini', type: 'button', onclick: async () => { await call('approval.show'); window.close(); } }, 'open it'))
    : null;
  const unsaved = ctx.S.accounts.find((a) => a.backedUp === false);
  const reminder = unsaved
    ? h('div', { class: 'note hot' }, `${unsaved.name}'s recovery phrase isn't backed up yet `, h('button', { class: 'mini', type: 'button', onclick: () => backupLater(unsaved) }, 'back it up'))
    : null;
  show(header(), h('main', { class: 'screen home' },
    waiting, reminder, card, warn,
    box(null, { tone: 'soft', className: 'sol-box' }, coins),
    box('tokens', { tone: 'soft', side: again }, list), err));

  const reading = () => h('span', { class: 'dim', 'aria-label': 'reading' }, spinner());
  const failed = new Map();
  const paint = () => {
    const got = chains.map((c) => ctx.bal.get(balKey(w, c)));
    const ready = got.filter(Boolean);
    // the total: every chain's dollars, once each has answered (a chain that failed counts as unknown)
    const done = chains.every((c, i) => got[i] || failed.has(c));
    const priced = ready.length && ready.every((b) => b.native.price != null);
    const total = ready.reduce((n, b) => n + (b.native.usd ?? 0) + (b.networks ?? []).reduce((m, x) => m + (x.usd ?? 0), 0) + b.tokens.reduce((m, t) => m + (t.usd ?? 0), 0), 0);
    // today's move, weighted by what each coin is worth (the other Ethereum networks' coins too)
    const weights = ready.flatMap((b) => [b.native, ...(b.networks ?? [])]).filter((x) => x.usd && x.change24h != null);
    const worth = weights.reduce((n, x) => n + x.usd, 0);
    const change = worth ? weights.reduce((n, x) => n + x.change24h * x.usd, 0) / worth : null;
    if (!done) mount(bal, h('span', { class: 'bal-l' }, priced ? h('b', null, dollars(total)) : null, reading()));
    else if (priced) {
      mount(bal,
        h('span', { class: 'bal-l' }, h('b', null, dollars(total)), failed.size ? h('span', { class: 'dim' }, `${[...failed.keys()].map((c) => CHAIN[c].ticker).join(', ')} unknown`) : null),
        change != null ? h('span', { class: change >= 0 ? 't-go' : 't-red' }, `${change >= 0 ? '+' : ''}${change.toFixed(2)}% today`) : null);
    } else {
      const sol = ctx.bal.get(balKey(w, 'sol'));
      mount(bal, h('span', { class: 'bal-l' }, h('b', null, sol ? `${prettyAmount(BigInt(sol.native.amount), 9)} SOL` : '?')));
    }
    coins.replaceChildren(...chains.flatMap((c) => {
      const b = ctx.bal.get(balKey(w, c));
      // Ethereum's ETH, then the other networks' coins where there's something
      if (b) return [coinRow(c, b), ...networkCoins(b).map((n) => networkRow(n, sendScreen))];
      return h('div', { class: 'tk' }, coinMark(c), h('span', { class: 'tk-n' }, h('b', null, CHAIN[c].ticker), h('span', { class: 'dim' }, CHAIN[c].name)), h('span', { class: 'tk-v' }, failed.has(c) ? h('b', { class: 't-red', title: failed.get(c) }, '?') : h('b', null, spinner())));
    }));
    const tokens = ready.flatMap((b) => b.tokens.map((t) => ({ ...t, chain: b.chain }))).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    list.replaceChildren(...tokens.map((t) => tokenRow(t, chains.length > 1)));
    if (!tokens.length) list.append(done ? h('p', { class: 'dim empty' }, 'no tokens yet') : h('p', { class: 'empty' }, reading()));
    const sol = ctx.bal.get(balKey(w, 'sol'));
    warn.hidden = !sol?.hijacked;
    if (sol?.hijacked) warn.replaceChildren(h('div', { class: 'note err lvl-danger' }, `this wallet's Solana account was handed to a program (${short(sol.hijacked)}), the way drainers take wallets over. It can't send or pay fees any more. Don't send anything to it; move to a new wallet.`));
    const others = done ? networkErrors(ctx.bal.get(balKey(w, 'eth'))) : [];
    if ((failed.size || others.length) && done) showErr(err, [...[...failed].map(([c, m]) => `${CHAIN[c].name}: ${m}`), ...others].join(' · '));
    else err.hidden = true;
  };
  paint();
  const load = async () => {
    if (again.disabled) return;
    again.disabled = true;
    again.replaceChildren(spinner());
    failed.clear();
    await Promise.all(chains.map(async (c) => {
      try { await readBalances(w, c); } catch (e) { failed.set(c, e.message); }
      if (card.isConnected) paint();
    }));
    if (!card.isConnected) return;
    again.disabled = false;
    again.textContent = 'refresh';
    paint();
  };
  again.addEventListener('click', load);
  load();
}

const dollars = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** A coin in a line: its typed mark, ticker and name, amount and value (and coins still on their way). */
function coinRow(chain, b) {
  const pending = b.pending && BigInt(b.pending) !== 0n ? `${BigInt(b.pending) > 0n ? '+' : ''}${prettyAmount(BigInt(b.pending), 8)} on its way` : null;
  return h('button', { class: 'tk', type: 'button', title: `send ${CHAIN[chain].ticker}`, onclick: () => sendScreen({ chain, mint: null }) },
    coinMark(chain),
    h('span', { class: 'tk-n' }, h('b', null, CHAIN[chain].ticker), h('span', { class: 'dim' }, pending ?? CHAIN[chain].name)),
    h('span', { class: 'tk-v' }, h('b', null, prettyAmount(BigInt(b.native.amount), b.native.decimals)), h('span', { class: 'dim' }, usd(b.native.usd))));
}

/** A token in a line: no picture, just its ticker and name (and its chain, when the wallet has more than one), amount
 * and value. An unverified one shows its address: anyone can call a token "USDC". */
function tokenRow(t, tagged) {
  // a token on one of Ethereum's other networks always says which
  const where = tagged || (t.net && t.net !== 'ethereum') ? h('span', { class: 'chain-tag' }, ` ${t.net ? netTag(t.net) : t.chain}`) : null;
  return h('button', { class: 'tk plain', type: 'button', title: `send ${t.symbol ?? 'this token'}`, onclick: () => sendScreen({ chain: t.chain, mint: t.mint, net: t.net }) },
    h('span', { class: 'tk-n' }, h('b', null, t.symbol ?? short(t.mint)),
      t.symbol && !t.verified ? h('span', { class: 'dim' }, h('span', { class: 'unv' }, 'unverified '), short(t.mint), where) : h('span', { class: 'dim' }, t.name ?? short(t.mint, 6), where)),
    h('span', { class: 'tk-v' }, h('b', null, prettyAmount(BigInt(t.amount), t.decimals)), h('span', { class: 'dim' }, usd(t.usd))));
}

/* ------------------------------------------------------------ picking a coin or token */

/** Picking what to send: the coins in a box of their own, then the tokens in theirs (or what a search found), each a
 * plain line: no pictures, just the ticker and name, and what you hold. */
function picker(items, onPick, { title = 'pick a token', search = false, back = null, tagged = false } = {}) {
  const row = (t) => h('button', { class: t.mint == null || (t.chain === 'sol' && isSol(t.mint)) ? 'tk' : 'tk plain', type: 'button', onclick: () => onPick(t) },
    t.mint == null || (t.chain === 'sol' && isSol(t.mint)) ? coinMark(t.chain ?? 'sol') : null,
    h('span', { class: 'tk-n' }, h('b', null, t.symbol ?? short(t.mint)), h('span', { class: 'dim' }, t.verified === false ? h('span', { class: 'unv' }, 'unverified ') : null, t.name ?? short(t.mint ?? '', 6), (tagged || (t.net && t.net !== 'ethereum')) && t.mint ? h('span', { class: 'chain-tag' }, ` ${t.net ? netTag(t.net) : t.chain}`) : null)),
    h('span', { class: 'tk-v' }, t.amount != null ? h('b', null, prettyAmount(BigInt(t.amount), t.decimals)) : h('span', { class: 'dim' }, short(t.mint ?? 'SOL', 4))));
  const coinRows = h('div', { class: 'tks' });
  const results = h('div', { class: 'tks' });
  const showList = (list) => {
    coinRows.replaceChildren(...list.filter((t) => t.mint == null || (t.chain === 'sol' && isSol(t.mint))).map(row));
    const toks = list.filter((t) => !(t.mint == null || (t.chain === 'sol' && isSol(t.mint))));
    results.replaceChildren(...toks.map(row));
    if (!toks.length) results.append(h('p', { class: 'dim empty' }, 'no tokens'));
  };
  showList(items);
  let q = null;
  if (search) {
    let timer = null;
    q = h('input', { class: 'input', placeholder: 'search a name, ticker or paste a mint', spellcheck: 'false', autocomplete: 'off' });
    q.addEventListener('input', () => {
      clearTimeout(timer);
      const text = q.value.trim();
      if (!text) { showList(items); return; }
      timer = setTimeout(async () => {
        results.replaceChildren(h('p', { class: 'dim empty', 'aria-label': 'searching' }, spinner()));
        try {
          const found = await call('tokens.search', { query: text });
          showList(found.map((t) => ({ ...t, chain: 'sol', amount: null })));
          if (!found.length) results.replaceChildren(h('p', { class: 'dim empty' }, 'nothing found'));
        } catch (e) { results.replaceChildren(h('p', { class: 't-red' }, e.message)); }
      }, 350);
    });
  }
  return h('div', { class: 'stack' }, box(title, { tone: 'soft' }, q, coinRows), box('tokens', { tone: 'soft' }, results), back ? actions(back, null) : null);
}

/** The coin or token a form uses, as a typed button: its ticker and a caret, no picture. */
const tokenButton = (t, onclick) => h('button', { class: 'tok-btn', type: 'button', onclick }, h('b', null, t.symbol ?? short(t.mint)), t.net && t.net !== 'ethereum' ? h('span', { class: 'dim' }, netTag(t.net)) : null, h('span', { class: 'caret' }, 'v'));

/* ------------------------------------------------------------ send */

async function sendScreen({ chain = null, mint = null, net = null, to = '', amount = '', speed = 'normal' } = {}) {
  const w = active();
  let items;
  try {
    const { coins, tokens } = await loadHoldings(w);
    items = [...coins, ...tokens];
    if (!items.length) throw new Error("couldn't read what this wallet holds: try again");
  } catch (e) { show(...screen('send', () => home(), h('div', { class: 'note err' }, e.message))); return; }
  // (Ethereum's own coin and tokens may come with net 'ethereum' or none)
  const sameNet = (t) => (t.net ?? 'ethereum') === (net ?? 'ethereum');
  let token = items.find((t) => t.chain === (chain ?? t.chain) && (t.mint ?? null) === (mint ?? null) && (t.chain !== 'eth' || sameNet(t))) ?? items[0];
  let btcSpeed = speed;
  const toIn = h('input', { class: 'input', spellcheck: 'false', autocomplete: 'off', value: to });
  const amtIn = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: amount });
  const worth = h('div', { class: 'hint' });
  const err = errLine();
  const tokSlot = h('span');
  const have = h('span', { class: 'dim' });
  const speedSlot = h('div');
  const paint = () => {
    tokSlot.replaceChildren(tokenButton(token, openPicker));
    have.textContent = `have ${prettyAmount(BigInt(token.amount), token.decimals)}`;
    toIn.placeholder = CHAIN[token.chain].hint;
    let n = NaN;
    try { n = Number(formatUnits(parseUnits(amtIn.value || '0', token.decimals), token.decimals)); } catch { /* typing */ }
    worth.textContent = token.price && n ? `about ${usd(n * token.price)}` : '';
    mount(speedSlot, token.chain === 'btc' ? field('speed', seg([['slow', 'slow'], ['normal', 'normal'], ['fast', 'fast']], btcSpeed, (v) => { btcSpeed = v; }, { label: 'how fast' }), 'the faster, the bigger the fee') : null);
  };
  const form = h('div', { class: 'stack' });
  const max = h('button', { class: 'mini', type: 'button' }, 'max');
  busyButton(max, async () => {
    err.hidden = true;
    try {
      if (token.chain === 'sol') {
        let raw = BigInt(token.amount);
        if (!token.mint) raw = raw > 20_000n ? raw - 20_000n : 0n; // leave the fee
        amtIn.value = formatUnits(raw, token.decimals);
      } else {
        amtIn.value = await call('send.max', { chain: token.chain, net: token.net ?? null, token: token.mint, to: toIn.value.trim() || null, speed: btcSpeed });
      }
      paint();
    } catch (e) { showErr(err, e); }
  });
  const paste = h('button', { class: 'mini', type: 'button', onclick: async () => { try { toIn.value = (await navigator.clipboard.readText()).trim(); } catch { toIn.focus(); } } }, 'paste');
  function openPicker() {
    mount(form, picker(items, (t) => { token = t; mount(form, ...fields()); paint(); }, { back: () => { mount(form, ...fields()); paint(); }, tagged: chainsOf(w).length > 1 }));
  }
  amtIn.addEventListener('input', paint);
  const next = h('button', { class: 'btn-go block', type: 'button', dataset: { busyText: 'simulating' } }, 'review ->');
  busyButton(next, async () => {
    err.hidden = true;
    const asked = { chain: token.chain, mint: token.mint, net: token.net ?? null, to: toIn.value.trim(), amount: amtIn.value.trim(), speed: btcSpeed };
    try {
      const prep = await call('send.prepare', { chain: asked.chain, net: asked.net, token: asked.mint, to: asked.to, amount: asked.amount, speed: asked.speed });
      review(prep, { kind: 'send', back: () => sendScreen(asked) });
    } catch (e) { showErr(err, e); }
  });
  const fields = () => [
    field('token', h('div', { class: 'row' }, tokSlot, h('span', { class: 'grow' }), have)),
    field('to', h('div', { class: 'input-group' }, toIn, h('span', { class: 'suffix-btn' }, paste))),
    field('amount', h('div', { class: 'input-group' }, amtIn, h('span', { class: 'suffix-btn' }, max)), null),
    worth, speedSlot, err, actions(() => home(), next),
  ];
  mount(form, ...fields());
  paint();
  show(...screen('send', null, form));
  (to ? amtIn : toIn).focus();
}

/** The last look before signing: what changes, every warning, then your yes. */
function review(prep, { kind, back }) {
  const dangers = [...(prep.warnings ?? []), ...(prep.preview?.warnings ?? [])].some((w) => w.level === 'danger');
  const ack = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false' }, 'i understand the risk, sign anyway');
  const next = h('button', { class: 'btn-go block lg', type: 'button', dataset: { busyText: 'signing' }, disabled: dangers }, kind === 'swap' ? 'swap it ->' : 'send it ->');
  ack.addEventListener('click', () => { const on = !ack.classList.contains('on'); ack.classList.toggle('on', on); ack.setAttribute('aria-pressed', String(on)); next.disabled = !on; });
  const err = errLine();
  // a Ledger signs it after this: its state, live, while plum waits on it
  const device = isLedgerWallet(active()) ? deviceBox(APP[prep.chain ?? 'sol'], { hidden: true }) : null;
  busyButton(next, async () => {
    err.hidden = true;
    device?.watch();
    try {
      const done = await call(kind === 'swap' ? 'swap.submit' : 'send.submit', { id: prep.id });
      device?.stop();
      forget();
      sentScreen(done);
    } catch (e) { if (!device?.failed(e)) showErr(err, e); }
  });
  const summary = kind === 'send'
    ? box('sending', { tone: 'ink' }, kv('amount', `${prep.amount} ${prep.symbol}`), kv('to', short(prep.to, 6)), prep.netTitle ? kv('on', prep.netTitle.toLowerCase(), 'loud') : kv('on', CHAIN[prep.chain ?? 'sol'].name), addressBlock(prep.to))
    : box('swapping', { tone: 'ink' }, kv('you pay', `${prep.inAmount} ${prep.inSymbol}`), kv('you get (about)', `${prep.outAmount} ${prep.outSymbol}`), kv('at least', `${prep.minOut} ${prep.outSymbol}`));
  show(...screen('review', null, summary,
    previewBlock(prep.preview, { extra: prep.warnings }),
    device ? h('p', { class: 'fine' }, prep.chain === 'btc' ? 'your Ledger shows this send too: sign it there after this. It also lists the change coming back to this wallet, as a second output to its own address.' : 'your Ledger shows this too: approve it there after this.') : null,
    device?.node, dangers ? ack : null, err, actions(back, next)));
}

/** After a send: plum's log of it, the last line turning until it lands. */
function sentScreen({ signature, explorer, chain = 'sol', explorerName = null }) {
  const status = h('span', { class: 'r' }, spinner());
  const landing = { sol: 'landing on chain', eth: 'in a block', btc: 'first confirmation' }[chain];
  const log = h('ol', { class: 'log' },
    h('li', null, h('span', null, 'signed, by you alone'), h('span', { class: 'r' }, 'ok')),
    h('li', null, h('span', null, `sent  ${short(signature, 6)}`), h('span', { class: 'r' }, 'ok')),
    h('li', null, h('span', null, landing), status));
  const note = chain === 'btc' ? h('p', { class: 'fine' }, 'bitcoin confirms in about ten minutes; you can close plum, it carries on without it.') : null;
  show(...screen('sent', null, log, note,
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: explorer, target: '_blank', rel: 'noreferrer noopener' }, explorerName ?? CHAIN[chain].explorer), h('button', { class: 'btn-go', type: 'button', onclick: () => home() }, 'done ->'))));
  const until = Date.now() + (chain === 'btc' ? 30 * 60_000 : chain === 'eth' ? 180_000 : 90_000);
  const tick = async () => {
    if (!status.isConnected) return;
    const s = await call('tx.status', { signature }).catch(() => null);
    if (s?.status === 'confirmed') { status.textContent = 'ok'; return; }
    if (s?.status === 'failed') { status.textContent = 'failed'; status.classList.add('t-red'); return; }
    if (s?.status === 'expired' || Date.now() > until) { status.textContent = 'not seen yet'; status.classList.add('t-gold'); return; }
    setTimeout(tick, chain === 'btc' ? 10_000 : 1500);
  };
  tick();
}

/* ------------------------------------------------------------ receive */

function receiveScreen(chain = null, btcKind = 'p2wpkh') {
  const w = active();
  const chains = chainsOf(w);
  const on = chains.includes(chain) ? chain : chains[0];
  // Bitcoin has two: bc1q and bc1p (btc.js)
  const address = on === 'btc' ? btcAddressOf(w, btcKind) : w.chains[on].address;
  const cp = h('button', { class: 'btn-go block', type: 'button' }, 'copy address');
  cp.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(address); } catch { return; }
    cp.textContent = 'copied';
    setTimeout(() => { cp.textContent = 'copy address'; }, 1400);
  });
  const pick = chains.length > 1 ? h('div', { class: 'row centred' }, seg(chains.map((c) => [c, CHAIN[c].name]), on, (c) => receiveScreen(c), { label: 'which chain' })) : null;
  (chain ? redraw : show)(...screen('receive', () => home(),
    pick,
    on === 'btc' ? btcReceivePick(w, btcKind, (k) => receiveScreen('btc', k)) : null,
    h('div', { class: 'qr-box' }, qrAscii(address)),
    addressBlock(address, { copy: true }),
    on === 'eth' ? h('p', { class: 'fine center' }, 'the same address on ethereum, base, arbitrum and polygon') : null,
    cp,
    isLedgerWallet(w) ? checkOnLedger(on, address) : null));
}

/* ------------------------------------------------------------ swap (Jupiter, on Solana) */

async function swapScreen(prefill = {}) {
  const w = active();
  // Solana's swaps here (Jupiter); an Ethereum network's in evm-swap.js (KyberSwap), picked at the top of either
  const where = swapNetwork(w, prefill.net);
  if (where !== 'solana') { evmSwapScreen({ ...prefill, net: where }); return; }
  if (!w.chains.sol) { show(...screen('swap', () => home(), h('div', { class: 'note' }, `swaps happen on Solana and Ethereum's networks, and ${w.name} has neither address (it's an imported key).`))); return; }
  let list;
  try {
    await loadHoldings(w);
    const b = ctx.bal.get(balKey(w, 'sol'));
    if (!b) throw new Error("couldn't read this wallet's Solana balances: try again");
    list = [{ chain: 'sol', mint: null, symbol: 'SOL', name: 'solana', amount: b.native.amount, decimals: 9, price: b.native.price }, ...b.tokens.map((t) => ({ ...t, chain: 'sol' }))];
  } catch (e) { show(...screen('swap', () => home(), h('div', { class: 'note err' }, e.message))); return; }
  const solRow = { ...list[0], mint: WSOL };
  let from = prefill.from ?? solRow;
  let to = prefill.to ?? { chain: 'sol', mint: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 };
  let bps = ctx.S.settings.slippageBps;
  let quote = null;
  const amtIn = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: prefill.amount ?? '' });
  const outBox = h('div', { class: 'out' }, h('span', { class: 'dim' }, '0'));
  const facts = h('div', { class: 'kvs' });
  const err = errLine();
  const form = h('div', { class: 'stack' });
  const next = h('button', { class: 'btn-go block', type: 'button', disabled: true, dataset: { busyText: 'simulating' } }, 'review ->');
  const tokBtn = (t, side) => tokenButton(t, () => mount(form, picker(list.map((x) => (x.mint ? x : solRow)), (pick) => {
    if (side === 'from') from = pick.mint ? pick : solRow; else to = pick.mint ? pick : solRow;
    draw();
    getQuote();
  }, { title: side === 'from' ? 'you pay with' : 'you get', search: side === 'to', back: () => draw() })));
  const have = () => {
    const held = list.find((x) => (x.mint ?? WSOL) === from.mint);
    return held ? `have ${prettyAmount(BigInt(held.amount), held.decimals)}` : 'have 0';
  };
  const half = h('button', { class: 'mini', type: 'button' }, 'half');
  const max = h('button', { class: 'mini', type: 'button' }, 'max');
  const setPart = (div) => {
    const held = list.find((x) => (x.mint ?? WSOL) === from.mint);
    if (!held) return;
    let raw = BigInt(held.amount) / div;
    if (from.mint === WSOL) raw = raw > 5_000_000n ? raw - (div === 1n ? 5_000_000n : 0n) : 0n; // keep 0.005 SOL for fees and rent
    amtIn.value = formatUnits(raw, held.decimals);
    getQuote();
  };
  half.addEventListener('click', () => setPart(2n));
  max.addEventListener('click', () => setPart(1n));
  const slip = seg([[50, '0.5%'], [100, '1%'], [300, '3%']], bps, (v) => { bps = v; getQuote(); }, { label: 'slippage' });
  let timer = null, seq = 0;
  function getQuote() {
    clearTimeout(timer);
    quote = null;
    next.disabled = true;
    err.hidden = true;
    const amount = amtIn.value.trim();
    if (!amount || Number(amount) === 0) { outBox.replaceChildren(h('span', { class: 'dim' }, '0')); facts.replaceChildren(); return; }
    outBox.replaceChildren(spinner());
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const q = await call('swap.quote', { inputMint: from.mint, outputMint: to.mint, amount, slippageBps: bps });
        if (mine !== seq) return;
        quote = q;
        outBox.replaceChildren(h('b', null, q.outAmount), ' ', h('span', { class: 'dim' }, q.outSymbol ?? ''));
        const rate = Number(q.outAmount) / Number(q.inAmount);
        facts.replaceChildren(
          kv('rate', `1 ${q.inSymbol} = ${rate.toPrecision(6)} ${q.outSymbol}`),
          kv('at least', `${q.minOut} ${q.outSymbol}`),
          kv('price impact', `${q.priceImpact.toFixed(2)}%`, q.priceImpact > 3 ? 'warn' : ''),
          kv('route', q.route.join(' > ') || 'jupiter'));
        next.disabled = false;
      } catch (e) {
        if (mine !== seq) return;
        outBox.replaceChildren(h('span', { class: 'dim' }, '?'));
        showErr(err, e);
      }
    }, 450);
  }
  amtIn.addEventListener('input', getQuote);
  busyButton(next, async () => {
    if (!quote) return;
    try {
      const prep = await call('swap.prepare', { quoteId: quote.id });
      review({ ...prep, ...quote, id: prep.id }, { kind: 'swap', back: () => swapScreen({ from, to, amount: amtIn.value }) });
    } catch (e) { showErr(err, e); }
  });
  const flip = h('button', { class: 'mini flip', type: 'button', title: 'swap sides' }, '^v');
  flip.addEventListener('click', () => { [from, to] = [to, from]; draw(); getQuote(); });
  function draw() {
    mount(form,
      field('you pay', h('div', { class: 'swap-row' }, amtIn, tokBtn(from, 'from')), h('span', null, have(), ' ', half, ' ', max)),
      h('div', { class: 'flip-row' }, flip),
      field('you get', h('div', { class: 'swap-row' }, outBox, tokBtn(to, 'to'))),
      field('slippage', slip),
      facts, err, actions(() => home(), next));
  }
  draw();
  show(...screen('swap', null, swapNetSeg(w, 'solana'), form, h('p', { class: 'fine' }, 'routed by Jupiter, on Solana')));
  if (amtIn.value) getQuote();
  amtIn.focus();
}

/* ------------------------------------------------------------ history */

async function historyScreen() {
  const w = active();
  // (an Ethereum address's history spans its four networks, so it's always marked)
  const tagged = chainsOf(w).length > 1 || !!w.chains.eth;
  const list = h('ol', { class: `hist ${tagged ? 'tagged' : ''}` }, h('li', { class: 'dim wait', 'aria-label': 'reading' }, h('span', null, spinner())));
  const err = errLine();
  show(...screen('history', () => home(), box(null, { tone: 'soft' }, list), err));
  try {
    const { items, errors } = await call('activity');
    if (!list.isConnected) return;
    const failed = Object.entries(errors ?? {});
    if (failed.length) showErr(err, failed.map(([c, m]) => `${CHAIN[c].name}: ${m}`).join(' · '));
    if (!items.length) { list.replaceChildren(h('li', { class: 'dim wait' }, h('span', null, 'nothing yet'))); return; }
    list.replaceChildren(...items.map((t) => h('li', null,
      h('a', { href: t.explorer, target: '_blank', rel: 'noreferrer noopener' }, short(t.id, 6)),
      tagged ? h('span', { class: 'chain-tag' }, t.tag ?? t.chain) : null,
      h('span', { class: 'dim' }, t.time ? ago(t.time) : 'pending'),
      h('span', { class: t.pending ? 't-gold' : t.ok ? 't-go' : 't-red' }, t.pending ? '[..]' : t.ok ? '[ok]' : '[failed]'))));
  } catch (e) { list.replaceChildren(h('li', { class: 't-red wait' }, h('span', null, e.message))); }
}

/* ------------------------------------------------------------ settings */

/** Settings. A change saves at once and the screen is drawn again where it was (`stay`), not from the top. */
async function settingsScreen(stay = false) {
  const s = ctx.S.settings;
  const err = errLine();
  const set = async (patch) => { try { await call('settings.set', { patch }); await refresh(); forget(); settingsScreen(true); } catch (e) { showErr(err, e); } };
  const toggle = (on, label, key) => h('button', { class: `toggle ${on ? 'on' : ''}`, type: 'button', 'aria-pressed': String(on), onclick: () => set({ [key]: !on }) }, label);

  // the RPCs: plum's own unless you set yours; an empty field saved goes back to plum's
  const net = ctx.S.networks[s.network];
  const rpcIn = h('input', { class: 'input', value: net.custom ? net.url : '', placeholder: net.url, spellcheck: 'false', autocomplete: 'off' });
  const rpcSave = h('button', { class: 'btn-go btn-sm', type: 'button' }, 'save');
  rpcSave.addEventListener('click', () => set({ rpc: { [s.network]: rpcIn.value.trim() } }));

  const jupF = secretField({ placeholder: s.jupiterKey ? 'a key is saved' : 'optional', caps: false });
  const jupSave = h('button', { class: 'btn-go btn-sm', type: 'button' }, 'save');
  jupSave.addEventListener('click', () => set({ jupiterKey: jupF.input.value.trim() }));

  const sitesList = h('div', { class: 'sites' }, h('span', { class: 'dim', 'aria-label': 'reading' }, spinner()));
  const pwOldF = secretField({ placeholder: 'current password' }), pwOld = pwOldF.input;
  const pwNewF = secretField({ placeholder: 'new password' }), pwNew = pwNewF.input;
  const pwErr = errLine();
  const pwBtn = h('button', { class: 'btn-go btn-sm', type: 'button', dataset: { busyText: 'resealing' } }, 'change password');
  busyButton(pwBtn, async () => {
    pwErr.hidden = true;
    try { await call('password.change', { oldPassword: pwOld.value, newPassword: pwNew.value }); pwOld.value = pwNew.value = ''; pwBtn.textContent = 'changed'; } catch (e) { showErr(pwErr, e); }
  });
  const lock = h('button', { class: 'btn btn-sm', type: 'button' }, 'lock plum now');
  busyButton(lock, lockNow);

  // each account's recovery phrase, after your password
  const phrases = ctx.S.accounts.filter((a) => a.kind === 'phrase');
  let which = accountOf(active())?.kind === 'phrase' ? accountOf(active()).id : phrases[0]?.id;
  const phraseSlot = h('div');
  const drawPhrase = () => {
    const a = phrases.find((x) => x.id === which);
    phraseSlot.replaceChildren(secretReveal((password) => call('account.phrase', { id: which, password }), { label: 'recovery phrase', warn: `these words are every wallet in ${a?.name ?? 'this account'}. Write them on paper; never type them into a website.` }));
  };
  if (phrases.length) drawPhrase();

  (stay ? redraw : show)(...screen('settings', () => home(),
    box('network', { tone: 'soft' },
      field('solana rpc', rpcIn, net.custom ? 'yours' : net.builtIn ? 'built in' : null),
      h('div', { class: 'row' }, rpcSave),
      // Ethereum's four networks, one field at a time
      evmRpcField(ctx.S.evm, set)),
    box('security', { tone: 'soft' },
      field('lock after', seg([[5, '5m'], [15, '15m'], [60, '1h'], [240, '4h']], s.autolockMin, (v) => set({ autolockMin: v }))),
      lock,
      toggle(s.hideZero, 'hide empty token accounts', 'hideZero'),
      h('div', { class: 'stack tight' }, h('div', { class: 'label' }, 'change password'), pwOldF.node, pwNewF.node, pwBtn, pwErr),
      phrases.length ? h('details', { class: 'more' }, h('summary', null, h('span', null, phrases.length > 1 ? '-- recovery phrases' : '-- recovery phrase')),
        phrases.length > 1 ? seg(phrases.map((a) => [a.id, a.name]), which, (v) => { which = v; drawPhrase(); }, { label: 'which account' }) : null,
        phraseSlot) : null),
    box('connected sites', { tone: 'soft' }, sitesList),
    box('swaps', { tone: 'soft' }, field('jupiter api key', jupF.node, s.jupiterKey ? 'saved' : null), jupSave),
    h('details', { class: 'more' }, h('summary', null, h('span', { class: 't-red' }, '-- reset plum')), resetForm()),
    err));
  try {
    const list = await call('sites');
    if (!sitesList.isConnected) return;
    if (!list.length) { sitesList.replaceChildren(h('span', { class: 'dim' }, 'no sites yet')); return; }
    sitesList.replaceChildren(...list.map((x) => {
      const rm = h('button', { class: 'mini', type: 'button' }, 'revoke');
      rm.addEventListener('click', async () => { await call('sites.revoke', { origin: x.origin }); settingsScreen(true); });
      const on = [x.accounts?.length ? 'sol' : null, x.evm?.length ? x.evmNet ?? 'eth' : null, x.btc?.length ? 'btc' : null].filter(Boolean).join(' ');
      return h('div', { class: 'site' }, h('b', null, new URL(x.origin).host), h('span', { class: 'chain-tag' }, on), h('span', { class: 'dim' }, ago(Math.floor(x.lastUsed / 1000))), rm);
    }));
  } catch (e) { sitesList.replaceChildren(h('span', { class: 't-red' }, e.message)); }
}

/* ------------------------------------------------------------ start */

Object.assign(go, {
  home, accounts: () => accountsScreen(), settings: () => settingsScreen(), send: sendScreen, receive: receiveScreen, swap: swapScreen,
  history: historyScreen, welcome, unlock, sent: sentScreen, stake: stakeScreen, nfts: nftsScreen,
});

async function boot() {
  keepAlive();
  try { await refresh(); } catch (e) { mount(root, h('div', { class: 'note err' }, e.message)); return; }
  if (!ctx.S.hasVault) welcome();
  else if (!ctx.S.unlocked) unlock();
  else if (!ledgerFromUrl()) home();
}

boot();
