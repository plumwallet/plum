// Accounts and their wallets. An account is a recovery phrase (12 or 24 words), in a box of its own named for it; its
// wallets are listed inside (each an address on Solana, Ethereum and Bitcoin), with "+ new wallet" for the phrase's
// next one. Keys you imported sit in their own box. Under them, the ways to add more: a new account (a new phrase),
// an account you already have (a phrase, every wallet in it found), or a private key.
// A wallet's [..] opens its tools (icon, addresses, name, private keys, remove); an account's [..] opens its own
// (name, recovery phrase, remove). Changes save at once and the screen is drawn again where it was.
import { short } from '../shared/format.js';
import { call } from './api.js';
import { busyButton, h } from './dom.js';
import { active, ctx, errLine, forget, go, redraw, screen, show, showErr } from './app.js';
import { createWallet, importKey, importPhrase } from './flows.js';
import { CHAIN, addressBlock, box, chainsOf, chip, iconArt, iconPicker, secretField, seg } from './parts.js';

/** The tools of one wallet or account at a time: { kind: 'wallet' | 'account', id } or null. */
export function accountsScreen({ open = null, stay = false } = {}) {
  const S = ctx.S;
  const err = errLine();
  const again = (o = open) => accountsScreen({ open: o, stay: true });
  const current = active();
  const boxes = S.accounts.map((acct) => {
    const wallets = S.wallets.filter((w) => w.account === acct.id);
    if (!wallets.length) return null;
    const keys = acct.kind === 'keys';
    const opened = open?.kind === 'account' && open.id === acct.id;
    const manage = keys ? null : h('button', { class: 'mini', type: 'button', title: 'manage this account', onclick: () => again(opened ? null : { kind: 'account', id: acct.id }) }, opened ? 'close' : '..');
    const side = h('div', { class: 'head-side' }, acct.words ? h('span', { class: 'dim' }, `${acct.words} words`) : null, acct.backedUp === false ? chip('not backed up', 'hot') : null, manage);
    const add = keys ? null : h('button', { class: 'btn btn-sm add-wallet', type: 'button', title: `the next wallet of ${acct.name}'s recovery phrase` }, '+ new wallet');
    if (add) busyButton(add, async () => { try { ctx.S = await call('wallet.add', { account: acct.id }); forget(); again(null); } catch (e) { showErr(err, e); } });
    return box(acct.name, { tone: wallets.some((w) => w.id === current.id) ? 'ink' : 'soft', side, className: 'acct-box' },
      opened ? accountTools(acct, wallets, err, again) : null,
      h('div', { class: 'accts' }, wallets.map((w) => walletRow(w, open, err, again))),
      add);
  });
  const menu = box('add', { tone: 'soft', className: 'add-box' },
    h('div', { class: 'menu' },
      menuRow('+ new account', 'a new recovery phrase', () => createWallet()),
      menuRow('+ import an account', '12 or 24 words', () => importPhrase()),
      menuRow('+ import a private key', 'one wallet', () => importKey())));
  (stay ? redraw : show)(...screen('accounts', () => go.home(), ...boxes, menu, err));
}

const menuRow = (label, hint, onclick) => h('button', { class: 'menu-row', type: 'button', onclick },
  h('b', null, label), h('span', { class: 'dim' }, hint), h('span', { class: 'go-arrow' }, '->'));

function walletRow(w, open, err, again) {
  const on = w.id === ctx.S.active;
  const opened = open?.kind === 'wallet' && open.id === w.id;
  const chains = chainsOf(w);
  const first = chains[0];
  const row = h('div', { class: `acct-row ${on ? 'on' : ''}` },
    h('button', { class: 'pick', type: 'button', title: on ? "the wallet you're in" : `switch to ${w.name}`, onclick: async () => {
      try { ctx.S = await call('wallet.select', { id: w.id }); forget(); go.home(); } catch (e) { showErr(err, e); }
    } },
      h('span', { class: 'mark' }, on ? '>' : ' '), iconArt(w.icon, 'tiny'), h('b', null, w.name), h('span', { class: 'dim addr-s' }, first ? short(w.chains[first].address, 4) : ''),
      w.account === 'keys' ? chip(`${CHAIN[first]?.ticker.toLowerCase() ?? '?'} key`) : null),
    h('button', { class: 'mini', type: 'button', title: 'manage this wallet', onclick: () => again(opened ? null : { kind: 'wallet', id: w.id }) }, opened ? 'close' : '..'));
  if (!opened) return row;
  return h('div', { class: 'acct-open' }, row, walletTools(w, err, again, row));
}

/** A wallet's tools: its icon (saved the moment it's picked), its address on each chain, its name, its private keys
 * (after your password), and removing it. */
function walletTools(w, err, again, row) {
  const chains = chainsOf(w);
  const icons = iconPicker(w.icon, async (icon) => {
    try { ctx.S = await call('wallet.icon', { id: w.id, icon }); row.querySelector('.icon-art.tiny')?.replaceWith(iconArt(icon, 'tiny')); } catch (e) { showErr(err, e); }
  });
  const name = h('input', { class: 'input', value: w.name, maxlength: '24', autocomplete: 'off', spellcheck: 'false' });
  const save = h('button', { class: 'btn-go btn-sm', type: 'button' }, 'rename');
  busyButton(save, async () => { try { ctx.S = await call('wallet.rename', { id: w.id, name: name.value }); again({ kind: 'wallet', id: w.id }); } catch (e) { showErr(err, e); } });
  // one chain's key at a time
  let keyChain = chains[0];
  const reveal = h('div');
  const drawReveal = () => reveal.replaceChildren(secretReveal((password) => call('wallet.export', { id: w.id, chain: keyChain, password }), {
    label: `${CHAIN[keyChain].name} private key`, warn: 'anyone with this key owns this wallet. Never paste it into a website.',
  }));
  drawReveal();
  const rm = h('button', { class: 'btn btn-sm danger', type: 'button' }, 'remove');
  busyButton(rm, async () => {
    if (rm.dataset.armed !== '1') { rm.dataset.armed = '1'; rm.textContent = w.account === 'keys' ? 'erase its key? click again' : 'hide it? click again'; return; }
    try { ctx.S = await call('wallet.remove', { id: w.id }); forget(); again(null); } catch (e) { showErr(err, e); }
  });
  return h('div', { class: 'acct-tools' },
    icons.node,
    h('div', { class: 'addrs' }, chains.map((c) => h('div', { class: 'addr-line' }, h('span', { class: 'label' }, CHAIN[c].name), addressBlock(w.chains[c].address, { copy: true })))),
    h('div', { class: 'row' }, name, save),
    h('div', { class: 'stack tight' },
      chains.length > 1 ? seg(chains.map((c) => [c, CHAIN[c].name]), keyChain, (c) => { keyChain = c; drawReveal(); }, { label: 'which key' }) : null,
      reveal),
    h('div', { class: 'row' }, rm));
}

/** An account's tools: its name, its recovery phrase (after your password), and removing it with its wallets. */
function accountTools(acct, wallets, err, again) {
  const name = h('input', { class: 'input', value: acct.name, maxlength: '20', autocomplete: 'off', spellcheck: 'false' });
  const save = h('button', { class: 'btn-go btn-sm', type: 'button' }, 'rename');
  busyButton(save, async () => { try { ctx.S = await call('account.rename', { id: acct.id, name: name.value }); again({ kind: 'account', id: acct.id }); } catch (e) { showErr(err, e); } });
  const rm = h('button', { class: 'btn btn-sm danger', type: 'button' }, 'remove this account');
  busyButton(rm, async () => {
    if (rm.dataset.armed !== '1') { rm.dataset.armed = '1'; rm.textContent = `erase its phrase and ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}? click again`; return; }
    try { ctx.S = await call('account.remove', { id: acct.id }); forget(); again(null); } catch (e) { showErr(err, e); }
  });
  return h('div', { class: 'acct-tools acct-level' },
    h('div', { class: 'row' }, name, save),
    secretReveal((password) => call('account.phrase', { id: acct.id, password }), { label: 'recovery phrase', warn: `these words are every wallet in ${acct.name}. Write them on paper; never type them into a website.` }),
    h('div', { class: 'row' }, rm));
}

/** A secret shown after your password, hidden again after a minute; no copy button on purpose (clipboards keep history). */
export function secretReveal(fetchSecret, { label, warn }) {
  const pwF = secretField({ placeholder: 'your password' });
  const err = errLine();
  const out = h('div', { class: 'secret-out' });
  const btn = h('button', { class: 'btn-go btn-sm', type: 'button', dataset: { busyText: 'checking' } }, `show ${label}`);
  busyButton(btn, async () => {
    err.hidden = true;
    try {
      const secret = await fetchSecret(pwF.input.value);
      pwF.input.value = '';
      const hide = h('button', { class: 'mini', type: 'button' }, 'hide');
      const shown = h('div', { class: 'secret fr red' }, h('code', null, secret), h('div', { class: 'row' }, h('span', { class: 'dim' }, 'no copy button on purpose: clipboards keep history'), hide));
      hide.addEventListener('click', () => out.replaceChildren());
      out.replaceChildren(shown);
      setTimeout(() => { if (shown.isConnected) out.replaceChildren(); }, 60_000);
    } catch (e) { showErr(err, e); }
  });
  return h('div', { class: 'reveal' }, h('p', { class: 't-red' }, warn), pwF.node, btn, err, out);
}
