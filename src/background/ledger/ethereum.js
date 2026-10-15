// The Ledger Ethereum app (CLA 0xE0): its settings, an address for a path, EIP-1559 transactions, personal_sign
// messages and EIP-712 typed data, each signed after you check it on the device. Typed data goes field by field, so the
// device shows (and hashes) every value itself; an app too old for that, or data the field-by-field format can't
// carry, falls back to the two hashes, which the device shows for you to compare with plum's.
// Every signature comes back as { r, s, yParity } with a low s; the caller checks it recovers to the wallet's address.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concat, utf8 } from '../../shared/bytes.js';
import { ethAddressOfPublicKey } from '../keys.js';
import { LedgerError, atLeast, pathBytes, send } from './apdu.js';

export const APP = 'Ethereum';
const CLA = 0xe0;
const INS = { address: 0x02, sign: 0x04, config: 0x06, personal: 0x08, typed: 0x0c, structDef: 0x1a, structImpl: 0x1c };
const OWN = {
  0x6a80: ['blind-sign', "your Ledger's Ethereum app needs blind signing to sign this (it calls a contract): turn it on in the app's settings, then try again"],
  0x6982: ['rejected', 'you turned it down on your Ledger'],
};
const opts = { app: APP, own: OWN };
const N = secp256k1.Point.CURVE().n;

/** The app's settings: { blindSigning, version }. */
export async function config(link) {
  const { data } = await send(link, CLA, INS.config, 0x00, 0x00, undefined, opts);
  if (data.length < 4) throw new LedgerError('error', "your Ledger's Ethereum app answered with settings plum can't read");
  return { blindSigning: (data[0] & 0x01) === 1, version: `${data[1]}.${data[2]}.${data[3]}` };
}

/** The address at a path (shown on the device too, when `display`), worked out by plum from the public key the
 * device gives, and checked against the address the device says it is. */
export async function address(link, path, { display = false } = {}) {
  const { data } = await send(link, CLA, INS.address, display ? 0x01 : 0x00, 0x00, pathBytes(path), opts);
  const keyLen = data[0];
  const pub = data.subarray(1, 1 + keyLen);
  const addrLen = data[1 + keyLen];
  const said = String.fromCharCode(...data.subarray(2 + keyLen, 2 + keyLen + addrLen));
  if (keyLen !== 65 || addrLen !== 40 || data.length < 2 + keyLen + addrLen) throw new LedgerError('mismatch', "your Ledger answered with an Ethereum address plum can't read");
  let ours;
  try { ours = ethAddressOfPublicKey(pub); } catch { throw new LedgerError('mismatch', "your Ledger answered with a public key that isn't one"); }
  if (ours.slice(2).toLowerCase() !== said.toLowerCase()) throw new LedgerError('mismatch', "your Ledger's address doesn't match its own public key");
  return ours;
}

/** v r s from the device as { r, s, yParity }, s made low (the same signature, as Ethereum wants it). */
export function readSignature(data, { typedTx = false } = {}) {
  if (data.length !== 65) throw new LedgerError('mismatch', 'your Ledger answered with a signature that has the wrong length');
  const v = data[0];
  let yParity;
  if (typedTx && (v === 0 || v === 1)) yParity = v;
  else if (v === 27 || v === 28) yParity = v - 27;
  else throw new LedgerError('mismatch', `your Ledger answered with a signature plum can't read (v ${v})`);
  const r = data.slice(1, 33);
  let s = data.slice(33, 65);
  const big = (b) => BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
  const rv = big(r), sv = big(s);
  if (rv <= 0n || rv >= N || sv <= 0n || sv >= N) throw new LedgerError('mismatch', 'your Ledger answered with a signature that is out of range');
  if (sv > N / 2n) {
    s = Uint8Array.from((N - sv).toString(16).padStart(64, '0').match(/../g), (b) => Number.parseInt(b, 16));
    yParity ^= 1;
  }
  return { r, s, yParity };
}

/** Long data in 255-byte pieces: the first one starts with `head`; P1 is 0x00 for the first piece, 0x80 after. */
async function stream(link, ins, head, body, p2 = 0x00) {
  const first = Math.max(0, 255 - head.length);
  let out = await send(link, CLA, ins, 0x00, p2, concat(head, body.subarray(0, first)), opts);
  for (let at = first; at < body.length; at += 255) out = await send(link, CLA, ins, 0x80, p2, body.subarray(at, at + 255), opts);
  return out.data;
}

/** An unsigned EIP-1559 transaction (0x02 || rlp(fields)) signed by the key at `path`. */
export async function signTransaction(link, path, unsigned) {
  if (unsigned[0] !== 0x02) throw new LedgerError('refused', 'plum sends only EIP-1559 transactions to a Ledger');
  return readSignature(await stream(link, INS.sign, pathBytes(path), unsigned), { typedTx: true });
}

/** A personal_sign message (the device adds Ethereum's prefix itself, as plum does). */
export async function signPersonal(link, path, message) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, message.length, false);
  return readSignature(await stream(link, INS.personal, concat(pathBytes(path), len), message));
}

/* ------------------------------------------------------------ EIP-712 */

const ATOMS = { int: 1, uint: 2, address: 3, bool: 4, string: 5 };

/** A type as the device reads it: its base ('uint', 'bytes', a struct's name...), its size, its array levels (in the
 * order they're written: "uint256[2][]" is [2, null]). */
export function splitType(type) {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*?)(\d*)((?:\[\d*\])*)$/.exec(type);
  if (!m) throw new LedgerError('refused', `the typed data has a type a Ledger can't take: ${type.slice(0, 40)}`);
  let [, base, digits, arrays] = m;
  // a struct whose name ends in digits keeps them
  if (!['int', 'uint', 'bytes'].includes(base)) { base += digits; digits = ''; }
  const levels = [...arrays.matchAll(/\[(\d*)\]/g)].map((x) => (x[1] === '' ? null : Number(x[1])));
  return { base, size: digits === '' ? null : Number(digits), levels };
}

/** One field of a struct's definition: type, then name. Throws 'fallback' for anything the field-by-field format can't
 * say exactly as plum hashes it. */
function fieldDefinition(f, types) {
  const { base, size, levels } = splitType(f.type);
  let kind, typeSize = null;
  if (base === 'int' || base === 'uint') {
    if (size == null) throw new Error('fallback');
    kind = ATOMS[base];
    typeSize = size / 8;
  } else if (base === 'bytes') { kind = size == null ? 7 : 6; typeSize = size; } else if (ATOMS[base]) kind = ATOMS[base];
  else if (Object.hasOwn(types, base)) kind = 0;
  else throw new LedgerError('refused', `the typed data uses a type it doesn't define: ${base.slice(0, 40)}`);
  const parts = [Uint8Array.of((levels.length ? 0x80 : 0) | (typeSize != null ? 0x40 : 0) | kind)];
  if (kind === 0) parts.push(Uint8Array.of(utf8(base).length), utf8(base));
  if (typeSize != null) parts.push(Uint8Array.of(typeSize));
  if (levels.length) {
    parts.push(Uint8Array.of(levels.length));
    for (const n of levels) parts.push(n == null ? Uint8Array.of(0) : Uint8Array.of(1, n));
  }
  const name = utf8(f.name);
  parts.push(Uint8Array.of(name.length), name);
  const out = concat(...parts);
  if (out.length > 255 || name.length > 255) throw new Error('fallback');
  return out;
}

const minimal = (n) => {
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return Uint8Array.from(h.match(/../g), (b) => Number.parseInt(b, 16));
};

/** An integer as plum's hash reads it (see eth.js): a bigint, a safe number, decimal or 0x text. */
function intOf(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  const s = typeof v === 'string' ? v.trim() : '';
  if (/^-?\d+$/.test(s)) return BigInt(s);
  if (/^-?0x[0-9a-fA-F]+$/.test(s)) return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
  throw new LedgerError('refused', 'a number in the typed data isn\'t one');
}

const fromHex = (s) => {
  const h = String(s).replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new LedgerError('refused', 'a value in the typed data is malformed');
  return Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
};

/** A value's bytes as the device takes them: integers big-endian with no leading zeros (negative ones as two's
 * complement in their size), addresses 20 bytes, text as UTF-8, bytes as they are. */
export function valueBytes(base, size, value) {
  if (base === 'int' || base === 'uint') {
    let n = intOf(value);
    if (n < 0n) n += 1n << BigInt(size);
    return minimal(n);
  }
  if (base === 'bool') return Uint8Array.of(value === true || value === 'true' || value === 1 ? 1 : 0);
  if (base === 'address') return fromHex(value);
  if (base === 'string') return utf8(String(value));
  if (base === 'bytes') return typeof value === 'string' ? fromHex(value) : Uint8Array.from(value);
  throw new LedgerError('refused', `the typed data has a type a Ledger can't take: ${base}`);
}

/** The APDUs that send typed data's definitions and values, in order: [[ins, p1, p2, data], ...]. Throws 'fallback'
 * when the field-by-field format can't carry it. */
export function typedApdus(td) {
  const types = td.types;
  if (td.primaryType === 'EIP712Domain') throw new LedgerError('refused', "a Ledger can't sign a bare EIP712Domain");
  const out = [];
  const names = Object.keys(types).sort();
  for (const name of names) {
    out.push([INS.structDef, 0x00, 0x00, utf8(name)]);
    for (const f of types[name]) out.push([INS.structDef, 0x00, 0xff, fieldDefinition(f, types)]);
  }
  const field = (bytes) => {
    const data = concat(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
    for (let at = 0; at < data.length; at += 255) out.push([INS.structImpl, at + 255 < data.length ? 0x01 : 0x00, 0xff, data.subarray(at, at + 255)]);
  };
  const walk = (type, value, depth = 0) => {
    if (depth > 16) throw new Error('fallback');
    const { base, size, levels } = splitType(type);
    if (levels.length) {
      if (!Array.isArray(value) || value.length > 255) throw new Error('fallback');
      out.push([INS.structImpl, 0x00, 0x0f, Uint8Array.of(value.length)]);
      const inner = base + (size ?? '') + levels.slice(1).map((n) => `[${n ?? ''}]`).join('');
      for (const v of value) walk(inner, v, depth + 1);
      return;
    }
    if (Object.hasOwn(types, base) && !ATOMS[base] && base !== 'bytes') {
      if (!value || typeof value !== 'object') throw new LedgerError('refused', `the typed data's ${base} is missing`);
      for (const f of types[base]) walk(f.type, value[f.name], depth + 1);
      return;
    }
    field(valueBytes(base, size, value));
  };
  out.push([INS.structImpl, 0x00, 0x00, utf8('EIP712Domain')]);
  for (const f of types.EIP712Domain) walk(f.type, td.domain[f.name]);
  out.push([INS.structImpl, 0x00, 0x00, utf8(td.primaryType)]);
  for (const f of types[td.primaryType]) walk(f.type, td.message[f.name]);
  return out;
}

/**
 * Typed data signed by the key at `path`: field by field when the app can (1.9.19 and later), the device showing each
 * value; otherwise the domain and message hashes (`hashes`, from plum's own hashing), which the device shows as they
 * are. Returns { sig, mode: 'fields' | 'hashes' }.
 */
export async function signTyped(link, path, td, hashes, { version = null } = {}) {
  let list = null;
  if (!version || atLeast(version, '1.9.19')) {
    try { list = typedApdus(td); } catch (e) { if (e.message !== 'fallback') throw e; }
  }
  if (list) {
    // an app (or a device) without the field-by-field commands says so to the first one
    const [ins, p1, p2, data] = list[0];
    const first = await send(link, CLA, ins, p1, p2, data, { ...opts, ok: [0x6d00, 0x6e00] });
    if (first.sw === 0x9000) {
      for (const [i, a, b, d] of list.slice(1)) await send(link, CLA, i, a, b, d, opts);
      return { sig: readSignature((await send(link, CLA, INS.typed, 0x00, 0x01, pathBytes(path), opts)).data), mode: 'fields' };
    }
  }
  if (!hashes?.message) throw new LedgerError('refused', "a Ledger can't sign this typed data");
  if (version && !atLeast(version, '1.5.0')) throw new LedgerError('old-app', 'the Ethereum app on your Ledger is too old to sign typed data: update it with Ledger Live (My Ledger)');
  const data = (await send(link, CLA, INS.typed, 0x00, 0x00, concat(pathBytes(path), hashes.domain, hashes.message), opts)).data;
  return { sig: readSignature(data), mode: 'hashes' };
}
