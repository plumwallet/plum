// PSBTs (BIP-174, version 0) as bytes: what a site hands over to be signed. Read strictly (every map's keys unique,
// every record the size its type says, nothing after the last map), kept as ordered key-value records so that what
// plum doesn't use is written back untouched, and written again with plum's signatures in. Finalizing (BIP-174's
// finalizer and extractor) is done here for the two kinds of input plum signs: native segwit and taproot key path.
import { concat, hex, u64le } from '../shared/bytes.js';
import { Reader, MAX_MONEY, parseTx, serializeTx, txidOf, varBytes, varint } from './btc-tx.js';

const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff); // "psbt" 0xff
export const MAX_PSBT_BYTES = 1_000_000;
const fail = (message) => new Error(`this PSBT is malformed: ${message}`);

/** Record types plum reads (BIP-174, BIP-371). */
export const G = { UNSIGNED_TX: 0x00, XPUB: 0x01, VERSION: 0xfb, PROPRIETARY: 0xfc };
export const I = {
  NON_WITNESS_UTXO: 0x00, WITNESS_UTXO: 0x01, PARTIAL_SIG: 0x02, SIGHASH_TYPE: 0x03, REDEEM_SCRIPT: 0x04, WITNESS_SCRIPT: 0x05,
  BIP32_DERIVATION: 0x06, FINAL_SCRIPTSIG: 0x07, FINAL_SCRIPTWITNESS: 0x08, TAP_KEY_SIG: 0x13, TAP_SCRIPT_SIG: 0x14,
  TAP_LEAF_SCRIPT: 0x15, TAP_BIP32_DERIVATION: 0x16, TAP_INTERNAL_KEY: 0x17, TAP_MERKLE_ROOT: 0x18,
};
export const O = { REDEEM_SCRIPT: 0x00, WITNESS_SCRIPT: 0x01, BIP32_DERIVATION: 0x02, TAP_INTERNAL_KEY: 0x05, TAP_TREE: 0x06, TAP_BIP32_DERIVATION: 0x07 };
// version 2's own records (BIP-370): a PSBT carrying them isn't version 0
const V2_GLOBAL = new Set([0x02, 0x03, 0x04, 0x05, 0x06]);

/** One map: its records in order, [{ type, keydata, value }]. */
function readMap(r, what) {
  const records = [];
  const seen = new Set();
  for (;;) {
    const keyLen = r.varint();
    if (keyLen === 0) return records;
    const key = r.take(keyLen);
    const value = r.varBytes();
    const id = hex(key);
    if (seen.has(id)) throw fail(`${what} has the same key twice`);
    seen.add(id);
    records.push({ type: key[0], keydata: key.slice(1), value: value.slice() });
  }
}

const writeMap = (records) => concat(...records.map((x) => concat(varBytes(concat(Uint8Array.of(x.type), x.keydata)), varBytes(x.value))), Uint8Array.of(0));

const one = (map, type) => map.find((x) => x.type === type) ?? null;
const all = (map, type) => map.filter((x) => x.type === type);

/** A transaction output as BIP-174 writes it (value, then the script with its length). */
function readTxOut(bytes) {
  const r = new Reader(bytes);
  const value = r.u64();
  const script = r.varBytes().slice();
  if (r.left) throw fail('a witness UTXO has bytes after its end');
  if (value > MAX_MONEY) throw fail('a witness UTXO is worth more than all the bitcoin there is');
  return { value, script };
}
const writeTxOut = (o) => concat(u64le(o.value), varBytes(o.script));

const u32 = (v) => { if (v.length !== 4) throw fail('a sighash type is not 4 bytes'); return (v[0] | (v[1] << 8) | (v[2] << 16)) + v[3] * 2 ** 24; };

/** Read an input's records into what they say, checking each one's shape. */
function inputView(map, index) {
  const at = `input ${index}`;
  const view = { map, partialSigs: [], tapScriptSigs: [], tapLeafScripts: [] };
  for (const x of map) {
    switch (x.type) {
      case I.NON_WITNESS_UTXO:
        if (x.keydata.length) throw fail(`${at}'s previous transaction has a key it shouldn't`);
        try { view.nonWitnessUtxo = parseTx(x.value); } catch (e) { throw fail(`${at}'s previous transaction doesn't read (${e.message})`); }
        break;
      case I.WITNESS_UTXO:
        if (x.keydata.length) throw fail(`${at}'s witness UTXO has a key it shouldn't`);
        view.witnessUtxo = readTxOut(x.value);
        break;
      case I.PARTIAL_SIG:
        if (x.keydata.length !== 33 && x.keydata.length !== 65) throw fail(`${at} has a partial signature for a key of the wrong size`);
        view.partialSigs.push({ pubkey: x.keydata, signature: x.value });
        break;
      case I.SIGHASH_TYPE:
        if (x.keydata.length) throw fail(`${at}'s sighash type has a key it shouldn't`);
        view.sighashType = u32(x.value);
        break;
      case I.REDEEM_SCRIPT: view.redeemScript = x.value; break;
      case I.WITNESS_SCRIPT: view.witnessScript = x.value; break;
      case I.FINAL_SCRIPTSIG: view.finalScriptSig = x.value; break;
      case I.FINAL_SCRIPTWITNESS: {
        const r = new Reader(x.value);
        const n = r.varint();
        const items = [];
        for (let k = 0; k < n; k++) items.push(r.varBytes().slice());
        if (r.left) throw fail(`${at}'s final witness has bytes after its end`);
        view.finalScriptWitness = items;
        break;
      }
      case I.TAP_KEY_SIG:
        if (x.keydata.length || (x.value.length !== 64 && x.value.length !== 65)) throw fail(`${at}'s taproot key signature is the wrong size`);
        view.tapKeySig = x.value;
        break;
      case I.TAP_SCRIPT_SIG: view.tapScriptSigs.push(x); break;
      case I.TAP_LEAF_SCRIPT: view.tapLeafScripts.push(x); break;
      case I.TAP_INTERNAL_KEY:
        if (x.keydata.length || x.value.length !== 32) throw fail(`${at}'s taproot internal key is the wrong size`);
        view.tapInternalKey = x.value;
        break;
      case I.TAP_MERKLE_ROOT:
        if (x.keydata.length || x.value.length !== 32) throw fail(`${at}'s taproot merkle root is the wrong size`);
        view.tapMerkleRoot = x.value;
        break;
      default: break; // derivations, preimages, proprietary and unknown records: kept as they are
    }
  }
  return view;
}

/** A PSBT from its bytes: { tx (the unsigned transaction), global, inputs: [view], outputs: [{ map }] }. */
export function decodePsbt(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length + 1) throw fail('it is empty');
  if (bytes.length > MAX_PSBT_BYTES) throw fail(`it is ${bytes.length} bytes, more than plum reads`);
  if (!MAGIC.every((b, i) => bytes[i] === b)) throw fail("it doesn't start with PSBT's magic bytes");
  const r = new Reader(bytes);
  r.take(MAGIC.length);
  let global;
  try { global = readMap(r, 'its global map'); } catch (e) { throw e.message.startsWith('this PSBT') ? e : fail(e.message); }
  if (global.some((x) => V2_GLOBAL.has(x.type))) throw new Error('this is a version 2 PSBT: plum reads version 0 (what sats-connect and every Bitcoin wallet send)');
  const version = one(global, G.VERSION);
  if (version && u32(version.value) !== 0) throw new Error(`this is a version ${u32(version.value)} PSBT: plum reads version 0`);
  const txRec = one(global, G.UNSIGNED_TX);
  if (!txRec || txRec.keydata.length) throw fail('it has no unsigned transaction');
  let tx;
  try { tx = parseTx(txRec.value); } catch (e) { throw fail(`its transaction doesn't read (${e.message})`); }
  if (tx.inputs.some((i) => i.scriptSig.length || i.witness.length)) throw fail('its transaction is already signed (BIP-174 wants it unsigned)');
  const inputs = [], outputs = [];
  try {
    for (let i = 0; i < tx.inputs.length; i++) inputs.push(inputView(readMap(r, `input ${i}`), i));
    for (let i = 0; i < tx.outputs.length; i++) outputs.push({ map: readMap(r, `output ${i}`) });
  } catch (e) { throw e.message.startsWith('this PSBT') ? e : fail(e.message); }
  if (r.left) throw fail('there are bytes after its last map');
  // a previous transaction must be the one the input spends
  inputs.forEach((v, i) => {
    if (!v.nonWitnessUtxo) return;
    if (txidOf(v.nonWitnessUtxo) !== tx.inputs[i].txid) throw fail(`input ${i}'s previous transaction isn't the one it spends`);
    if (!v.nonWitnessUtxo.outputs[tx.inputs[i].vout]) throw fail(`input ${i} spends an output its previous transaction doesn't have`);
  });
  return { tx, global, inputs, outputs };
}

/** The PSBT's bytes again, with whatever records were changed. */
export function encodePsbt(p) {
  return concat(MAGIC, writeMap(p.global), ...p.inputs.map((v) => writeMap(v.map)), ...p.outputs.map((v) => writeMap(v.map)));
}

/** Put a record in a map (in place of one with the same key). */
export function setRecord(map, type, keydata, value) {
  const id = hex(keydata);
  const at = map.findIndex((x) => x.type === type && hex(x.keydata) === id);
  const rec = { type, keydata, value };
  if (at >= 0) map[at] = rec; else map.push(rec);
}

/** What an input spends, as the PSBT says: { value, script }, from its witness UTXO or its previous transaction (and
 * where both are given they must agree), or null when it says neither. */
export function claimedPrevout(p, i) {
  const v = p.inputs[i];
  const fromTx = v.nonWitnessUtxo ? v.nonWitnessUtxo.outputs[p.tx.inputs[i].vout] : null;
  if (v.witnessUtxo && fromTx && (v.witnessUtxo.value !== fromTx.value || hex(v.witnessUtxo.script) !== hex(fromTx.script))) {
    throw new Error(`this PSBT contradicts itself about input ${i}: its witness UTXO says ${v.witnessUtxo.value} sats, its previous transaction ${fromTx.value}`);
  }
  return v.witnessUtxo ?? fromTx ?? null;
}

/**
 * Finalize an input plum signed (BIP-174's finalizer): its final witness from its signature, and every record but the
 * UTXOs and unknown ones cleared. `kind` is 'p2wpkh' (signature + public key) or 'p2tr' (the key-path signature).
 */
export function finalizeInput(p, i, kind, { signature, pubkey }) {
  const v = p.inputs[i];
  const witness = kind === 'p2tr' ? [signature] : [signature, pubkey];
  const keep = new Set([I.NON_WITNESS_UTXO, I.WITNESS_UTXO]);
  const known = new Set(Object.values(I));
  v.map = v.map.filter((x) => keep.has(x.type) || !known.has(x.type));
  v.map.push({ type: I.FINAL_SCRIPTWITNESS, keydata: new Uint8Array(0), value: concat(varint(witness.length), ...witness.map(varBytes)) });
  Object.assign(p.inputs[i], inputView(v.map, i));
}

/** The network transaction from a PSBT whose every input is final (BIP-174's extractor): { raw (hex), txid }. */
export function extractTx(p) {
  const tx = { ...p.tx, inputs: p.tx.inputs.map((input, i) => {
    const v = p.inputs[i];
    if (!v.finalScriptSig && !v.finalScriptWitness) throw new Error(`input ${i} isn't signed yet, so the transaction can't be sent`);
    return { ...input, scriptSig: v.finalScriptSig ?? new Uint8Array(0), witness: v.finalScriptWitness ?? [] };
  }) };
  return { raw: hex(serializeTx(tx)), txid: txidOf(tx), tx };
}

export const _test = { readTxOut, writeTxOut, all };
