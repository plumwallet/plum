// The Ledger Bitcoin app, its current protocol (app 2.1 and later, CLA 0xE1). The device never takes a whole
// transaction: it takes commitments (Merkle roots of every map of a PSBT version 2) and asks plum for what it wants to
// see, piece by piece (status 0xE000 and a client command; plum answers with CONTINUE, CLA 0xF8). Accounts are wallet
// policies: plum's Bitcoin wallets on a Ledger are the default native segwit one, wpkh(@0/**) over
// [fingerprint/84'/0'/0']xpub, so nothing has to be registered on the device.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { concat, equal, hex, u32le, u64le, utf8 } from '../../shared/bytes.js';
import { btcAddressOfPublicKey, hash160 } from '../keys.js';
import { LedgerError, apdu, atLeast, pathSteps, splitAnswer, swError } from './apdu.js';

export const APP = 'Bitcoin';
const CLA = 0xe1;
const PROTOCOL = 1;
const INS = { xpub: 0x00, address: 0x03, signPsbt: 0x04, fingerprint: 0x05, message: 0x10 };
const SW_INTERRUPTED = 0xe000;
const OWN = {
  0x6a80: ['refused', "your Ledger's Bitcoin app refused this request"],
  0xb007: ['error', "your Ledger's Bitcoin app is in the wrong state: open it again"],
  0xb008: ['mismatch', "your Ledger's Bitcoin app found a signature or HMAC that doesn't check out"],
};
const sha256d = (b) => sha256(sha256(b));

/* ------------------------------------------------------------ varints and Merkle trees (doc/merkle.md) */

export function varint(n) {
  const v = Number(n);
  if (v < 0xfd) return Uint8Array.of(v);
  if (v <= 0xffff) return Uint8Array.of(0xfd, v & 0xff, v >> 8);
  return concat(Uint8Array.of(0xfe), u32le(v));
}

/** Read a varint at `at`: [value, next position]. */
export function readVarint(b, at) {
  const first = b[at];
  if (first == null) throw new LedgerError('error', 'your Ledger sent a number plum can\'t read');
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd) return [b[at + 1] | (b[at + 2] << 8), at + 3];
  if (first === 0xfe) return [(b[at + 1] | (b[at + 2] << 8) | (b[at + 3] << 16)) + b[at + 4] * 2 ** 24, at + 5];
  throw new LedgerError('error', 'your Ledger sent a number too large to read');
}

export const elementHash = (x) => sha256(concat(Uint8Array.of(0x00), x));
const combine = (l, r) => sha256(concat(Uint8Array.of(0x01), l, r));
const leftSize = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

/** The root of a tree over leaf hashes (32 zero bytes for none). */
export function merkleRoot(leaves) {
  if (!leaves.length) return new Uint8Array(32);
  if (leaves.length === 1) return leaves[0];
  const k = leftSize(leaves.length);
  return combine(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** The proof for leaf `i`: its siblings, from the leaf up to the root. */
export function merkleProof(leaves, i) {
  if (leaves.length <= 1) return [];
  const k = leftSize(leaves.length);
  return i < k
    ? [...merkleProof(leaves.slice(0, k), i), merkleRoot(leaves.slice(k))]
    : [...merkleProof(leaves.slice(k), i - k), merkleRoot(leaves.slice(0, k))];
}

const cmpBytes = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

/** A map's entries sorted by key: [[key, value], ...]. */
export const sortedEntries = (map) => [...map].sort(([a], [b]) => cmpBytes(a, b));

/** A map's commitment: its size, the root of its keys and the root of its values (sorted by key). */
export function mapCommitment(map) {
  const items = sortedEntries(map);
  return concat(varint(items.length), merkleRoot(items.map(([k]) => elementHash(k))), merkleRoot(items.map(([, v]) => elementHash(v))));
}

/* ------------------------------------------------------------ answering the device (client commands) */

/** What plum can show the device: preimages by their SHA-256, and lists by their Merkle root. */
export class Interpreter {
  constructor() {
    this.preimages = new Map();
    this.trees = new Map();
    this.queue = [];
    this.yielded = [];
  }

  addPreimage(b) { this.preimages.set(hex(sha256(b)), b); }

  addList(elements) {
    for (const e of elements) this.addPreimage(concat(Uint8Array.of(0x00), e));
    const leaves = elements.map(elementHash);
    this.trees.set(hex(merkleRoot(leaves)), leaves);
  }

  addMap(map) {
    const items = sortedEntries(map);
    this.addList(items.map(([k]) => k));
    this.addList(items.map(([, v]) => v));
  }

  /** The answer to one client command (the data of a 0xE000 reply). */
  execute(req) {
    const code = req[0];
    if (code === 0x10) { this.yielded.push(req.slice(1)); return new Uint8Array(0); }
    if (code === 0x40) {
      if (req.length !== 34 || req[1] !== 0) throw new LedgerError('error', 'your Ledger asked for something plum doesn\'t know');
      const pre = this.preimages.get(hex(req.subarray(2, 34)));
      if (!pre) throw new LedgerError('error', 'your Ledger asked for data plum never committed to');
      const len = varint(pre.length);
      const fit = Math.min(255 - len.length - 1, pre.length);
      for (let i = fit; i < pre.length; i++) this.queue.push(pre.subarray(i, i + 1));
      return concat(len, Uint8Array.of(fit), pre.subarray(0, fit));
    }
    if (code === 0x41) {
      const root = hex(req.subarray(1, 33));
      let at = 33, size, index;
      [size, at] = readVarint(req, at);
      [index, at] = readVarint(req, at);
      const leaves = this.trees.get(root);
      if (!leaves || leaves.length !== size || index >= size || at !== req.length) throw new LedgerError('error', 'your Ledger asked for a proof plum can\'t give');
      if (this.queue.length) throw new LedgerError('error', 'your Ledger asked for a proof out of turn');
      const proof = merkleProof(leaves, index);
      const fit = Math.min(Math.floor((255 - 32 - 1 - 1) / 32), proof.length);
      this.queue.push(...proof.slice(fit));
      return concat(leaves[index], Uint8Array.of(proof.length, fit), ...proof.slice(0, fit));
    }
    if (code === 0x42) {
      const leaves = this.trees.get(hex(req.subarray(1, 33)));
      if (!leaves || req.length !== 65) throw new LedgerError('error', 'your Ledger asked about a list plum doesn\'t know');
      const want = req.subarray(33, 65);
      const i = leaves.findIndex((l) => equal(l, want));
      return concat(Uint8Array.of(i < 0 ? 0 : 1), varint(i < 0 ? 0 : i));
    }
    if (code === 0xa0) {
      if (req.length !== 1 || !this.queue.length) throw new LedgerError('error', 'your Ledger asked for more than plum had');
      const size = this.queue[0].length;
      if (this.queue.some((e) => e.length !== size)) throw new LedgerError('error', 'plum mixed up its queue for your Ledger');
      const out = [];
      let total = 0;
      while (this.queue.length && total + size <= 253) { out.push(this.queue.shift()); total += size; }
      return concat(Uint8Array.of(out.length, size), ...out);
    }
    throw new LedgerError('error', `your Ledger asked for something plum doesn't know (0x${code?.toString(16)})`);
  }
}

/** Send a command, answering the device's questions until it's done; returns the final data. */
async function run(link, ins, data, interp = null) {
  let { data: out, sw } = splitAnswer(await link.exchange(apdu(CLA, ins, 0x00, PROTOCOL, data)));
  while (sw === SW_INTERRUPTED) {
    if (!interp) throw new LedgerError('error', 'your Ledger asked a question plum didn\'t expect');
    const reply = interp.execute(out);
    ({ data: out, sw } = splitAnswer(await link.exchange(apdu(0xf8, 0x01, 0x00, PROTOCOL, reply))));
  }
  if (sw !== 0x9000) throw swError(sw, { app: APP, own: OWN });
  return out;
}

/* ------------------------------------------------------------ wallet policies (doc/wallet.md) */

/** The default native segwit account: { name: '', template: 'wpkh(@0/**)', keys: ["[fpr/84'/0'/0']xpub..."] }. */
export const segwitPolicy = (fingerprint, xpub, account = 0) => ({ name: '', template: 'wpkh(@0/**)', keys: [`[${fingerprint}/84'/0'/${account}']${xpub}`] });

export function serializePolicy(p) {
  const name = utf8(p.name);
  const template = utf8(p.template);
  return concat(Uint8Array.of(0x02, name.length), name, varint(template.length), sha256(template), varint(p.keys.length), merkleRoot(p.keys.map((k) => elementHash(utf8(k)))));
}

export const policyId = (p) => sha256(serializePolicy(p));

/** What the device asks about a policy: its serialization, its template, its keys. */
function knowPolicy(interp, p) {
  interp.addPreimage(serializePolicy(p));
  interp.addPreimage(utf8(p.template));
  interp.addList(p.keys.map((k) => utf8(k)));
}

/* ------------------------------------------------------------ commands */

const steps = (path) => {
  const s = pathSteps(path);
  const out = new Uint8Array(1 + 4 * s.length);
  out[0] = s.length;
  s.forEach((x, i) => new DataView(out.buffer).setUint32(1 + 4 * i, x, false));
  return out;
};

/** The master key's fingerprint, as 8 hex characters. */
export async function fingerprint(link) {
  const out = await run(link, INS.fingerprint, new Uint8Array(0));
  if (out.length !== 4) throw new LedgerError('mismatch', 'your Ledger answered with a fingerprint plum can\'t read');
  return hex(out);
}

/** The extended public key at a path (an account's, like m/84'/0'/0'). */
export async function xpub(link, path, { display = false } = {}) {
  const out = await run(link, INS.xpub, concat(Uint8Array.of(display ? 1 : 0), steps(path)));
  const text = String.fromCharCode(...out);
  try { HDKey.fromExtendedKey(text); } catch { throw new LedgerError('mismatch', "your Ledger answered with an extended key that isn't one"); }
  if (!text.startsWith('xpub')) throw new LedgerError('mismatch', "your Ledger answered with a key that isn't for Bitcoin's main network");
  return text;
}

/** An account's address at (change, index), worked out by the device from the policy (and shown, with `display`). */
export async function walletAddress(link, policy, { change = 0, index, display = false }) {
  const interp = new Interpreter();
  knowPolicy(interp, policy);
  const out = await run(link, INS.address, concat(Uint8Array.of(display ? 1 : 0), policyId(policy), new Uint8Array(32), Uint8Array.of(change), (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, index, false); return b; })()), interp);
  return String.fromCharCode(...out);
}

/** The key and address at receive index `index` of an account xpub, worked out by plum. */
export function derive(xpubText, index, change = 0) {
  const node = HDKey.fromExtendedKey(xpubText).deriveChild(change).deriveChild(index);
  return { publicKey: node.publicKey, address: btcAddressOfPublicKey(node.publicKey) };
}

/** A BIP-137 signature of a message by the key at `path`: 65 bytes (header, r, s), as base64 text expects. */
export async function signMessage(link, path, message) {
  const chunks = [];
  for (let i = 0; i < message.length; i += 64) chunks.push(message.subarray(i, i + 64));
  const interp = new Interpreter();
  interp.addList(chunks);
  const out = await run(link, INS.message, concat(steps(path), varint(message.length), merkleRoot(chunks.map(elementHash))), interp);
  if (out.length !== 65) throw new LedgerError('mismatch', 'your Ledger answered with a signature that has the wrong length');
  return out;
}

/* ------------------------------------------------------------ PSBT version 2 */

const key = (...bytes) => Uint8Array.from(bytes.flat());
/** A BIP-32 origin: fingerprint (4 bytes) then each step, 4 bytes little-endian. */
const origin = (fpr, path) => concat(Uint8Array.from(fpr.match(/../g), (b) => Number.parseInt(b, 16)), ...pathSteps(path).map((s) => u32le(s)));
const txidBytes = (txid) => Uint8Array.from(txid.match(/../g).reverse(), (b) => Number.parseInt(b, 16));

/**
 * The PSBT maps for one of plum's own sends from a native segwit wallet: every input is the wallet's (with its whole
 * previous transaction, so the device can check the amounts), every output plum's, the change marked as the
 * wallet's own. `prevTxs` maps txid -> previous transaction without witnesses.
 */
export function psbtMaps({ inputs, outputs, sequence, locktime = 0 }, { publicKey, path, fingerprint: fpr }, prevTxs) {
  const global = new Map([
    [key(0x02), u32le(2)],
    [key(0x03), u32le(locktime)],
    [key(0x04), varint(inputs.length)],
    [key(0x05), varint(outputs.length)],
    [key(0xfb), u32le(2)],
  ]);
  const ownScript = concat(Uint8Array.of(0x00, 0x14), hash160(publicKey));
  const ins = inputs.map((i) => {
    const prev = prevTxs.get(i.txid);
    if (!prev) throw new LedgerError('error', 'plum is missing a previous transaction for your Ledger');
    return new Map([
      [key(0x00), prev],
      [key(0x01), concat(u64le(i.value), varint(ownScript.length), ownScript)],
      [key(0x06, ...publicKey), origin(fpr, path)],
      [key(0x0e), txidBytes(i.txid)],
      [key(0x0f), u32le(i.vout)],
      [key(0x10), u32le(sequence)],
    ]);
  });
  const outs = outputs.map((o) => {
    const m = new Map([[key(0x03), u64le(o.value)], [key(0x04), o.script]]);
    if (o.mine) m.set(key(0x02, ...publicKey), origin(fpr, path));
    return m;
  });
  return { global, ins, outs };
}

/** Sign PSBT maps with the default account `policy`: [{ index, publicKey, signature }] as the device yields them. */
export async function signPsbt(link, { global, ins, outs }, policy) {
  const interp = new Interpreter();
  knowPolicy(interp, policy);
  interp.addMap(global);
  for (const m of ins) interp.addMap(m);
  for (const m of outs) interp.addMap(m);
  const inCommit = ins.map(mapCommitment);
  const outCommit = outs.map(mapCommitment);
  interp.addList(inCommit);
  interp.addList(outCommit);
  const data = concat(
    mapCommitment(global),
    varint(ins.length), merkleRoot(inCommit.map(elementHash)),
    varint(outs.length), merkleRoot(outCommit.map(elementHash)),
    policyId(policy), new Uint8Array(32),
  );
  await run(link, INS.signPsbt, data, interp);
  return interp.yielded.map((y) => {
    let [index, at] = readVarint(y, 0);
    if (index >= 0x80000000) throw new LedgerError('mismatch', 'your Ledger yielded something plum didn\'t ask for');
    const n = y[at++];
    const publicKey = y.slice(at, at + n);
    const signature = y.slice(at + n);
    if (n == null || publicKey.length !== n || !signature.length) throw new LedgerError('mismatch', 'your Ledger yielded a signature plum can\'t read');
    return { index, publicKey, signature };
  });
}

/* ------------------------------------------------------------ previous transactions */

/** A raw transaction (hex, with or without witnesses) without its witnesses, checked against its txid. */
export function stripWitness(rawHex, txid) {
  if (typeof rawHex !== 'string' || !/^([0-9a-f]{2})+$/i.test(rawHex.trim())) throw new LedgerError('error', 'a previous transaction came back malformed');
  const b = Uint8Array.from(rawHex.trim().match(/../g), (x) => Number.parseInt(x, 16));
  let at = 0;
  const take = (n) => { if (at + n > b.length) throw new LedgerError('error', 'a previous transaction came back cut short'); const s = b.subarray(at, at + n); at += n; return s; };
  const vi = () => { const [v, next] = readVarint(b, at); at = next; return v; };
  const version = take(4);
  const segwit = b[at] === 0x00 && b[at + 1] === 0x01;
  if (segwit) at += 2;
  const insStart = at;
  const nIn = vi();
  for (let i = 0; i < nIn; i++) { take(36); take(vi()); take(4); }
  const nOut = vi();
  for (let i = 0; i < nOut; i++) { take(8); take(vi()); }
  const body = b.subarray(insStart, at);
  if (segwit) for (let i = 0; i < nIn; i++) { const items = vi(); for (let j = 0; j < items; j++) take(vi()); }
  const locktime = take(4);
  if (at !== b.length) throw new LedgerError('error', 'a previous transaction came back with bytes left over');
  const plain = concat(version, body, locktime);
  if (hex(sha256d(plain).reverse()) !== txid) throw new LedgerError('error', "a previous transaction came back that isn't the one asked for");
  return plain;
}

/* ------------------------------------------------------------ checking what the device signed */

const N = secp256k1.Point.CURVE().n;

/** A DER signature made low-s (the same signature, as Bitcoin relays it). */
export function lowS(der) {
  const sig = secp256k1.Signature.fromBytes(der, 'der');
  return sig.s > N / 2n ? new secp256k1.Signature(sig.r, N - sig.s).toBytes('der') : der;
}

/** The app is the one this protocol needs. */
export function checkApp(info) {
  if (info.name === 'Bitcoin Legacy' || !atLeast(info.version, '2.1.0')) {
    throw new LedgerError('old-app', 'the Bitcoin app on your Ledger is too old for plum (it needs 2.1 or later): update it with Ledger Live (My Ledger)');
  }
}

export { hash160 };
