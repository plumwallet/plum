// The Ethereum networks in plum's pages: their names and tags, a network said loudly (the approval window and the
// review), the coins the other networks hold as lines on home (only where there's something), and your own RPC per
// network in settings.
import { prettyAmount, usd } from '../shared/format.js';
import { busyButton, h } from './dom.js';
import { coinMark, seg } from './parts.js';

/** The four networks, as the background describes them (state.evm), or plum's own list before it has answered. */
export const NETS = [
  { key: 'ethereum', id: 1, name: 'ethereum', title: 'Ethereum', tag: 'eth', symbol: 'ETH', explorerName: 'etherscan' },
  { key: 'base', id: 8453, name: 'base', title: 'Base', tag: 'base', symbol: 'ETH', explorerName: 'basescan' },
  { key: 'arbitrum', id: 42161, name: 'arbitrum', title: 'Arbitrum', tag: 'arb', symbol: 'ETH', explorerName: 'arbiscan' },
  { key: 'polygon', id: 137, name: 'polygon', title: 'Polygon', tag: 'pol', symbol: 'POL', explorerName: 'polygonscan' },
];
export const netOf = (key) => NETS.find((n) => n.key === key) ?? NETS[0];
/** A network's short tag (eth, base, arb, pol), as tokens and history lines carry it. */
export const netTag = (key) => netOf(key).tag;

/** A network said loudly: its name in capitals, bold, in brackets, never smaller than the text around it. */
export const netLoud = (key) => h('span', { class: `net evm-net n-${netOf(key).key}`, title: `on ${netOf(key).title} (chain ${netOf(key).id})` }, netOf(key).title);

/** The coin of a network other than Ethereum, as a line under Ethereum's ETH on home: only when it holds some, or
 * tokens there (so a token that can't move for want of gas shows why). A click sends it. */
export function networkCoins(b) {
  const held = new Set((b?.tokens ?? []).map((t) => t.net));
  return (b?.networks ?? []).filter((n) => n.amount != null && (BigInt(n.amount) > 0n || held.has(n.net)));
}

export function networkRow(n, onSend) {
  return h('button', { class: 'tk', type: 'button', title: `send ${n.symbol} on ${n.title}`, onclick: () => onSend({ chain: 'eth', mint: null, net: n.net }) },
    coinMark(n.symbol === 'POL' ? 'pol' : 'eth'),
    h('span', { class: 'tk-n' }, h('b', null, n.symbol), h('span', { class: 'dim' }, n.symbol === 'POL' ? 'polygon' : `on ${n.title.toLowerCase()}`)),
    h('span', { class: 'tk-v' }, h('b', null, prettyAmount(BigInt(n.amount), n.decimals)), h('span', { class: 'dim' }, usd(n.usd))));
}

/** The other networks' coins as holdings (for picking what to send): like a token, with its network. */
export const networkHoldings = (b) => networkCoins(b).map((n) => ({
  chain: 'eth', net: n.net, mint: null, symbol: n.symbol, name: n.symbol === 'POL' ? 'polygon' : `ether on ${n.title.toLowerCase()}`,
  amount: n.amount, decimals: n.decimals, price: n.price, usd: n.usd, verified: true,
}));

/** Networks that couldn't be read, for home's error line. */
export const networkErrors = (b) => (b?.networks ?? []).filter((n) => n.error).map((n) => `${n.title.toLowerCase()}: ${n.error}`);

/** Settings: your own RPC for each Ethereum network, one at a time (a row of networks, then its field). An empty field
 * saved goes back to plum's public ones; one that isn't on that network is refused. */
let rpcOn = 'ethereum'; // the network last picked, kept while settings is drawn again after a save
export function evmRpcField(evm, set) {
  const slot = h('div', { class: 'stack tight' });
  const draw = () => {
    const n = evm.find((x) => x.key === rpcOn) ?? evm[0];
    const input = h('input', { class: 'input', value: n.rpc, placeholder: "plum's public rpcs", spellcheck: 'false', autocomplete: 'off' });
    const save = h('button', { class: 'btn-go btn-sm', type: 'button', dataset: { busyText: 'checking' } }, 'save');
    busyButton(save, () => set({ evmRpc: { [n.key]: input.value.trim() } }));
    slot.replaceChildren(
      h('div', { class: 'field' }, h('label', null, h('span', null, `${n.name} rpc`), n.rpc ? h('span', { class: 'dim' }, 'yours') : null), input),
      h('div', { class: 'row' }, save));
  };
  draw();
  return [seg(evm.map((n) => [n.key, n.tag]), rpcOn, (v) => { rpcOn = v; draw(); }, { label: 'which network' }), slot];
}
