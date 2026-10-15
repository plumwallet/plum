// The approval window's Bitcoin requests: connecting (which addresses the site will see), a message to sign (its
// text, the address and the format), a PSBT (what leaves your wallet and what comes back, every input and output, the
// fee, who signs what, each danger), and a send a site asked for (to whom, how much, the fee). approve.js draws the
// frame around them: the site, the warnings' "i understand", the answers.
import { prettyAmount, short } from '../shared/format.js';
import { h } from './dom.js';
import { addressBlock, box, chip, deltaLine, kv, warnings } from './parts.js';

const btc = (sats) => `${prettyAmount(BigInt(sats), 8, { sig: 8 })} BTC`;
const PURPOSE = { payment: 'payment (bc1q)', ordinals: 'ordinals (bc1p)' };
const SIGHASH = { 0: 'DEFAULT', 1: 'ALL', 2: 'NONE', 3: 'SINGLE', 129: 'ALL|ANYONECANPAY', 130: 'NONE|ANYONECANPAY', 131: 'SINGLE|ANYONECANPAY' };

/** What each Bitcoin request asks, for the site's box. */
export const BTC_TITLES = { btcConnect: 'connect', btcMessage: 'sign a message', btcPsbt: 'sign a transaction', btcSend: 'send bitcoin' };
export function btcAsk(view) {
  if (view.kind === 'btcConnect') return 'wants to see your Bitcoin addresses and ask you to approve transactions. It cannot move anything without asking.';
  if (view.kind === 'btcMessage') return "wants you to sign a message. Signing a message can't move bitcoin, but some apps act on signed messages (logins, orders): read it.";
  if (view.kind === 'btcPsbt') return view.btc?.broadcast ? 'wants you to sign a transaction (a PSBT), which plum then sends.' : 'wants you to sign a transaction (a PSBT). It sends it itself, when it likes.';
  return 'wants you to send bitcoin. Plum builds the transaction, signs it and sends it.';
}

/** A message, a connection: drawn at once (nothing to read from the chain). */
export function btcBody(view) {
  const v = view.btc ?? {};
  if (view.kind === 'btcConnect') {
    return [box('it will see', { tone: 'soft' },
      ...(v.shown ?? []).map((a) => h('div', { class: 'addr-line' }, h('span', { class: 'label' }, PURPOSE[a.purpose] ?? a.purpose), addressBlock(a.address))),
      v.note ? h('p', { class: 'dim' }, `the site says: ${v.note}`) : null),
      h('p', { class: 'fine' }, 'only connect to sites you trust')];
  }
  if (view.kind === 'btcMessage') {
    return [
      v.problems?.length ? h('div', { class: 'warns' }, v.problems.map((p) => h('div', { class: 'note err lvl-danger' }, p))) : null,
      box('signed by', { tone: 'soft' }, kv('address', PURPOSE[v.purpose] ?? ''), addressBlock(v.address), kv('format', v.protocol === 'ECDSA' ? 'legacy (ECDSA)' : 'BIP-322')),
      v.text != null
        ? box('the message', { tone: 'soft' }, h('pre', { class: 'msg' }, v.text))
        : box('the message', { tone: 'hot' },
          h('div', { class: 'note hot' }, "this message isn't readable text, so plum can't tell you what it is. Only sign it if you know exactly what the site uses it for."),
          h('pre', { class: 'msg hex' }, v.hex + (v.bytes > 512 ? ' ...' : '')), kv('size', `${v.bytes} bytes`)),
    ].filter(Boolean);
  }
  if (view.kind === 'btcSend') {
    return [box('to', { tone: 'ink' }, ...(v.recipients ?? []).flatMap((r) => [kv('amount', btc(r.amount)), addressBlock(r.address)]))];
  }
  return [];
}

/** One input or output, as a line: its number, amount, whose, and (for an input) what plum does with it. */
function ioLine(x, input) {
  const who = x.mine ? (x.mine === 'p2tr' ? 'yours (bc1p)' : 'yours (bc1q)') : x.kind === 'runestone' ? 'runestone (runes data)' : x.kind === 'data' ? 'data (OP_RETURN)' : short(x.address ?? 'a script', 6);
  const what = input ? (x.sign ? `plum signs it, ${SIGHASH[x.sighash] ?? x.sighash}` : x.signed ? 'signed by someone else' : x.mine ? 'yours, not signed now' : 'not signed yet') : null;
  return kv(`${input ? 'in' : 'out'} ${x.index}`, [x.value != null ? btc(x.value) : '? BTC', `  ${who}`, what ? `  ${what}` : ''].join(''), x.mine ? 'good' : '');
}

/** What a PSBT does: computed by the background against the chain (btc-psbt.js). */
function psbtPreview(p) {
  const fixed = p.fixed;
  const side = p.checked ? chip('checked on chain', 'green') : chip('not checked', 'hot');
  return h('div', { class: 'preview' },
    box(fixed ? 'what changes' : 'what your signature fixes', { tone: 'soft', side },
      BigInt(p.leaves) > 0n ? deltaLine(-BigInt(p.leaves), 8, 'BTC leaves your wallet') : null,
      BigInt(p.arrives) > 0n ? deltaLine(BigInt(p.arrives), 8, fixed ? 'BTC comes back to you' : 'BTC paid to you') : null,
      fixed ? h('p', { class: BigInt(p.net) < 0n ? 't-red' : 't-go' }, `net: ${BigInt(p.net) < 0n ? '' : '+'}${btc(p.net)}`) : h('p', { class: 'dim' }, 'the rest of the transaction can still change after you sign')),
    warnings(p.warnings),
    h('div', { class: 'kvs' },
      p.fee != null && BigInt(p.fee) >= 0n ? kv('network fee', `${btc(p.fee)} · ${Math.round(p.feeRate ?? 0)} sat/vB`) : kv('network fee', 'not known yet'),
      kv('to others', btc(p.toOthers)),
      kv('signers', `you: ${p.inputs.filter((x) => x.sign).length} of ${p.inputs.length} inputs`, 'good'),
      kv('sent by', p.broadcast ? 'plum, once you approve' : 'the site')),
    box('inputs', { tone: 'soft' }, ...p.inputs.map((x) => ioLine(x, true))),
    box('outputs', { tone: 'soft' }, ...p.outputs.map((x) => ioLine(x, false))),
    h('details', { class: 'more' },
      h('summary', null, h('span', null, '-- details'), h('span', { class: 'dim' }, `bitcoin · about ${p.vsize} vB`)),
      h('ol', { class: 'ixs' }, p.inputs.map((x) => h('li', null, `${short(x.txid, 8)}:${x.vout}  `, h('span', { class: 'dim' }, x.verified === 'chain' ? 'checked on chain' : x.verified === 'tx' ? 'previous transaction given' : 'as the site says'))))));
}

/** A send a site asked for, built by plum: what leaves, the fee and its rate, the coins it spends. */
function sendPreview(p) {
  return h('div', { class: 'preview' },
    box('what changes', { tone: 'soft', side: chip('exact', 'green') },
      deltaLine(-BigInt(p.amount), 8, 'BTC sent'),
      deltaLine(-BigInt(p.fee), 8, 'BTC network fee')),
    warnings(p.warnings),
    h('div', { class: 'kvs' },
      kv('fee rate', `${p.feeRate} sat/vB · ${p.vsize} vB`),
      kv('signers', '1 (you)', 'good'),
      kv('coins spent', p.taproot ? `${p.inputs} (${p.taproot} from bc1p)` : String(p.inputs)),
      kv('change back to you', BigInt(p.change) > 0n ? btc(p.change) : 'none')));
}

/** The preview of a Bitcoin request, or why plum won't sign it. */
export function btcPreview(p) {
  if (p.error) return h('div', { class: 'note err lvl-danger' }, `plum won't sign this: ${p.error}`);
  return p.kind === 'psbt' ? psbtPreview(p) : sendPreview(p);
}
