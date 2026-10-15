// Bitcoin transactions as bytes, any transaction (plum's own sends, and the ones sites hand over in PSBTs): reading
// and writing them with or without witnesses, their ids and sizes, and what each kind of input signs: BIP-143 (native
// segwit, witness v0) and BIP-341 (taproot key path, witness v1) signature hashes, for every sighash type.
//
// A transaction here: { version, locktime, inputs: [{ txid (hex, as explorers show it), vout, sequence, scriptSig,
// witness: [bytes] }], outputs: [{ value (sats, bigint), script }] }. What each input spends (its prevout) is
// { value, script }, passed beside it.
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, hex, u32le, u64le } from '../shared/bytes.js';
import { taggedHash } from './taproot.js';

export const SIGHASH = { DEFAULT: 0x00, ALL: 0x01, NONE: 0x02, SINGLE: 0x03, ANYONECANPAY: 0x80 };
/** The sighash types a v0 input can be signed with; a taproot input also takes DEFAULT (0x00). */
export const V0_TYPES = [0x01, 0x02, 0x03, 0x81, 0x82, 0x83];
export const V1_TYPES = [0x00, ...V0_TYPES];
/** 21 million bitcoin, in sats: no output is ever worth more. */
export const MAX_MONEY = 2_100_000_000_000_000n;

const fail = (message) => new Error(message);
export const sha256d = (b) => sha256(sha256(b));

/** Bitcoin's compact size (a "varint"). */
export function varint(n) {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || v < 0) throw fail('a length is out of range');
  if (v < 0xfd) return Uint8Array.of(v);
  if (v <= 0xffff) return Uint8Array.of(0xfd, v & 0xff, v >> 8);
  if (v <= 0xffffffff) return concat(Uint8Array.of(0xfe), u32le(v));
  return concat(Uint8Array.of(0xff), u64le(v));
}
export const varBytes = (b) => concat(varint(b.length), b);

/** Bytes read front to back; every read is checked against the end, and compact sizes must be written the short
 * way (as Bitcoin Core requires). */
export class Reader {
  constructor(bytes) { this.b = bytes; this.at = 0; }
  get left() { return this.b.length - this.at; }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.left) throw fail('it ends too soon (truncated)');
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8() { return this.take(1)[0]; }
  u32() { const d = this.take(4); return (d[0] | (d[1] << 8) | (d[2] << 16)) + d[3] * 2 ** 24; }
  u64() { const d = this.take(8); let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[i]); return v; }
  varint() {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) { const d = this.take(2); const v = d[0] | (d[1] << 8); if (v < 0xfd) throw fail('a length is written the long way'); return v; }
    if (first === 0xfe) { const v = this.u32(); if (v <= 0xffff) throw fail('a length is written the long way'); return v; }
    const v = this.u64();
    if (v <= 0xffffffffn) throw fail('a length is written the long way');
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('a length is out of range');
    return Number(v);
  }
  varBytes() { return this.take(this.varint()); }
}

const txidBytes = (txid) => Uint8Array.from(txid.match(/../g).reverse(), (b) => Number.parseInt(b, 16));
export const outpoint = (i) => concat(txidBytes(i.txid), u32le(i.vout));
const outputBytes = (o) => concat(u64le(o.value), varBytes(o.script));

/** A transaction from its bytes (with or without witnesses). Nothing may follow it. */
export function parseTx(bytes, { maxInputs = 5000 } = {}) {
  const r = new Reader(bytes);
  const version = r.u32() | 0;
  let segwit = false;
  if (r.left >= 2 && r.b[r.at] === 0x00) {
    if (r.b[r.at + 1] !== 0x01) throw fail("its segwit flag isn't 1");
    r.take(2);
    segwit = true;
  }
  const nIn = r.varint();
  if (!nIn) throw fail('it spends nothing (no inputs)');
  if (nIn > maxInputs) throw fail(`it has ${nIn} inputs, more than plum reads`);
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const txid = hex(r.take(32).slice().reverse());
    inputs.push({ txid, vout: r.u32(), scriptSig: r.varBytes().slice(), sequence: r.u32(), witness: [] });
  }
  const nOut = r.varint();
  if (nOut > 10_000) throw fail(`it has ${nOut} outputs, more than plum reads`);
  const outputs = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.u64();
    if (value > MAX_MONEY) throw fail('one of its outputs is worth more than all the bitcoin there is');
    outputs.push({ value, script: r.varBytes().slice() });
  }
  if (segwit) {
    for (const input of inputs) {
      const n = r.varint();
      if (n > 10_000) throw fail('a witness is too long');
      for (let k = 0; k < n; k++) input.witness.push(r.varBytes().slice());
    }
    if (inputs.every((i) => !i.witness.length)) throw fail('it has the segwit flag but no witness');
  }
  const locktime = r.u32();
  if (r.left) throw fail('there are bytes after its end');
  return { version, locktime, inputs, outputs };
}

/** A transaction's bytes; with witnesses (BIP-144's marker and flag) when any input has one and `witness` is on. */
export function serializeTx(tx, { witness = true } = {}) {
  const withWitness = witness && tx.inputs.some((i) => i.witness?.length);
  const ins = tx.inputs.map((i) => concat(outpoint(i), varBytes(i.scriptSig ?? new Uint8Array(0)), u32le(i.sequence)));
  const parts = [u32le(tx.version >>> 0)];
  if (withWitness) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(varint(tx.inputs.length), ...ins, varint(tx.outputs.length), ...tx.outputs.map(outputBytes));
  if (withWitness) for (const i of tx.inputs) parts.push(varint(i.witness?.length ?? 0), ...(i.witness ?? []).map(varBytes));
  parts.push(u32le(tx.locktime >>> 0));
  return concat(...parts);
}

/** The transaction's id (hex, as explorers show it): the hash of its bytes without witnesses. */
export const txidOf = (tx) => hex(sha256d(serializeTx(tx, { witness: false })).reverse());

/** Its weight and virtual size (BIP-141). */
export function sizeOf(tx) {
  const base = serializeTx(tx, { witness: false }).length;
  const total = serializeTx(tx).length;
  const weight = base * 3 + total;
  return { base, total, weight, vsize: Math.ceil(weight / 4) };
}

/* ------------------------------------------------------------ what an input signs */

const ZERO32 = new Uint8Array(32);
const base = (type) => type & 0x1f;

/**
 * BIP-143: the hash a native segwit (v0) input signs. `scriptCode` is the script being satisfied (for P2WPKH, the
 * P2PKH script of the key hash), `value` what the coin it spends holds.
 */
export function sighashV0(tx, index, scriptCode, value, type = SIGHASH.ALL) {
  if (!V0_TYPES.includes(type)) throw fail(`sighash type ${type} isn't one plum signs`);
  const acp = !!(type & SIGHASH.ANYONECANPAY);
  const single = base(type) === SIGHASH.SINGLE, none = base(type) === SIGHASH.NONE;
  const input = tx.inputs[index];
  if (!input) throw fail('no such input');
  const hashPrevouts = acp ? ZERO32 : sha256d(concat(...tx.inputs.map(outpoint)));
  const hashSequence = acp || single || none ? ZERO32 : sha256d(concat(...tx.inputs.map((i) => u32le(i.sequence))));
  let hashOutputs = ZERO32;
  if (!single && !none) hashOutputs = sha256d(concat(...tx.outputs.map(outputBytes)));
  else if (single && index < tx.outputs.length) hashOutputs = sha256d(outputBytes(tx.outputs[index]));
  return sha256d(concat(
    u32le(tx.version >>> 0), hashPrevouts, hashSequence, outpoint(input), varBytes(scriptCode), u64le(value), u32le(input.sequence),
    hashOutputs, u32le(tx.locktime >>> 0), u32le(type),
  ));
}

/**
 * BIP-341: the hash a taproot input signs on the key path (no annex unless one is given). `prevouts` are what every
 * input spends, { value, script }, in order: the hash commits to all of them unless ANYONECANPAY.
 */
export function sighashV1(tx, index, prevouts, type = SIGHASH.DEFAULT, { annex = null } = {}) {
  if (!V1_TYPES.includes(type)) throw fail(`sighash type ${type} isn't one plum signs`);
  const input = tx.inputs[index];
  if (!input) throw fail('no such input');
  if (prevouts.length !== tx.inputs.length) throw fail('a taproot signature needs what every input spends');
  const acp = !!(type & SIGHASH.ANYONECANPAY);
  const out = type & 3; // 0 (DEFAULT) signs every output, as ALL does
  const parts = [Uint8Array.of(0x00, type), u32le(tx.version >>> 0), u32le(tx.locktime >>> 0)];
  if (!acp) {
    parts.push(
      sha256(concat(...tx.inputs.map(outpoint))),
      sha256(concat(...prevouts.map((p) => u64le(p.value)))),
      sha256(concat(...prevouts.map((p) => varBytes(p.script)))),
      sha256(concat(...tx.inputs.map((i) => u32le(i.sequence)))),
    );
  }
  if (out !== SIGHASH.NONE && out !== SIGHASH.SINGLE) parts.push(sha256(concat(...tx.outputs.map(outputBytes))));
  parts.push(Uint8Array.of(annex ? 1 : 0));
  if (acp) parts.push(outpoint(input), u64le(prevouts[index].value), varBytes(prevouts[index].script), u32le(input.sequence));
  else parts.push(u32le(index));
  if (annex) parts.push(sha256(varBytes(annex)));
  if (out === SIGHASH.SINGLE) {
    if (index >= tx.outputs.length) throw fail('SIGHASH_SINGLE needs an output at the same place as the input');
    parts.push(sha256(outputBytes(tx.outputs[index])));
  }
  return taggedHash('TapSighash', concat(...parts));
}

/** A sighash type in words: "ALL", "SINGLE|ANYONECANPAY"... */
export function sighashName(type) {
  if (type === SIGHASH.DEFAULT) return 'DEFAULT';
  const name = { 1: 'ALL', 2: 'NONE', 3: 'SINGLE' }[base(type)] ?? `0x${type.toString(16)}`;
  return type & SIGHASH.ANYONECANPAY ? `${name}|ANYONECANPAY` : name;
}
