// Signed messages for Bitcoin addresses. BIP-322's "simple" format for bc1q and bc1p addresses: a virtual
// transaction (to_spend) pays the address, a second one (to_sign) spends it to OP_RETURN, and the signature is
// to_sign's witness. Neither can ever be broadcast (to_spend spends nothing that exists) or move a coin. And Bitcoin's
// legacy format, a recoverable ECDSA signature over "Bitcoin Signed Message:\n" and the message (BIP-137's header
// byte), for sites that ask for it by name.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { b64decode, b64encode, concat, hex, utf8 } from '../shared/bytes.js';
import { addressScript, p2pkhCode } from './btc.js';
import { Reader, SIGHASH, serializeTx, sha256d, sighashV0, sighashV1, txidOf, varBytes, varint } from './btc-tx.js';
import { hash160 } from './keys.js';
import { taggedHash, verifyKeyPath } from './taproot.js';

const fail = (message) => new Error(message);
const ZERO_TXID = '00'.repeat(32);

/** BIP-322's message hash: the BIP-340 tagged hash "BIP0322-signed-message" of the message's bytes. */
export const messageHash = (message) => taggedHash('BIP0322-signed-message', message);

/** The virtual transaction that "pays" the address the message is signed for. */
export function toSpend(script, message) {
  return {
    version: 0, locktime: 0,
    inputs: [{ txid: ZERO_TXID, vout: 0xffffffff, sequence: 0, scriptSig: concat(Uint8Array.of(0x00, 0x20), messageHash(message)), witness: [] }],
    outputs: [{ value: 0n, script }],
  };
}

/** The virtual transaction that spends it: its witness is the signature. */
export function toSign(spend, witness = []) {
  return {
    version: 0, locktime: 0,
    inputs: [{ txid: txidOf(spend), vout: 0, sequence: 0, scriptSig: new Uint8Array(0), witness }],
    outputs: [{ value: 0n, script: Uint8Array.of(0x6a) }],
  };
}

/** What a key signs to prove `address` signs `message`: { kind, digest, spend }. bc1q and bc1p addresses only. */
export function bip322Digest(address, message) {
  const { kind, script } = addressScript(address);
  if (kind !== 'p2wpkh' && kind !== 'p2tr') throw fail('plum signs BIP-322 messages for bc1q and bc1p addresses');
  const spend = toSpend(script, message);
  const tx = toSign(spend);
  const digest = kind === 'p2wpkh'
    ? sighashV0(tx, 0, p2pkhCode(script.subarray(2)), 0n, SIGHASH.ALL)
    : sighashV1(tx, 0, [{ value: 0n, script }], SIGHASH.DEFAULT);
  return { kind, script, digest, spend };
}

const encodeWitness = (items) => b64encode(concat(varint(items.length), ...items.map(varBytes)));

function decodeWitness(signature) {
  let s = String(signature ?? '');
  if (s.startsWith('smp')) s = s.slice(3);
  const bytes = b64decode(s);
  const r = new Reader(bytes);
  const n = r.varint();
  const items = [];
  for (let i = 0; i < n; i++) items.push(r.varBytes());
  if (r.left) throw fail('the signature has bytes after its witness');
  return items;
}

/** Does a BIP-322 simple signature (base64 witness, with or without the "smp" prefix) prove `address` signed it? */
export function verifyBip322(address, message, signature) {
  try {
    const { kind, script, digest } = bip322Digest(address, message);
    const w = decodeWitness(signature);
    if (kind === 'p2tr') {
      if (w.length !== 1 || (w[0].length !== 64 && !(w[0].length === 65 && w[0][64] === SIGHASH.ALL))) return false;
      const d = w[0].length === 65 ? sighashV1(toSign(toSpend(script, message)), 0, [{ value: 0n, script }], SIGHASH.ALL) : digest;
      return verifyKeyPath(w[0].subarray(0, 64), d, script.subarray(2));
    }
    if (w.length !== 2 || w[1].length !== 33 || hex(hash160(w[1])) !== hex(script.subarray(2)) || w[0].at(-1) !== SIGHASH.ALL) return false;
    return secp256k1.verify(w[0].subarray(0, -1), digest, w[1], { prehash: false, format: 'der', lowS: false });
  } catch { return false; }
}

/**
 * Sign `message` (bytes) for one of your addresses, BIP-322 simple: `sign(address, [digest])` is the wallet's
 * signBitcoinAs. Returns the witness, base64, checked before it's handed back. (Unprefixed: what wallets and the sites
 * that check signatures use; BIP-322 verifiers read it as "smp".)
 */
export async function signBip322(address, message, sign) {
  const { kind, digest } = bip322Digest(address, message);
  const res = await sign(address, [digest]);
  const witness = kind === 'p2tr' ? [res.signatures[0]] : [concat(res.signatures[0], Uint8Array.of(SIGHASH.ALL)), res.publicKey];
  const out = encodeWitness(witness);
  if (!verifyBip322(address, message, out)) throw fail('the signature did not verify: nothing was signed');
  return out;
}

/* ------------------------------------------------------------ the legacy format */

const PREFIX = utf8('Bitcoin Signed Message:\n');
/** The hash a legacy signed message signs: sha256d(varint + "Bitcoin Signed Message:\n" + varint + message). */
export const legacyDigest = (message) => sha256d(concat(varint(PREFIX.length), PREFIX, varint(message.length), message));

/** BIP-137's header byte: 27 + recovery id, +4 for a compressed key, then +8 for P2SH-P2WPKH or +12 for P2WPKH. */
const HEADER = { p2pkh: 31, p2sh: 35, p2wpkh: 39 };

/** Sign `message` (bytes) in the legacy format for a bc1q address (or with a bc1p address's own untweaked key, as
 * other wallets do for "ECDSA" on taproot): base64 of header + r + s. */
export async function signLegacy(address, message, sign) {
  const { kind } = addressScript(address);
  if (kind !== 'p2wpkh' && kind !== 'p2tr') throw fail('plum signs messages for bc1q and bc1p addresses');
  const digest = legacyDigest(message);
  const { publicKey, signatures: [s] } = await sign(address, [digest], { compact: true });
  const header = (kind === 'p2wpkh' ? HEADER.p2wpkh : HEADER.p2pkh) + s.recovery;
  const sig = new secp256k1.Signature(BigInt(`0x${hex(s.r)}`), BigInt(`0x${hex(s.s)}`)).addRecoveryBit(s.recovery);
  if (sig.recoverPublicKey(digest).toHex(true) !== hex(publicKey)) throw fail('the signature did not verify: nothing was signed');
  return b64encode(concat(Uint8Array.of(header), s.r, s.s));
}

/** The compressed public key a legacy signature recovers to, and its header's kind; null if it doesn't read. */
export function recoverLegacy(message, signature) {
  try {
    const b = b64decode(signature);
    if (b.length !== 65 || b[0] < 27 || b[0] > 42) return null;
    const rec = (b[0] - 27) & 3;
    const sig = new secp256k1.Signature(BigInt(`0x${hex(b.subarray(1, 33))}`), BigInt(`0x${hex(b.subarray(33))}`)).addRecoveryBit(rec);
    return { publicKey: sig.recoverPublicKey(legacyDigest(message)).toBytes(true), header: b[0] };
  } catch { return null; }
}

export const _test = { encodeWitness, decodeWitness, serializeTx };
