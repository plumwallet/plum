// Bitcoin (mainnet only): native segwit wallets (bc1q..., one address per wallet, as Phantom does), their coins read
// from mempool.space (blockstream.info if it's down), and sends written from bytes here: coins picked, the fee worked
// out from today's rates, BIP-143 signatures, change back to the same address. Opt-in replace-by-fee, so a stuck send
// can be sped up by any wallet.
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { concat, hex, u32le, u64le } from '../shared/bytes.js';
import { cleanLine } from '../shared/text.js';
import { hash160 } from './keys.js';
import { NetError, failover, getJson, request } from './net.js';

export const ESPLORA = ['https://mempool.space/api', 'https://blockstream.info/api'];
export const EXPLORER = 'https://mempool.space';
export const DUST = 546n;
const MAX_FEE_RATE = 500; // sat/vB: anything above is a mistake
const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const b58check = createBase58check(sha256);
const sha256d = (b) => sha256(sha256(b));

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

/** A native segwit address's 20-byte key hash (the only kind of address plum spends from). */
function ownKeyHash(address) {
  const { kind, script } = addressScript(address);
  if (kind !== 'p2wpkh') throw fail('plum only spends from native segwit (bc1q) addresses');
  return script.subarray(2);
}

/* ------------------------------------------------------------ sizes and fees */

// virtual bytes: the transaction's frame (with segwit's marker and flag), each native segwit input with its witness,
// and each kind of output
const VB = { frame: 10.5, input: 68, out: { p2wpkh: 31, p2wsh: 43, p2tr: 43, p2pkh: 34, p2sh: 32 } };
export const vsizeOf = (inputs, outKinds) => Math.ceil(VB.frame + inputs * VB.input + outKinds.reduce((n, k) => n + VB.out[k], 0));

/**
 * Coins to spend for `amount` sats to `to` at `feeRate` sat/vB, change back to `change`. Biggest coins first
 * (confirmed before unconfirmed). Change too small to be worth an output is left to the miners. With `max`, every coin
 * goes and the amount is what's left after the fee.
 * Returns { inputs, outputs: [{ script, value, kind, mine }], fee, vsize, amount }.
 */
export function plan({ utxos, to, amount, feeRate, change, max = false }) {
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > MAX_FEE_RATE) throw fail(`that fee rate (${feeRate} sat/vB) doesn't look right`);
  const dest = addressScript(to);
  const mine = ownKeyHash(change);
  const coins = [...utxos].sort((a, b) => (a.confirmed === b.confirmed ? Number(b.value - a.value) : a.confirmed ? -1 : 1));
  if (!coins.length) throw fail('there are no bitcoin in this wallet to send');
  const changeScript = concat(Uint8Array.of(0x00, 0x14), mine);
  const fee = (n, kinds) => BigInt(Math.ceil(vsizeOf(n, kinds) * feeRate));
  if (max) {
    const total = coins.reduce((n, c) => n + c.value, 0n);
    const f = fee(coins.length, [dest.kind]);
    const send = total - f;
    if (send < DUST) throw fail("after the network fee there's too little left to send");
    return { inputs: coins, outputs: [{ script: dest.script, value: send, kind: dest.kind, mine: false }], fee: f, vsize: vsizeOf(coins.length, [dest.kind]), amount: send };
  }
  const want = BigInt(amount);
  if (want < DUST) throw fail(`a Bitcoin send has to be at least ${DUST} sats (0.00000546 BTC)`);
  const picked = [];
  let total = 0n;
  for (const c of coins) {
    picked.push(c);
    total += c.value;
    const withChange = fee(picked.length, [dest.kind, 'p2wpkh']);
    if (total >= want + withChange) {
      const rest = total - want - withChange;
      if (rest >= DUST) {
        return {
          inputs: picked,
          outputs: [{ script: dest.script, value: want, kind: dest.kind, mine: false }, { script: changeScript, value: rest, kind: 'p2wpkh', mine: true }],
          fee: withChange, vsize: vsizeOf(picked.length, [dest.kind, 'p2wpkh']), amount: want,
        };
      }
      // the change would be dust: no change output, and the little that's left goes to the fee
      return { inputs: picked, outputs: [{ script: dest.script, value: want, kind: dest.kind, mine: false }], fee: total - want, vsize: vsizeOf(picked.length, [dest.kind]), amount: want };
    }
    const noChange = fee(picked.length, [dest.kind]);
    if (total >= want + noChange) return { inputs: picked, outputs: [{ script: dest.script, value: want, kind: dest.kind, mine: false }], fee: total - want, vsize: vsizeOf(picked.length, [dest.kind]), amount: want };
  }
  const short = want + fee(coins.length, [dest.kind]) - total;
  throw fail(`that's more than this wallet holds with the network fee (about ${short} sats short)`);
}

/* ------------------------------------------------------------ the transaction, as bytes */

function varint(n) {
  const v = Number(n);
  if (v < 0xfd) return Uint8Array.of(v);
  if (v <= 0xffff) return Uint8Array.of(0xfd, v & 0xff, v >> 8);
  return concat(Uint8Array.of(0xfe), u32le(v));
}
const txidBytes = (txid) => Uint8Array.from(txid.match(/../g).reverse(), (b) => Number.parseInt(b, 16));
const outpoint = (i) => concat(txidBytes(i.txid), u32le(i.vout));
const SEQUENCE = 0xfffffffd; // opt-in replace-by-fee
const VERSION = 2;

function outputsBytes(outputs) {
  return concat(...outputs.map((o) => concat(u64le(o.value), varint(o.script.length), o.script)));
}

/** BIP-143: what each native segwit input signs (SIGHASH_ALL). */
export function sighashes(tx, keyHash) {
  const hashPrevouts = sha256d(concat(...tx.inputs.map(outpoint)));
  const hashSequence = sha256d(concat(...tx.inputs.map(() => u32le(SEQUENCE))));
  const hashOutputs = sha256d(outputsBytes(tx.outputs));
  const scriptCode = concat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), keyHash, Uint8Array.of(0x88, 0xac));
  return tx.inputs.map((input) => sha256d(concat(
    u32le(VERSION), hashPrevouts, hashSequence, outpoint(input), scriptCode, u64le(input.value), u32le(SEQUENCE),
    hashOutputs, u32le(tx.locktime ?? 0), u32le(1),
  )));
}

/** The signed transaction: { raw (hex), txid, vsize }. `witnesses` are [signature + sighash type, public key] per input. */
export function serialize(tx, witnesses) {
  const ins = concat(...tx.inputs.map((i) => concat(outpoint(i), Uint8Array.of(0), u32le(SEQUENCE))));
  const outs = outputsBytes(tx.outputs);
  const base = concat(u32le(VERSION), varint(tx.inputs.length), ins, varint(tx.outputs.length), outs, u32le(tx.locktime ?? 0));
  const wit = concat(...witnesses.map((items) => concat(varint(items.length), ...items.map((x) => concat(varint(x.length), x)))));
  const full = concat(u32le(VERSION), Uint8Array.of(0x00, 0x01), varint(tx.inputs.length), ins, varint(tx.outputs.length), outs, wit, u32le(tx.locktime ?? 0));
  const txid = hex(sha256d(base).reverse());
  const vsize = Math.ceil((base.length * 3 + full.length) / 4);
  return { raw: hex(full), txid, vsize };
}

/** Sign a planned send with `signer(sighashes) -> { publicKey, signatures (DER) }`, checking the key is the one the
 * coins belong to. */
export async function signPlan(p, address, signer) {
  const keyHash = ownKeyHash(address);
  const tx = { inputs: p.inputs, outputs: p.outputs, locktime: 0 };
  const { publicKey, signatures } = await signer(sighashes(tx, keyHash));
  if (hex(hash160(publicKey)) !== hex(keyHash)) throw fail("the key that signed isn't this wallet's: nothing was sent");
  return serialize(tx, signatures.map((s) => [concat(s, Uint8Array.of(1)), publicKey]));
}

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
