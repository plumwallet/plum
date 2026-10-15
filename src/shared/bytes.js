// Bytes in and out: base64, UTF-8, little-endian integers. No Solana library anywhere in plum: these few helpers and
// base58.js are all the encoding a wallet needs.

const enc = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s) => enc.encode(s);

/** The text in bytes, or null when they aren't valid UTF-8. */
export function readUtf8(bytes) {
  try { return strict.decode(bytes); } catch { return null; }
}

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export function b64decode(s) {
  if (typeof s !== 'string' || s.length % 4 || !B64_RE.test(s)) throw new Error('not base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function u32le(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, Number(v), true);
  return b;
}

export function u64le(v) {
  let x = BigInt(v);
  if (x < 0n || x >= 1n << 64n) throw new Error('out of range for a u64');
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

export function readU64(d, at) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
}

export const readU32 = (d, at) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16)) + d[at + 3] * 2 ** 24;

/** Overwrite secret bytes once they're no longer needed (best effort: JS may have copied them). */
export function wipe(...arrays) {
  for (const a of arrays) if (a instanceof Uint8Array) a.fill(0);
}
