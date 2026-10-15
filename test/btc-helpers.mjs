// Shared by the Bitcoin site tests: bitcoinjs-lib set up with noble for taproot, a wallet's two keys and addresses,
// its signBitcoinAs, coins on a stand-in chain, and PSBTs built with bitcoinjs the way sites build them.
import { createHash } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { Psbt, address as baddress, initEccLib, networks, payments } from 'bitcoinjs-lib';
import { hex } from '../src/shared/bytes.js';
import { addressOf, btcPublicKey, signBtcCompact, signBtcDigest } from '../src/background/keys.js';
import { internalKey, signKeyPath, taprootAddressOf, tweakSecret } from '../src/background/taproot.js';
import { addressScript } from '../src/background/btc.js';
import { decodePsbt } from '../src/background/psbt.js';

const N = secp256k1.Point.CURVE().n;
initEccLib({
  isXOnlyPoint(x) {
    if (x.length !== 32) return false;
    try { secp256k1.Point.fromBytes(Uint8Array.from([2, ...x])); return true; } catch { return false; }
  },
  xOnlyPointAddTweak(x, tweak) {
    let P;
    try { P = secp256k1.Point.fromBytes(Uint8Array.from([2, ...x])); } catch { return null; }
    const t = BigInt(`0x${hex(tweak)}`);
    if (t >= N) return null;
    const Q = t === 0n ? P : P.add(secp256k1.Point.BASE.multiply(t));
    if (Q.is0()) return null;
    const q = Q.toBytes(true);
    return { parity: q[0] === 3 ? 1 : 0, xOnlyPubkey: q.subarray(1) };
  },
});

export const sha = (s) => createHash('sha256').update(s).digest();
export const bytesOf = (label, n = 32) => Uint8Array.from(sha(label)).subarray(0, n);

/** A wallet: its bc1q and bc1p keys, addresses and the owner record plum passes around. */
export function makeWallet(label = 'me') {
  const segKey = bytesOf(`${label} segwit`), trKey = bytesOf(`${label} taproot`);
  const owner = { segwit: addressOf('btc', segKey), taproot: taprootAddressOf(trKey), taprootKey: hex(internalKey(trKey)), segwitKey: hex(btcPublicKey(segKey)) };
  const calls = [];
  /** The wallet's signBitcoinAs. */
  const sign = async (address, digests, { compact = false } = {}) => {
    calls.push({ address, digests });
    const secret = address === owner.segwit ? segKey : address === owner.taproot ? trKey : null;
    if (!secret) throw new Error("that address isn't one of your wallets");
    if (compact) return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcCompact(d, secret)) };
    if (address === owner.taproot) return signKeyPath(digests, secret);
    return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcDigest(d, secret)) };
  };
  return { segKey, trKey, owner, sign, calls, segScript: addressScript(owner.segwit).script, trScript: addressScript(owner.taproot).script };
}

/** Someone else, with a taproot address (a seller, a marketplace, an attacker). */
export function stranger(label) {
  const key = bytesOf(`${label} key`);
  const address = taprootAddressOf(key);
  return { key, address, script: addressScript(address).script, internal: internalKey(key), tweaked: tweakSecret(key) };
}

export const p2wpkhAddress = (label) => payments.p2wpkh({ hash: bytesOf(label, 20) }).address;
export const p2trAddress = (label) => baddress.toBech32(btcPublicKey(bytesOf(label)).subarray(1), 1, 'bc');

/**
 * A PSBT built with bitcoinjs: inputs [{ txid, vout, value, script, nonWitness?, sighashType?, tapInternalKey?, extra? }]
 * and outputs [{ address | script, value }]. Returns { psbt (bitcoinjs), b64, bytes, decoded (plum's), chain (a Map
 * like prevoutsOf's) }.
 */
export function buildPsbt({ inputs, outputs, version = 2, locktime = 0 }) {
  const psbt = new Psbt({ network: networks.bitcoin });
  psbt.setVersion(version);
  psbt.setLocktime(locktime);
  const chain = new Map();
  for (const i of inputs) {
    const data = { hash: i.txid, index: i.vout, sequence: i.sequence ?? 0xfffffffd };
    if (i.nonWitness) data.nonWitnessUtxo = i.nonWitness;
    if (!i.noUtxo && !i.nonWitnessOnly) data.witnessUtxo = { script: i.claimScript ?? i.script, value: i.claimValue ?? i.value };
    if (i.sighashType != null) data.sighashType = i.sighashType;
    if (i.tapInternalKey) data.tapInternalKey = i.tapInternalKey;
    Object.assign(data, i.extra ?? {});
    psbt.addInput(data);
    chain.set(`${i.txid}:${i.vout}`, i.unknownToChain ? null : { value: i.value, script: i.script });
  }
  for (const o of outputs) psbt.addOutput(o.address ? { address: o.address, value: o.value } : { script: o.script, value: o.value });
  const b64 = psbt.toBase64();
  const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
  // read when asked for: a PSBT built to be refused doesn't read
  return { psbt, b64, bytes, get decoded() { return decodePsbt(bytes); }, chain };
}

/** A previous transaction paying `script` `value` at output `vout` (for non-witness UTXOs): { txid, raw }. */
export async function prevTx(label, outs) {
  const { Transaction } = await import('bitcoinjs-lib');
  const t = new Transaction();
  t.version = 2;
  t.addInput(bytesOf(`prev ${label}`), 0);
  for (const o of outs) t.addOutput(o.script, o.value);
  return { txid: t.getId(), raw: Uint8Array.from(t.toBuffer()) };
}

/** A bitcoinjs signature validator for both kinds. */
export const validator = (pubkey, msghash, signature) => (pubkey.length === 32
  ? schnorr.verify(signature, msghash, pubkey)
  : secp256k1.verify(signature, msghash, pubkey, { prehash: false, format: 'compact', lowS: false }));

export const txidOf = (label) => hex(bytesOf(`txid ${label}`));
