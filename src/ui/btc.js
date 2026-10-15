// The popup's Bitcoin pieces: a wallet's two addresses (native segwit bc1q and taproot bc1p), picked on the receive
// screen and listed in a wallet's tools.
import { h } from './dom.js';
import { addressBlock, seg } from './parts.js';

export const BTC_KINDS = [['p2wpkh', 'segwit bc1q'], ['p2tr', 'taproot bc1p']];

/** The address to show for a kind: the taproot one when asked for and the wallet has it, else bc1q. */
export const btcAddressOf = (w, kind) => (kind === 'p2tr' && w.chains.btc?.taproot?.address ? w.chains.btc.taproot.address : w.chains.btc.address);

/** Under the receive screen's chain picker: which of the two addresses, and what each is for. */
export function btcReceivePick(w, kind, onPick) {
  if (!w.chains.btc?.taproot?.address) return null;
  return [
    h('div', { class: 'row centred' }, seg(BTC_KINDS, kind === 'p2tr' ? 'p2tr' : 'p2wpkh', onPick, { label: 'which bitcoin address' })),
    h('p', { class: 'fine center' }, kind === 'p2tr'
      ? 'your taproot address: the one ordinals and runes sites use. Bitcoin sent to either address is yours.'
      : 'your native segwit address, for payments. Bitcoin sent to either address is yours.'),
  ];
}

/** A wallet's taproot address, as a line in its tools (beside its bc1q one). */
export function taprootLine(w) {
  const a = w.chains.btc?.taproot?.address;
  return a ? h('div', { class: 'addr-line' }, h('span', { class: 'label' }, 'bitcoin taproot'), addressBlock(a, { copy: true })) : null;
}
