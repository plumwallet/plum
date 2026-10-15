// NFTs, in the popup: what the wallet holds on Solana and Ethereum (and Base, Arbitrum and Polygon), each NFT a typed card (its collection, its name, its
// id: never its picture, which would tell the picture's host your IP), and sending one: the background builds the
// transfer its standard takes and simulates it, and it's reviewed here like a send.
import { short } from '../shared/format.js';
import { call } from './api.js';
import { active, errLine, field, forget, go, redraw, screen, show, showErr } from './app.js';
import { busyButton, h } from './dom.js';
import { netOf } from './evm.js';
import { CHAIN, actions, addressBlock, box, chainsOf, kv, previewBlock, seg, spinner } from './parts.js';

const STANDARD = { legacy: 'Metaplex NFT', programmable: 'programmable NFT', core: 'Core asset', compressed: 'compressed NFT', erc721: 'ERC-721', erc1155: 'ERC-1155' };
/** NFT chains, in plum's order. */
const NFT_CHAINS = ['sol', 'eth'];

/** The lists read this popup, by wallet and chain. */
const lists = new Map();

/** An NFT's id as a line: a Solana one by its address, an Ethereum one by its number. */
const idLine = (n) => (n.chain === 'eth' ? `#${n.id.length > 12 ? `${n.id.slice(0, 10)}..` : n.id}` : short(n.id, 4));
/** An NFT's name, or its id when it has none. */
const nameOf = (n) => n.name ?? (n.chain === 'eth' ? `#${n.id.length > 16 ? `${n.id.slice(0, 14)}..` : n.id}` : short(n.id, 6));
const collectionOf = (n) => n.collection?.name ?? (n.collection ? short(n.collection.id, 4) : 'no collection');
/** Where an NFT is: its chain, or for an Ethereum one, its network (Base, Arbitrum, Polygon or Ethereum itself). */
const whereOf = (n) => (n.chain === 'eth' && n.net ? netOf(n.net).name : CHAIN[n.chain].name);
/** Where the list is: Ethereum's covers its other networks too. */
const listedOn = (c) => (c === 'eth' ? 'ethereum, base, arbitrum and polygon' : CHAIN[c].name);

/* ------------------------------------------------------------ the list */

export async function nftsScreen(chain = null) {
  const w = active();
  const chains = chainsOf(w).filter((c) => NFT_CHAINS.includes(c));
  if (!chains.length) { show(...screen('nfts', () => go.home(), h('div', { class: 'note' }, `${w.name} has no Solana or Ethereum address (it's an imported key).`))); return; }
  const on = chains.includes(chain) ? chain : chains[0];
  const grid = h('div', { class: 'nft-grid' });
  const status = h('div', { class: 'nft-status' }, h('span', { 'aria-label': 'reading' }, spinner()));
  const note = h('p', { class: 'fine', hidden: true });
  const again = h('button', { class: 'mini', type: 'button', title: 'read them again' }, 'refresh');
  const pick = chains.length > 1 ? seg(chains.map((c) => [c, CHAIN[c].name]), on, (c) => nftsScreen(c), { label: 'which chain' }) : null;
  (chain ? redraw : show)(...screen('nfts', () => go.home(),
    h('div', { class: 'row' }, pick, h('span', { class: 'grow' }), again),
    status, grid, note,
    h('p', { class: 'fine' }, 'plum never loads an NFT\'s picture: a picture tells its host your IP. Names come from the NFT itself, and anyone can name one anything.')));
  const key = `${w.id}:${on}`;
  const paint = (r) => {
    grid.replaceChildren(...r.items.map((n) => card(n)));
    const count = r.items.length;
    status.replaceChildren(h('span', { class: 'dim' }, count ? `${count} ${count === 1 ? 'NFT' : 'NFTs'} on ${listedOn(on)}` : `no NFTs on ${listedOn(on)} yet`));
    note.hidden = r.via !== 'accounts' && !r.errors?.length;
    note.textContent = r.errors?.length ? `plum couldn't read these, so their NFTs aren't listed: ${r.errors.join(' · ')}` : "your RPC can't list Core or compressed NFTs (it has no DAS): these are your Metaplex NFTs only.";
  };
  const load = async () => {
    again.disabled = true;
    again.replaceChildren(spinner());
    try {
      const r = await call('nfts.list', { chain: on });
      lists.set(key, r);
      if (grid.isConnected) paint(r);
    } catch (e) {
      if (grid.isConnected) status.replaceChildren(h('span', { class: 't-red' }, e.message));
    } finally {
      again.disabled = false;
      again.textContent = 'refresh';
    }
  };
  again.addEventListener('click', load);
  if (lists.has(key)) paint(lists.get(key));
  load();
}

/** An NFT as a typed card: its collection, its name, its id. */
function card(n) {
  const unverified = n.collection && n.collection.verified === false;
  return h('button', { class: 'nft-card', type: 'button', title: `${nameOf(n)}: open it`, onclick: () => nftScreen(n) },
    h('span', { class: `nft-col ${unverified ? 'unv' : ''}` }, collectionOf(n)),
    h('b', { class: 'nft-name' }, nameOf(n)),
    h('span', { class: 'nft-id' }, idLine(n), n.amount && n.amount !== '1' ? ` x${n.amount}` : '', n.net && n.net !== 'ethereum' ? h('span', { class: 'chain-tag' }, ` ${n.network}`) : null));
}

/* ------------------------------------------------------------ one NFT, and sending it */

function nftScreen(n, to = '') {
  const toIn = h('input', { class: 'input', spellcheck: 'false', autocomplete: 'off', placeholder: CHAIN[n.chain].hint, value: to });
  const err = errLine();
  const paste = h('button', { class: 'mini', type: 'button', onclick: async () => { try { toIn.value = (await navigator.clipboard.readText()).trim(); } catch { toIn.focus(); } } }, 'paste');
  const next = h('button', { class: 'btn-go block', type: 'button', dataset: { busyText: 'simulating' } }, 'review ->');
  busyButton(next, async () => {
    err.hidden = true;
    const asked = toIn.value.trim();
    try {
      const prep = await call('nfts.prepare', n.chain === 'eth'
        ? { chain: 'eth', net: n.net ?? null, contract: n.contract, id: n.id, standard: n.standard, amount: n.amount ?? '1', to: asked }
        : { chain: 'sol', id: n.id, to: asked });
      review(prep, n, () => nftScreen(n, asked));
    } catch (e) { showErr(err, e); }
  });
  const unverified = n.collection && n.collection.verified === false;
  show(...screen('nft', () => nftsScreen(n.chain),
    box(null, { tone: 'soft' },
      h('b', { class: 'nft-title' }, nameOf(n)),
      kv('collection', collectionOf(n)),
      unverified ? kv('collection checked', 'no', 'warn') : null,
      kv('standard', STANDARD[n.standard] ?? n.standard),
      kv('on', whereOf(n)),
      n.chain === 'eth' ? kv('token id', n.id.length > 24 ? `${n.id.slice(0, 22)}..` : n.id) : null,
      n.amount && n.amount !== '1' ? kv('you hold', n.amount) : null),
    h('div', { class: 'label' }, n.chain === 'eth' ? 'contract' : 'id'),
    addressBlock(n.chain === 'eth' ? n.contract : n.id, { copy: true }),
    n.frozen ? h('div', { class: 'note hot' }, "it's frozen (staked or listed somewhere): it can't be sent until it's unfrozen") : null,
    field(n.amount && n.amount !== '1' ? `send all ${n.amount} to` : 'send to', h('div', { class: 'input-group' }, toIn, h('span', { class: 'suffix-btn' }, paste))),
    err, actions(() => nftsScreen(n.chain), next)));
  toIn.focus();
}

/** The last look before signing: what leaves, every warning, then your yes. */
function review(prep, n, back) {
  const dangers = [...(prep.warnings ?? []), ...(prep.preview?.warnings ?? [])].some((x) => x.level === 'danger');
  const ack = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false' }, 'i understand the risk, sign anyway');
  const next = h('button', { class: 'btn-go block lg', type: 'button', dataset: { busyText: 'signing' }, disabled: dangers }, 'send it ->');
  ack.addEventListener('click', () => { const on = !ack.classList.contains('on'); ack.classList.toggle('on', on); ack.setAttribute('aria-pressed', String(on)); next.disabled = !on; });
  const err = errLine();
  busyButton(next, async () => {
    err.hidden = true;
    try {
      const done = await call('nfts.submit', { id: prep.id });
      forget();
      lists.clear();
      go.sent(done);
    } catch (e) { showErr(err, e); }
  });
  const to = prep.summary?.to ?? '';
  show(...screen('review', null,
    box('sending', { tone: 'ink' },
      kv('nft', nameOf(n)),
      kv('collection', collectionOf(n)),
      n.amount && n.amount !== '1' ? kv('how many', n.amount) : null,
      kv('standard', STANDARD[n.standard] ?? n.standard),
      kv('to', short(to, 6)),
      n.chain === 'eth' ? kv('on', whereOf(n), 'loud') : kv('on', CHAIN[n.chain].name),
      addressBlock(to)),
    previewBlock(prep.preview, { extra: prep.warnings }),
    dangers ? ack : null, err, actions(back, next)));
}
