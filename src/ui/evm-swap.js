// Swaps on Ethereum's networks (KyberSwap; the background reads, checks and simulates every one: evm-swap.js there).
// The network is picked at the top of the swap screen, Solana's too; then the same form (you pay, you get, slippage),
// a review that shows each step (an exact approval when the token needs one, then the swap) with what leaves and what
// arrives, simulated, and a log of the steps as they go out.
import { formatUnits, parseUnits, prettyAmount, short } from '../shared/format.js';
import { call } from './api.js';
import { active, ctx, errLine, field, go, screen, show, showErr } from './app.js';
import { busyButton, h, mount } from './dom.js';
import { NETS, netLoud, netOf } from './evm.js';
import { actions, box, coinMark, kv, previewBlock, seg, spinner } from './parts.js';

/** Where a swap happens: 'solana' or an Ethereum network's key. The one asked for when the wallet has that chain,
 * else Solana, else Ethereum. */
export function swapNetwork(w, asked) {
  if (asked === 'solana' && w.chains.sol) return 'solana';
  if (asked && asked !== 'solana' && w.chains.eth && NETS.some((n) => n.key === asked)) return asked;
  if (w.chains.sol) return 'solana';
  return w.chains.eth ? 'ethereum' : 'solana';
}

/** The networks a swap can happen on, as a row at the top of the swap screen (none when there's only one). */
export function swapNetSeg(w, current) {
  const choices = [...(w.chains.sol ? [['solana', 'sol']] : []), ...(w.chains.eth ? NETS.map((n) => [n.key, n.tag]) : [])];
  if (choices.length < 2) return null;
  return h('div', { class: 'swap-net' }, h('span', { class: 'dim' }, 'swap on'), seg(choices, current, (v) => go.swap({ net: v }), { label: 'which network' }));
}

/** The coin or token a form uses, as a typed button: its ticker and a caret, no picture. */
const tokenButton = (t, onclick) => h('button', { class: 'tok-btn', type: 'button', onclick }, h('b', null, t.symbol ?? short(t.mint)), h('span', { class: 'caret' }, 'v'));
const keyOf = (t) => (t?.mint ? t.mint.toLowerCase() : 'coin');
const same = (a, b) => keyOf(a) === keyOf(b);

/** Picking a token on a network: what you hold there, then plum's list for it; a pasted address is looked up there. */
function picker(net, items, onPick, { title, back, search = false }) {
  const row = (t) => h('button', { class: t.mint == null ? 'tk' : 'tk plain', type: 'button', onclick: () => onPick(t) },
    t.mint == null ? coinMark(t.symbol === 'POL' ? 'pol' : 'eth') : null,
    h('span', { class: 'tk-n' }, h('b', null, t.symbol ?? short(t.mint)), h('span', { class: 'dim' }, t.verified === false ? h('span', { class: 'unv' }, 'unverified ') : null, t.name ?? (t.mint ? short(t.mint, 6) : net.name))),
    h('span', { class: 'tk-v' }, t.amount != null ? h('b', null, prettyAmount(BigInt(t.amount), t.decimals)) : h('span', { class: 'dim' }, t.mint ? short(t.mint, 4) : '')));
  const coins = h('div', { class: 'tks' });
  const results = h('div', { class: 'tks' });
  const showList = (list) => {
    coins.replaceChildren(...list.filter((t) => t.mint == null).map(row));
    const toks = list.filter((t) => t.mint != null);
    results.replaceChildren(...toks.map(row));
    if (!toks.length) results.append(h('p', { class: 'dim empty' }, 'no tokens'));
  };
  showList(items);
  let q = null;
  if (search) {
    let timer = null;
    q = h('input', { class: 'input', placeholder: 'a ticker, or paste a token address', spellcheck: 'false', autocomplete: 'off' });
    q.addEventListener('input', () => {
      clearTimeout(timer);
      const text = q.value.trim();
      if (!text) { showList(items); return; }
      if (!/^0x[0-9a-fA-F]{40}$/.test(text)) { showList(items.filter((t) => (t.symbol ?? '').toLowerCase().includes(text.toLowerCase()))); return; }
      timer = setTimeout(async () => {
        results.replaceChildren(h('p', { class: 'dim empty', 'aria-label': 'looking it up' }, spinner()));
        try { showList([await call('evm.token', { net: net.key, address: text })]); } catch (e) { results.replaceChildren(h('p', { class: 't-red' }, e.message)); }
      }, 350);
    });
  }
  return h('div', { class: 'stack' }, box(title, { tone: 'soft' }, q, coins), box('tokens', { tone: 'soft' }, results), actions(back, null));
}

/** The swap screen on an Ethereum network. */
export async function evmSwapScreen({ net: key = 'ethereum', from = null, to = null, amount = '' } = {}) {
  const w = active();
  const net = netOf(key);
  let held, list;
  try {
    // what you hold on this network (the balances home read, or read now), and plum's own list of its tokens
    const balKey = `${w.id}:eth`;
    const b = ctx.bal.get(balKey) ?? await call('balances', { chain: 'eth' }).then((x) => { ctx.bal.set(balKey, x); return x; });
    list = await call('evm.tokens', { net: net.key });
    const coin = net.key === 'ethereum' ? b.native.amount : b.networks?.find((x) => x.net === net.key)?.amount;
    held = [{ ...list[0], amount: coin ?? '0' }, ...b.tokens.filter((t) => t.net === net.key)];
  } catch (e) { show(...screen('swap', () => go.home(), swapNetSeg(w, net.key), h('div', { class: 'note err' }, e.message))); return; }
  const usdc = list.find((t) => t.symbol === 'USDC');
  let sell = from ?? held[0];
  let buy = to ?? (sell.mint == null ? usdc : list[0]);
  let bps = ctx.S.settings.slippageBps;
  let quote = null;
  const amtIn = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: amount });
  const outBox = h('div', { class: 'out' }, h('span', { class: 'dim' }, '0'));
  const facts = h('div', { class: 'kvs' });
  const err = errLine();
  const form = h('div', { class: 'stack' });
  const next = h('button', { class: 'btn-go block', type: 'button', disabled: true, dataset: { busyText: 'simulating' } }, 'review ->');
  const heldOf = (t) => held.find((x) => same(x, t));
  const have = () => { const x = heldOf(sell); return x ? `have ${prettyAmount(BigInt(x.amount ?? 0), x.decimals)}` : 'have 0'; };
  const choices = (side) => {
    const seen = new Set();
    return [...held, ...list].filter((t) => { const k = keyOf(t); if (seen.has(k)) return false; seen.add(k); return side === 'to' || t.amount != null; });
  };
  const tokBtn = (t, side) => tokenButton(t, () => mount(form, picker(net, choices(side), (pick) => {
    if (side === 'from') sell = pick; else buy = pick;
    if (same(sell, buy)) { if (side === 'from') buy = sell.mint == null ? usdc : held[0]; else sell = buy.mint == null ? usdc : held[0]; }
    draw();
    getQuote();
  }, { title: side === 'from' ? 'you pay with' : 'you get', search: side === 'to', back: () => draw() })));
  const half = h('button', { class: 'mini', type: 'button' }, 'half');
  const max = h('button', { class: 'mini', type: 'button' }, 'max');
  const setPart = (div) => {
    const x = heldOf(sell);
    if (!x) return;
    let raw = BigInt(x.amount ?? 0) / div;
    // the coin pays the network fee too: a little is kept back for it
    const keep = { ethereum: 3_000_000_000_000_000n, polygon: 1_000_000_000_000_000_000n }[net.key] ?? 200_000_000_000_000n;
    if (sell.mint == null) raw = raw > keep ? raw - (div === 1n ? keep : 0n) : 0n;
    amtIn.value = formatUnits(raw, x.decimals);
    getQuote();
  };
  half.addEventListener('click', () => setPart(2n));
  max.addEventListener('click', () => setPart(1n));
  const slip = seg([[50, '0.5%'], [100, '1%'], [300, '3%']], bps, (v) => { bps = v; getQuote(); }, { label: 'slippage' });
  let timer = null, seqNo = 0;
  function getQuote() {
    clearTimeout(timer);
    quote = null;
    next.disabled = true;
    err.hidden = true;
    const text = amtIn.value.trim();
    let raw = 0n;
    try { raw = text ? parseUnits(text, sell.decimals) : 0n; } catch { raw = 0n; }
    if (!raw) { outBox.replaceChildren(h('span', { class: 'dim' }, '0')); facts.replaceChildren(); return; }
    outBox.replaceChildren(spinner());
    const mine = ++seqNo;
    timer = setTimeout(async () => {
      try {
        const q = await call('evm.swap.quote', { net: net.key, sell: sell.mint, buy: buy.mint, amount: text, slippageBps: bps });
        if (mine !== seqNo) return;
        quote = q;
        outBox.replaceChildren(h('b', null, q.outAmount), ' ', h('span', { class: 'dim' }, q.outSymbol ?? ''));
        const rate = Number(q.outAmount) / Number(q.inAmount);
        facts.replaceChildren(
          kv('rate', `1 ${q.inSymbol} = ${rate.toPrecision(6)} ${q.outSymbol}`),
          kv('at least', `${q.minOut} ${q.outSymbol}`),
          q.priceImpact != null ? kv('price impact', `${q.priceImpact.toFixed(2)}%`, q.priceImpact > 3 ? 'warn' : '') : null,
          kv('route', q.route.join(' > ') || 'kyberswap'));
        next.disabled = false;
      } catch (e) {
        if (mine !== seqNo) return;
        outBox.replaceChildren(h('span', { class: 'dim' }, '?'));
        showErr(err, e);
      }
    }, 450);
  }
  amtIn.addEventListener('input', getQuote);
  busyButton(next, async () => {
    if (!quote) return;
    err.hidden = true;
    try {
      const prep = await call('evm.swap.prepare', { quoteId: quote.id });
      review(prep, { back: () => evmSwapScreen({ net: net.key, from: sell, to: buy, amount: amtIn.value }) });
    } catch (e) { showErr(err, e); }
  });
  const flip = h('button', { class: 'mini flip', type: 'button', title: 'swap sides' }, '^v');
  flip.addEventListener('click', () => { [sell, buy] = [buy, sell]; draw(); getQuote(); });
  function draw() {
    mount(form,
      field('you pay', h('div', { class: 'swap-row' }, amtIn, tokBtn(sell, 'from')), h('span', null, have(), ' ', half, ' ', max)),
      h('div', { class: 'flip-row' }, flip),
      field('you get', h('div', { class: 'swap-row' }, outBox, tokBtn(buy, 'to'))),
      field('slippage', slip),
      facts, err, actions(() => go.home(), next));
  }
  draw();
  show(...screen('swap', null, swapNetSeg(w, net.key), form, h('p', { class: 'fine' }, `routed by KyberSwap, on ${net.name}: plum checks and simulates the swap before you sign`)));
  if (amtIn.value) getQuote();
  amtIn.focus();
}

/** The last look before signing a swap: the network, what you pay and get, each step (an exact approval when one is
 * needed, then the swap), what the simulation shows changing, every warning; then your yes. */
function review(prep, { back }) {
  const net = netOf(prep.net);
  const dangers = (prep.warnings ?? []).some((w) => w.level === 'danger');
  const ack = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false' }, 'i understand the risk, swap anyway');
  const go2 = h('button', { class: 'btn-go block lg', type: 'button', dataset: { busyText: prep.approval ? 'approving, then swapping' : 'signing' }, disabled: dangers }, 'swap it ->');
  let acked = false;
  ack.addEventListener('click', () => { acked = !acked; ack.classList.toggle('on', acked); ack.setAttribute('aria-pressed', String(acked)); go2.disabled = !acked; });
  const err = errLine();
  busyButton(go2, async () => {
    err.hidden = true;
    try {
      const done = await call('evm.swap.submit', { id: prep.id, ignoreRisk: acked });
      ctx.bal.clear();
      swapped(done, prep);
    } catch (e) { showErr(err, e); }
  });
  const steps = prep.approval
    ? `approve exactly ${prep.approval.amount} ${prep.approval.token}, then swap`
    : 'one transaction: the swap';
  show(...screen('review', null,
    box('swapping', { tone: 'ink', side: netLoud(net.key) },
      kv('on', `${net.name} (chain ${net.id})`, 'loud'),
      kv('you pay', `${prep.inAmount} ${prep.inSymbol}`),
      kv('you get (about)', `${prep.outAmount} ${prep.outSymbol}`),
      kv('at least', `${prep.minOut} ${prep.outSymbol}`),
      kv('steps', steps),
      prep.approval ? kv('spender', `kyberswap ${short(prep.approval.spender, 4)}`) : null),
    previewBlock(prep.preview, { extra: prep.warnings }),
    dangers ? ack : null, err, actions(back, go2)));
}

/** After a swap: its steps as they went out, the swap's last line turning until it lands. */
function swapped(done, prep) {
  const status = h('span', { class: 'r' }, spinner());
  const lines = [
    ...done.approvals.map((a, i) => h('li', null, h('span', null, i === done.approvals.length - 1 && prep.approval ? `approved exactly ${prep.approval.amount} ${prep.approval.token}  ${short(a, 4)}` : `approval reset  ${short(a, 4)}`), h('span', { class: 'r' }, 'ok'))),
    h('li', null, h('span', null, 'signed, by you alone'), h('span', { class: 'r' }, 'ok')),
    h('li', null, h('span', null, `swap sent  ${short(done.signature, 6)}`), h('span', { class: 'r' }, 'ok')),
    h('li', null, h('span', null, 'in a block'), status),
  ];
  show(...screen('swapped', null, h('ol', { class: 'log' }, lines),
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: done.explorer, target: '_blank', rel: 'noreferrer noopener' }, done.explorerName ?? 'explorer'), h('button', { class: 'btn-go', type: 'button', onclick: () => go.home() }, 'done ->'))));
  const until = Date.now() + 180_000;
  const tick = async () => {
    if (!status.isConnected) return;
    const s = await call('tx.status', { signature: done.signature }).catch(() => null);
    if (s?.status === 'confirmed') { status.textContent = 'ok'; return; }
    if (s?.status === 'failed') { status.textContent = 'failed'; status.classList.add('t-red'); return; }
    if (Date.now() > until) { status.textContent = 'not seen yet'; status.classList.add('t-gold'); return; }
    setTimeout(tick, 1500);
  };
  tick();
}

