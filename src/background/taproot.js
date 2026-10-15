// Taproot, key path only (BIP-86: no script tree): a wallet's internal key P, its output key Q = P + t·G with
// t = hash_TapTweak(x(P)) (BIP-341), the bc1p address that pays to x(Q), and BIP-340 signatures made with the tweaked
// secret. Signature hashes are in btc-tx.js. Secrets go in and signatures come out; nothing here is kept.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m } from '@scure/base';
import { concat, hex, utf8, wipe } from '../shared/bytes.js';

const { Point } = secp256k1;
const N = Point.CURVE().n;
const fail = (message) => new Error(message);

/** BIP-340's tagged hash: sha256(sha256(tag) || sha256(tag) || data). */
export function taggedHash(tag, ...parts) {
  const t = sha256(utf8(tag));
  return sha256(concat(t, t, ...parts));
}

const big = (bytes) => BigInt(`0x${hex(bytes) || '0'}`);
const bytes32 = (n) => Uint8Array.from(n.toString(16).padStart(64, '0').match(/../g), (b) => Number.parseInt(b, 16));

/** BIP-86's tweak for an x-only internal key: hash_TapTweak(x(P)) as a number (it must be below the curve's order). */
function tweakOf(internalX) {
  const t = big(taggedHash('TapTweak', internalX));
  if (t >= N) throw fail('this key cannot be tweaked (a one in 2^128 chance)');
  return t;
}

/** The x-only internal key of a secret: x(d·G). */
export const internalKey = (secret) => schnorr.getPublicKey(secret);

/** The output key for an x-only internal key: { x: x(Q), parity: Q's y is odd (1) or even (0) }. */
export function outputKey(internalX) {
  if (!(internalX instanceof Uint8Array) || internalX.length !== 32) throw fail('a taproot internal key is 32 bytes');
  const P = schnorr.utils.lift_x(big(internalX));
  const Q = P.add(Point.BASE.multiply(tweakOf(internalX)));
  if (Q.is0()) throw fail('this key cannot be tweaked');
  const q = Q.toBytes(true);
  return { x: q.subarray(1), parity: q[0] & 1 };
}

/** A taproot address for an output key's x coordinate: bc1p... (bech32m, witness version 1). */
export const taprootAddress = (outputX) => bech32m.encode('bc', [1, ...bech32m.toWords(outputX)]);

/** The taproot (bc1p) address a secret opens on BIP-86's key path. */
export const taprootAddressOf = (secret) => taprootAddress(outputKey(internalKey(secret)).x);

/** The output script for an output key: OP_1 PUSH32 x(Q). */
export const taprootScript = (outputX) => concat(Uint8Array.of(0x51, 0x20), outputX);

/** The secret that signs for the output key: d negated if d·G has an odd y, plus the tweak (BIP-341's
 * taproot_tweak_seckey). A new array: the caller wipes both. */
export function tweakSecret(secret) {
  const d0 = big(secret);
  if (d0 <= 0n || d0 >= N) throw fail("that isn't a key: it's outside the range secp256k1 keys live in");
  const p = Point.BASE.multiply(d0).toBytes(true);
  const d = p[0] === 3 ? N - d0 : d0;
  const k = (d + tweakOf(p.subarray(1))) % N;
  if (k === 0n) throw fail('this key cannot be tweaked');
  return bytes32(k);
}

/** BIP-340 signatures over 32-byte signature hashes with a secret's tweaked key: { outputKey: x(Q), signatures }.
 * Each signature is checked against x(Q) before it's handed back. `aux` is BIP-340's auxiliary randomness (fresh from
 * the browser unless a test fixes it). */
export function signKeyPath(digests, secret, aux = null) {
  const k = tweakSecret(secret);
  try {
    const q = schnorr.getPublicKey(k);
    const signatures = digests.map((d) => {
      if (!(d instanceof Uint8Array) || d.length !== 32) throw fail('a taproot signature is over a 32-byte hash');
      const sig = schnorr.sign(d, k, aux ?? crypto.getRandomValues(new Uint8Array(32)));
      if (!schnorr.verify(sig, d, q)) throw fail('a taproot signature did not verify; nothing was signed');
      return sig;
    });
    return { outputKey: q, signatures };
  } finally { wipe(k); }
}

/** Does a 64-byte BIP-340 signature verify for x(Q) over a 32-byte hash? */
export const verifyKeyPath = (signature, digest, outputX) => {
  try { return schnorr.verify(signature, digest, outputX); } catch { return false; }
};
