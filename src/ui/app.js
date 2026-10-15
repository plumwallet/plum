// What every popup screen shares: plum's state (no secrets), the last balances read, the head, a screen's frame, and
// the ways between screens (`go`, filled in by popup.js, so the screens' files never import each other).
import { call } from './api.js';
import { logo } from './art.js';
import { h, mount } from './dom.js';
import { CHAIN, actions, backButton, box, chainsOf, iconArt, netChip } from './parts.js';

export const root = document.getElementById('app');
/** S: plum's state; bal: the last balances, by `${wallet}:${chain}`. */
export const ctx = { S: null, bal: new Map() };
/** home, accounts, settings, send, receive, swap, history, welcome, unlock: set by popup.js. */
export const go = {};

export const refresh = async () => (ctx.S = await call('state'));
export const active = () => ctx.S.wallets.find((w) => w.id === ctx.S.active) ?? ctx.S.wallets[0];
export const accountOf = (w) => ctx.S.accounts.find((a) => a.id === w?.account) ?? null;
export const forget = () => ctx.bal.clear();

export const errLine = () => h('div', { class: 'err-line', hidden: true });
export const showErr = (el, e) => { el.textContent = e?.message ?? String(e); el.hidden = false; };
export const field = (label, input, side) => h('div', { class: 'field' }, h('label', null, h('span', null, label), side ? h('span', { class: 'dim' }, side) : null), input);

/** A new screen: its parts in, from the top. */
export const show = (...nodes) => { mount(root, ...nodes); scrollTo(0, 0); };
/** The same screen drawn again where it was (no jump to the top). */
export const redraw = (...nodes) => mount(root, ...nodes);

/** A wallet's address on one chain, copied by a click: [sol] says [copied] for a moment. */
function copyChip(chain, address) {
  const b = h('button', { class: 'mini copy-chip', type: 'button', title: `copy your ${CHAIN[chain].title} address  ${address}` }, chain);
  let timer = null;
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(address); } catch { return; }
    b.classList.add('done');
    b.textContent = 'copied';
    clearTimeout(timer);
    timer = setTimeout(() => { b.classList.remove('done'); b.textContent = chain; }, 1400);
  });
  return b;
}

/** The wallet you're in, in a box of its own that stays at the top while a screen scrolls: its icon; its name (a click
 * lists your accounts and their wallets) and the account it's in; its address on each chain (a click copies one: the
 * only hand-pointers up here); settings on the right. */
export function header() {
  const w = active();
  const acct = accountOf(w);
  return h('header', { class: 'top' },
    h('div', { class: 'top-in' },
      h('span', { class: 'top-icon' }, iconArt(w.icon, 'pick')),
      h('div', { class: 'who' },
        h('button', { class: 'acct', type: 'button', title: 'your accounts and wallets', onclick: () => go.accounts() }, h('b', null, w.name), h('span', { class: 'caret' }, 'v')),
        h('div', { class: 'who-2' },
          acct ? h('span', { class: 'who-acct' }, acct.name) : null,
          h('span', { class: 'chips' }, chainsOf(w).map((c) => copyChip(c, w.chains[c].address))))),
      h('span', { class: 'grow' }),
      netChip(ctx.S.settings.network),
      h('button', { class: 'tab-btn', type: 'button', title: 'settings', onclick: () => go.settings() }, '[ = ]')));
}

/** A screen: the head, then its title (and on the right a way back, or the step: 'step 1 of 2') and what it holds. */
export function screen(title, back, ...children) {
  return [header(), h('main', { class: 'screen' },
    h('div', { class: 'screen-head' }, h('h2', { class: 'h3' }, title), typeof back === 'string' ? h('span', { class: 'dim' }, back) : back ? backButton(back) : null),
    ...children)];
}

/** A step before there's a wallet (no head yet): plum's logo when `hero`, then a box with the step's title and count,
 * what it asks, and at its foot the answers: [ back ] on the left, the way on at the right. */
export function frame(title, { step = null, back = null, next = null, hero = false } = {}, ...children) {
  const side = step ? h('div', { class: 'head-side' }, h('span', { class: 'dim' }, step)) : null;
  if (next && !back) next.classList.add('block');
  show(h('div', { class: 'setup' },
    hero ? h('div', { class: 'hero' }, logo()) : null,
    box(title, { tone: 'soft', side, className: 'step' }, ...children, back ? actions(back, next) : next)));
}
