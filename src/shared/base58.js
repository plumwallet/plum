// Base58 (Bitcoin alphabet), shared by the server and the browser. Case-sensitive: never lowercase an
// address or a signature.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(s) {
  if (typeof s !== 'string' || !BASE58_RE.test(s)) throw new Error('not base58');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(MAP[c]);
  const body = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

/** A well-formed 32-byte base58 address (says nothing about whether it is on the curve). */
export function isAddress(s) {
  if (typeof s !== 'string' || !ADDRESS_RE.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

export const shortAddress = (a, n = 4) => (typeof a === 'string' && a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a ?? '');
