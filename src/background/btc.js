// Bitcoin (mainnet only): each wallet's two addresses (native segwit bc1q... and taproot bc1p..., as Phantom has
// them), their coins read from mempool.space (blockstream.info if it's down), and sends written from bytes here: coins
// picked from both, the fee worked out from today's rates, BIP-143 signatures for bc1q coins and BIP-341 key-path ones
// for bc1p coins, change back to the bc1q address. Opt-in replace-by-fee, so a stuck send can be sped up by any wallet.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { concat, hex } from '../shared/bytes.js';
import { cleanLine } from '../shared/text.js';
import { SIGHASH, serializeTx, sighashV0, sighashV1, sizeOf, txidOf } from './btc-tx.js';
import { hash160 } from './keys.js';
import { NetError, failover, getJson, pool, request } from './net.js';
import { verifyKeyPath } from './taproot.js';

export const ESPLORA = ['https://mempool.space/api', 'https://blockstream.info/api'];
export const EXPLORER = 'https://mempool.space';
export const DUST = 546n;
const MAX_FEE_RATE = 500; // sat/vB: anything above is a mistake
const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const b58check = createBase58check(sha256);

/* ------------------------------------------------------------ addresses and the scripts they stand for */

/** The output script an address pays to, and its kind: p2wpkh, p2wsh, p2tr, p2pkh, p2sh. Mainnet only. */
export function addressScript(address) {
  const a = String(address ?? '').trim();
  if (/^(bc1|BC1)/.test(a)) {
    const lower = a.toLowerCase();
    if (a !== lower && a !== a.toUpperCase()) throw fail('that Bitcoin address mixes capitals and small letters: check it');
    let prefix, version, program;
    try {
      const d = bech32.decode(lower, 90);
      prefix = d.prefix;
      version = d.words[0];
      if (version !== 0) throw new Error('v1+ uses bech32m');
      program = bech32.fromWords(d.words.slice(1));
    } catch {
      let d;
      try { d = bech32m.decode(lower, 90); } catch { throw fail("that isn't a Bitcoin address: its checksum doesn't match (a typo?)"); }
      prefix = d.prefix;
      version = d.words[0];
      if (version === 0) throw fail("that isn't a Bitcoin address: its checksum doesn't match (a typo?)");
      program = bech32m.fromWordsUnsafe(d.words.slice(1));
      if (!program) throw fail("that isn't a Bitcoin address");
    }
    // the prefix is everything before the last 1, so "bc1q1..." starts like an address but is one for another network
    if (prefix !== 'bc') throw fail("that isn't a Bitcoin main-network address");
    if (version === 0 && program.length === 20) return { kind: 'p2wpkh', script: concat(Uint8Array.of(0x00, 0x14), program) };
    if (version === 0 && program.length === 32) return { kind: 'p2wsh', script: concat(Uint8Array.of(0x00, 0x20), program) };
    if (version === 1 && program.length === 32) return { kind: 'p2tr', script: concat(Uint8Array.of(0x51, 0x20), program) };
    throw fail("plum doesn't send to that kind of Bitcoin address yet");
  }
  if (/^(tb1|bcrt1|[mn2])/i.test(a)) throw fail("that's a testnet Bitcoin address: plum is on Bitcoin's main network");
  let raw;
  try { raw = b58check.decode(a); } catch { throw fail("that isn't a Bitcoin address"); }
  if (raw.length !== 21) throw fail("that isn't a Bitcoin address");
  const h = raw.subarray(1);
  if (raw[0] === 0x00) return { kind: 'p2pkh', script: concat(Uint8Array.of(0x76, 0xa9, 0x14), h, Uint8Array.of(0x88, 0xac)) };
  if (raw[0] === 0x05) return { kind: 'p2sh', script: concat(Uint8Array.of(0xa9, 0x14), h, Uint8Array.of(0x87)) };
  throw fail("that isn't a Bitcoin main-network address");
}
export const isBtcAddress = (a) => { try { addressScript(a); return true; } catch { return false; } };

/** What an output script pays to, as people read it: { kind, address } (address null for data and scripts no address
 * stands for). A runestone (OP_RETURN OP_13) is kind 'runestone'. */
export function scriptInfo(script) {
  const s = script, n = s.length;
  const words = (version, program) => [version, ...bech32.toWords(program)];
  if (n === 22 && s[0] === 0x00 && s[1] === 0x14) return { kind: 'p2wpkh', address: bech32.encode('bc', words(0, s.subarray(2)), 90) };
  if (n === 34 && s[0] === 0x00 && s[1] === 0x20) return { kind: 'p2wsh', address: bech32.encode('bc', words(0, s.subarray(2)), 90) };
  if (n === 34 && s[0] === 0x51 && s[1] === 0x20) return { kind: 'p2tr', address: bech32m.encode('bc', words(1, s.subarray(2)), 90) };
  if (n === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return { kind: 'p2pkh', address: b58check.encode(concat(Uint8Array.of(0x00), s.subarray(3, 23))) };
  if (n === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return { kind: 'p2sh', address: b58check.encode(concat(Uint8Array.of(0x05), s.subarray(2, 22))) };
  if (n >= 1 && s[0] === 0x6a) return { kind: n >= 2 && s[1] === 0x5d ? 'runestone' : 'data', address: null };
  return { kind: 'other', address: null };
}

/** A native segwit address's 20-byte key hash (the address plum's change goes back to). */
function ownKeyHash(address) {
  const { kind, script } = addressScript(address);
  if (kind !== 'p2wpkh') throw fail('plum only spends from native segwit (bc1q) addresses');
  return script.subarray(2);
}

/** A taproot address's 32-byte output key. */
function ownOutputKey(address) {
  const { kind, script } = addressScript(address);
  if (kind !== 'p2tr') throw fail('that taproot address isn\'t a bc1p address');
  return script.subarray(2);
}

/* ------------------------------------------------------------ sizes and fees */

// virtual bytes: the transaction's frame (with segwit's marker and flag), each input with its witness (a native segwit
// one with a 72-byte signature and its key, a taproot one with a 64-byte key-path signature), each kind of output
const VB = { frame: 10.5, input: { p2wpkh: 68, p2tr: 57.5 }, out: { p2wpkh: 31, p2wsh: 43, p2tr: 43, p2pkh: 34, p2sh: 32 } };
/** The virtual size of a send: `inputs` is how many (all native segwit) or their kinds, `outKinds` the outputs'. */
export const vsizeOf = (inputs, outKinds) => Math.ceil(VB.frame
  + (typeof inputs === 'number' ? inputs * VB.input.p2wpkh : inputs.reduce((n, k) => n + VB.input[k], 0))
  + outKinds.reduce((n, k) => n + VB.out[k], 0));

const coinKind = (c) => (c.kind === 'p2tr' ? 'p2tr' : 'p2wpkh');

/**
 * Coins to spend for `amount` sats to `to` (or to several `recipients`: [{ to, amount }]) at `feeRate` sat/vB, change
 * back to `change` (a bc1q address). Coins are { txid, vout, value, confirmed, kind: 'p2wpkh' | 'p2tr' }: biggest
 * first, confirmed before unconfirmed. Change too small to be worth an output is left to the miners. With `max`, every
 * coin goes to the one address and the amount is what's left after the fee.
 * Returns { inputs, outputs: [{ script, value, kind, mine }], fee, vsize, amount (the total sent) }.
 */
export function plan({ utxos, to, amount, recipients = null, feeRate, change, max = false }) {
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > MAX_FEE_RATE) throw fail(`that fee rate (${feeRate} sat/vB) doesn't look right`);
  const pays = (recipients ?? [{ to, amount }]).map((r) => ({ ...addressScript(r.to), amount: r.amount }));
  if (!pays.length || pays.length > 20) throw fail('a send pays 1 to 20 addresses');
  if (max && pays.length !== 1) throw fail('"max" sends everything to one address');
  const mine = ownKeyHash(change);
  const coins = [...utxos].sort((a, b) => (a.confirmed === b.confirmed ? Number(b.value - a.value) : a.confirmed ? -1 : 1));
  if (!coins.length) throw fail('there are no bitcoin in this wallet to send');
  const changeScript = concat(Uint8Array.of(0x00, 0x14), mine);
  const outKinds = pays.map((d) => d.kind);
  const size = (cs, kinds) => vsizeOf(cs.map(coinKind), kinds);
  const fee = (cs, kinds) => BigInt(Math.ceil(size(cs, kinds) * feeRate));
  const outputs = (values) => pays.map((d, i) => ({ script: d.script, value: values[i], kind: d.kind, mine: false }));
  if (max) {
    const total = coins.reduce((n, c) => n + c.value, 0n);
    const f = fee(coins, outKinds);
    const send = total - f;
    if (send < DUST) throw fail("after the network fee there's too little left to send");
    return { inputs: coins, outputs: outputs([send]), fee: f, vsize: size(coins, outKinds), amount: send };
  }
  const wants = pays.map((d) => BigInt(d.amount));
  if (wants.some((w) => w < DUST)) throw fail(`a Bitcoin send has to be at least ${DUST} sats (0.00000546 BTC)`);
  const want = wants.reduce((n, w) => n + w, 0n);
  const picked = [];
  let total = 0n;
  for (const c of coins) {
    picked.push(c);
    total += c.value;
    const withChange = fee(picked, [...outKinds, 'p2wpkh']);
    if (total >= want + withChange) {
      const rest = total - want - withChange;
      if (rest >= DUST) {
        return {
          inputs: picked,
          outputs: [...outputs(wants), { script: changeScript, value: rest, kind: 'p2wpkh', mine: true }],
          fee: withChange, vsize: size(picked, [...outKinds, 'p2wpkh']), amount: want,
        };
      }
      // the change would be dust: no change output, and the little that's left goes to the fee
      return { inputs: picked, outputs: outputs(wants), fee: total - want, vsize: size(picked, outKinds), amount: want };
    }
    const noChange = fee(picked, outKinds);
    if (total >= want + noChange) return { inputs: picked, outputs: outputs(wants), fee: total - want, vsize: size(picked, outKinds), amount: want };
  }
  const short = want + fee(coins, outKinds) - total;
  throw fail(`that's more than this wallet holds with the network fee (about ${short} sats short)`);
}

/* ------------------------------------------------------------ the transaction, as bytes */

const SEQUENCE = 0xfffffffd; // opt-in replace-by-fee
const VERSION = 2;
/** What a P2WPKH input satisfies, as BIP-143 signs it: the P2PKH script of its key hash. */
export const p2pkhCode = (keyHash) => concat(Uint8Array.of(0x76, 0xa9, 0x14), keyHash, Uint8Array.of(0x88, 0xac));

/** A planned send as a transaction (unsigned): plum's version, its coins with opt-in RBF, its outputs. */
const unsigned = (p, locktime = 0) => ({
  version: VERSION, locktime,
  inputs: p.inputs.map((c) => ({ txid: c.txid, vout: c.vout, sequence: SEQUENCE, scriptSig: new Uint8Array(0), witness: [] })),
  outputs: p.outputs,
});

/** BIP-143: what each native segwit input of a send signs (SIGHASH_ALL). */
export function sighashes(tx, keyHash) {
  const t = unsigned(tx, tx.locktime ?? 0);
  return tx.inputs.map((input, i) => sighashV0(t, i, p2pkhCode(keyHash), input.value, SIGHASH.ALL));
}

/**
 * Sign a planned send: every coin by the key it belongs to, bc1q coins (BIP-143, SIGHASH_ALL) by `owner.segwit`'s and
 * bc1p coins (BIP-341 key path, SIGHASH_DEFAULT) by `owner.taproot`'s, through `sign(address, sighashes)` (the wallet's
 * signBitcoinAs). Each signature is checked against the coin it spends before the transaction is written.
 * Returns { raw (hex), txid, vsize }.
 */
export async function signSpend(p, owner, sign) {
  const tx = unsigned(p);
  const keyHash = ownKeyHash(owner.segwit);
  const segwit = [], taproot = [];
  p.inputs.forEach((c, i) => (coinKind(c) === 'p2tr' ? taproot : segwit).push(i));
  const trKey = taproot.length ? ownOutputKey(owner.taproot) : null;
  if (segwit.length) {
    const digests = segwit.map((i) => sighashV0(tx, i, p2pkhCode(keyHash), p.inputs[i].value, SIGHASH.ALL));
    const { publicKey, signatures } = await sign(owner.segwit, digests);
    if (hex(hash160(publicKey)) !== hex(keyHash)) throw fail("the key that signed isn't this wallet's: nothing was sent");
    segwit.forEach((i, k) => {
      if (!secp256k1.verify(signatures[k], digests[k], publicKey, { prehash: false, format: 'der' })) throw fail('a signature did not verify: nothing was sent');
      tx.inputs[i].witness = [concat(signatures[k], Uint8Array.of(SIGHASH.ALL)), publicKey];
    });
  }
  if (taproot.length) {
    const script = concat(Uint8Array.of(0x51, 0x20), trKey);
    const prevouts = p.inputs.map((c) => ({ value: c.value, script: coinKind(c) === 'p2tr' ? script : concat(Uint8Array.of(0x00, 0x14), keyHash) }));
    const digests = taproot.map((i) => sighashV1(tx, i, prevouts, SIGHASH.DEFAULT));
    const { outputKey, signatures } = await sign(owner.taproot, digests);
    if (hex(outputKey) !== hex(trKey)) throw fail("the key that signed isn't this wallet's: nothing was sent");
    taproot.forEach((i, k) => {
      if (!verifyKeyPath(signatures[k], digests[k], trKey)) throw fail('a signature did not verify: nothing was sent');
      tx.inputs[i].witness = [signatures[k]];
    });
  }
  return { raw: hex(serializeTx(tx)), txid: txidOf(tx), vsize: sizeOf(tx).vsize };
}

/** A send from native segwit coins only, with `signer(sighashes) -> { publicKey, signatures (DER) }`. */
export const signPlan = (p, address, signer) => signSpend(p, { segwit: address }, (_, digests) => signer(digests));

/* ------------------------------------------------------------ reading the chain */

const esplora = (path, opts) => failover(ESPLORA, (base) => getJson(`${base}${path}`, { timeout: 15_000, ...opts }));

/** An address's coins: confirmed and unconfirmed (in the mempool) balances, in sats. */
export async function balance(address) {
  const s = await esplora(`/address/${address}`);
  const c = s?.chain_stats ?? {}, m = s?.mempool_stats ?? {};
  const confirmed = BigInt(c.funded_txo_sum ?? 0) - BigInt(c.spent_txo_sum ?? 0);
  const pending = BigInt(m.funded_txo_sum ?? 0) - BigInt(m.spent_txo_sum ?? 0);
  return { confirmed, pending, total: confirmed + pending, txs: Number(c.tx_count ?? 0) + Number(m.tx_count ?? 0) };
}

/** The coins an address can spend: [{ txid, vout, value (sats, bigint), confirmed }]. */
export async function utxos(address) {
  const list = await esplora(`/address/${address}/utxo`);
  return (Array.isArray(list) ? list : []).filter((u) => /^[0-9a-f]{64}$/.test(u?.txid ?? '') && Number.isInteger(u?.vout) && Number.isSafeInteger(u?.value) && u.value > 0)
    .map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed }));
}

/** The coins of both of a wallet's addresses ({ segwit, taproot }), each tagged with its kind and address. */
export async function coinsOf({ segwit, taproot = null }) {
  const [a, b] = await Promise.all([utxos(segwit), taproot ? utxos(taproot) : []]);
  return [...a.map((c) => ({ ...c, kind: 'p2wpkh', address: segwit })), ...b.map((c) => ({ ...c, kind: 'p2tr', address: taproot }))];
}

/** Both addresses' balances, added up. */
export async function balanceOf({ segwit, taproot = null }) {
  const [a, b] = await Promise.all([balance(segwit), taproot ? balance(taproot) : null]);
  if (!b) return a;
  return { confirmed: a.confirmed + b.confirmed, pending: a.pending + b.pending, total: a.total + b.total, txs: a.txs + b.txs };
}

/** Both addresses' recent transactions, each once (a send between them touches both), unconfirmed first, then newest. */
export async function activityOf({ segwit, taproot = null }, limit = 25) {
  const [a, b] = await Promise.all([activity(segwit, limit), taproot ? activity(taproot, limit) : []]);
  const seen = new Map();
  for (const t of [...a, ...b]) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()].sort((x, y) => (y.pending - x.pending) || ((y.time ?? 0) - (x.time ?? 0))).slice(0, limit);
}

const hexBytes = (s) => Uint8Array.from(String(s).match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/**
 * What the outputs a transaction spends really hold, from the chain (confirmed or in the mempool): Map of 'txid:vout'
 * -> { value, script }, null for one the chain doesn't know (a transaction not sent yet). At most `max` transactions
 * are looked up, 6 at a time; past that, or when the chain can't be reached, it throws.
 */
export async function prevoutsOf(outpoints, { max = 60 } = {}) {
  const txids = [...new Set(outpoints.map((o) => o.txid))];
  if (txids.length > max) throw fail(`it spends coins from ${txids.length} transactions, more than plum looks up`);
  const found = new Map();
  await pool(txids, 6, async (txid) => {
    let t = null;
    try { t = await esplora(`/tx/${txid}`); } catch (e) { if (e.status !== 404) throw e; }
    found.set(txid, t && Array.isArray(t.vout) ? t.vout : null);
  });
  const out = new Map();
  for (const o of outpoints) {
    const vout = found.get(o.txid);
    const v = vout?.[o.vout];
    out.set(`${o.txid}:${o.vout}`, v && Number.isSafeInteger(v.value) && v.value >= 0 && /^([0-9a-f]{2})*$/.test(v.scriptpubkey ?? '') ? { value: BigInt(v.value), script: hexBytes(v.scriptpubkey) } : null);
  }
  return out;
}

/** Today's fee rates in sat/vB: { fast, normal, slow }. */
export async function feeRates() {
  try {
    const f = await getJson('https://mempool.space/api/v1/fees/recommended', { timeout: 10_000 });
    const n = (v) => (Number.isFinite(v) && v > 0 ? Math.max(1, Math.ceil(v)) : null);
    if (n(f?.fastestFee) && n(f?.halfHourFee) && n(f?.hourFee)) return { fast: n(f.fastestFee), normal: n(f.halfHourFee), slow: n(f.hourFee) };
  } catch { /* the other one */ }
  const e = await getJson('https://blockstream.info/api/fee-estimates', { timeout: 10_000 });
  const at = (k) => Math.max(1, Math.ceil(Number(e?.[k]) || 1));
  return { fast: at('2'), normal: at('3'), slow: at('6') };
}

/** Recent transactions of an address, newest first (unconfirmed ones on top). */
export async function activity(address, limit = 25) {
  const list = await esplora(`/address/${address}/txs`);
  return (Array.isArray(list) ? list : []).slice(0, limit).filter((t) => /^[0-9a-f]{64}$/.test(t?.txid ?? '')).map((t) => ({
    id: t.txid, time: t.status?.block_time ?? null, ok: true, pending: !t.status?.confirmed, explorer: `${EXPLORER}/tx/${t.txid}`,
  }));
}

/** Send a signed transaction (hex); returns its txid. */
export async function broadcast(raw, txid) {
  return failover(ESPLORA, async (base) => {
    const r = await request(`${base}/tx`, { method: 'POST', body: raw, timeout: 20_000 });
    if (r.status === 429 || r.status >= 500) throw new NetError(`${new URL(base).host} answered ${r.status}`);
    const text = cleanLine(r.text, 200);
    if (!r.ok) {
      if (/already in (the )?(block chain|mempool)|txn-already-known|txn-already-in-mempool/i.test(text)) return txid;
      throw Object.assign(new Error(`the network refused the send: ${text}`), { final: true });
    }
    if (text !== txid) throw Object.assign(new Error('the network answered with a different transaction id'), { final: true });
    return txid;
  });
}

/** 'pending' until it's in a block, then 'confirmed'. */
export async function txStatus(txid) {
  const s = await esplora(`/tx/${txid}/status`);
  return s?.confirmed ? 'confirmed' : 'pending';
}

export const explorerTx = (txid) => `${EXPLORER}/tx/${txid}`;
