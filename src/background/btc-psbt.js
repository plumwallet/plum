// A site's PSBT, read before you sign it: every input (yours or not, what it spends, checked against the chain where
// the chain answers), every output (to you or not), what leaves your wallet and what comes back, the fee and its rate,
// which inputs plum signs and with which sighash type, and every danger in words. Then the signatures, for your inputs
// only: native segwit ones with BIP-143, taproot ones on the key path with BIP-341. Plum never signs an input that
// isn't the wallet's, a taproot script path, or an input whose coin it can't see.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concat, hex } from '../shared/bytes.js';
import { DUST, addressScript, p2pkhCode, scriptInfo } from './btc.js';
import { SIGHASH, V0_TYPES, V1_TYPES, sighashName, sighashV0, sighashV1, varint } from './btc-tx.js';
import { hash160 } from './keys.js';
import { I, claimedPrevout, encodePsbt, finalizeInput, setRecord } from './psbt.js';
import { verifyKeyPath } from './taproot.js';

const fail = (message) => new Error(message);
const sum = (xs) => xs.reduce((n, x) => n + x, 0n);
const btc = (sats) => {
  const s = (sats < 0n ? -sats : sats).toString().padStart(9, '0');
  const t = `${s.slice(0, -8)}.${s.slice(-8)}`.replace(/\.?0+$/, '');
  return `${sats < 0n ? '-' : ''}${t} BTC`;
};
// an input still to be signed, in weight units: its outpoint, script and sequence, and its witness (an unknown kind
// counts as a native segwit one; p2sh as P2SH-P2WPKH)
const INPUT_WU = { p2wpkh: 41 * 4 + 108, p2tr: 41 * 4 + 66, p2pkh: (41 + 107) * 4 + 1, p2sh: (41 + 23) * 4 + 108 };

/** In words, what a sighash type lets others do with your signature. */
export function sighashDanger(type, index) {
  const at = `input ${index}`;
  const base = type & 3, acp = !!(type & SIGHASH.ANYONECANPAY);
  if (type === SIGHASH.DEFAULT || type === SIGHASH.ALL) return null;
  if (base === SIGHASH.NONE) return `${at} is signed with SIGHASH_NONE${acp ? '|ANYONECANPAY' : ''}: the signature covers none of the outputs, so whoever holds it can send this coin anywhere`;
  if (base === SIGHASH.SINGLE && acp) return `${at} is signed with SIGHASH_SINGLE|ANYONECANPAY: it only fixes output ${index}, so anyone can take this coin into a transaction of their own as long as they pay that output. Marketplaces list inscriptions for sale this way: sign only if you mean to sell at that price`;
  if (base === SIGHASH.SINGLE) return `${at} is signed with SIGHASH_SINGLE: it only fixes output ${index}, so the rest of the transaction's outputs can be changed after you sign`;
  return `${at} is signed with SIGHASH_ALL|ANYONECANPAY: every output is fixed, but others can add inputs to the transaction`;
}

/**
 * The review of a PSBT, for the approval window. Throws when plum refuses it outright (an input that isn't the
 * wallet's asked for, a lie about what an input spends, a script path...).
 *   owner     { segwit, taproot, taprootKey (x-only internal key, hex) }: the wallet's addresses
 *   toSign    [{ index, address, sighash? }] the site asked for, or null for every input of the wallet's
 *   chain     Map 'txid:vout' -> { value, script } | null from the chain, or null when the chain couldn't be read
 *   contents  Map 'txid:vout' -> { inscriptions: [{ id, offset }], runes: [{ name, amount }] } for the wallet's inputs
 *   rates     today's fee rates { fast, normal, slow } or null
 */
export function reviewPsbt(p, { owner, toSign = null, chain = null, contents = null, rates = null }) {
  const scripts = { p2wpkh: addressScript(owner.segwit).script, p2tr: owner.taproot ? addressScript(owner.taproot).script : null };
  const mineOf = (script) => (hex(script) === hex(scripts.p2wpkh) ? 'p2wpkh' : scripts.p2tr && hex(script) === hex(scripts.p2tr) ? 'p2tr' : null);
  const warnings = [];
  const inputs = p.tx.inputs.map((input, i) => {
    const v = p.inputs[i];
    const claimed = claimedPrevout(p, i);
    const key = `${input.txid}:${input.vout}`;
    const real = chain?.get(key);
    if (real && claimed && (real.value !== claimed.value || hex(real.script) !== hex(claimed.script))) {
      throw fail(real.value !== claimed.value
        ? `this PSBT lies about input ${i}: it says the coin holds ${btc(claimed.value)}, the chain says ${btc(real.value)}. Plum won't sign it.`
        : `this PSBT lies about input ${i}: it says the coin belongs to ${scriptInfo(claimed.script).address ?? 'a script'}, the chain says ${scriptInfo(real.script).address ?? 'another script'}. Plum won't sign it.`);
    }
    const prev = real ?? claimed;
    const info = prev ? scriptInfo(prev.script) : null;
    return {
      index: i, txid: input.txid, vout: input.vout, sequence: input.sequence,
      value: prev ? prev.value : null, script: prev?.script ?? null, address: info?.address ?? null, kind: info?.kind ?? null,
      mine: prev ? mineOf(prev.script) : null,
      verified: real ? 'chain' : v.nonWitnessUtxo ? 'tx' : claimed ? 'claimed' : null,
      signed: !!(v.finalScriptSig || v.finalScriptWitness || v.partialSigs.length || v.tapKeySig || v.tapScriptSigs.length),
      sighash: v.sighashType ?? null, sign: false, holds: contents?.get(key) ?? null,
    };
  });
  const outputs = p.tx.outputs.map((o, i) => {
    const info = scriptInfo(o.script);
    return { index: i, value: o.value, address: info.address, kind: info.kind, mine: mineOf(o.script) };
  });

  // which inputs plum signs: the ones asked for (each must be the wallet's, for the address named), or every one of
  // the wallet's
  const asked = toSign ?? inputs.filter((x) => x.mine).map((x) => ({ index: x.index, address: x.mine === 'p2tr' ? owner.taproot : owner.segwit }));
  if (!asked.length) throw fail("none of this PSBT's inputs are this wallet's: there's nothing for plum to sign");
  for (const { index, address, sighash } of asked) {
    const x = inputs[index];
    if (!Number.isInteger(index) || !x) throw fail(`the site asked plum to sign input ${index}, which this PSBT doesn't have`);
    if (address !== owner.segwit && address !== owner.taproot) throw fail(`the site asked plum to sign for ${String(address).slice(0, 90)}, which isn't this wallet's address`);
    if (!x.script) throw fail(`plum can't tell what input ${index} spends (the PSBT carries no UTXO for it), so it won't sign it`);
    if (!x.mine) throw fail(`input ${index} spends ${x.address ?? 'a script'}, which isn't this wallet's: plum won't sign it`);
    if ((x.mine === 'p2tr' ? owner.taproot : owner.segwit) !== address) throw fail(`input ${index} belongs to this wallet's other address, not ${address}`);
    const v = p.inputs[index];
    if (x.mine === 'p2tr') {
      if (v.tapMerkleRoot || v.tapLeafScripts.length) throw fail(`input ${index} asks for a taproot script path: plum's taproot address has none, so it won't sign it`);
      if (v.tapInternalKey && hex(v.tapInternalKey) !== owner.taprootKey) throw fail(`the PSBT says input ${index}'s taproot key is another one: plum won't sign it`);
    }
    if (v.redeemScript || v.witnessScript) throw fail(`input ${index} carries a script plum's address doesn't use: plum won't sign it`);
    // a sighash type the site asks for beside the PSBT must agree with the one the PSBT carries
    if (sighash != null && x.sighash != null && sighash !== x.sighash) throw fail(`the site asks for sighash type ${sighash} on input ${index}, but the PSBT says ${x.sighash}: plum won't sign it`);
    const type = sighash ?? x.sighash ?? (x.mine === 'p2tr' ? SIGHASH.DEFAULT : SIGHASH.ALL);
    if (!(x.mine === 'p2tr' ? V1_TYPES : V0_TYPES).includes(type)) throw fail(`input ${index} asks for sighash type ${type}, which plum doesn't sign`);
    if ((type & 3) === SIGHASH.SINGLE && index >= outputs.length) throw fail(`input ${index} asks for SIGHASH_SINGLE but there's no output ${index}: plum won't sign that`);
    x.sign = true;
    x.sighash = type;
  }
  const signing = inputs.filter((x) => x.sign);
  // a taproot signature (without ANYONECANPAY) covers what every input spends: plum must know each one
  for (const x of signing) {
    if (x.mine === 'p2tr' && !(x.sighash & SIGHASH.ANYONECANPAY)) {
      const unknown = inputs.find((y) => !y.script);
      if (unknown) throw fail(`a taproot signature covers every input's coin, and the PSBT doesn't say what input ${unknown.index} spends: plum won't sign it`);
    }
  }

  // what leaves and what comes back
  const leaves = sum(signing.map((x) => x.value));
  const fixedAll = signing.every((x) => (x.sighash & 3) !== SIGHASH.NONE && (x.sighash & 3) !== SIGHASH.SINGLE);
  const covered = fixedAll ? outputs : outputs.filter((o) => signing.some((x) => (x.sighash & 3) === SIGHASH.SINGLE && x.index === o.index));
  const arrives = sum(covered.filter((o) => o.mine).map((o) => o.value));
  const toOthers = covered.filter((o) => !o.mine);
  const known = inputs.every((x) => x.value != null);
  const fee = known ? sum(inputs.map((x) => x.value)) - sum(outputs.map((o) => o.value)) : null;
  const vsize = signedSize(p, inputs);
  const feeRate = fee != null && fee >= 0n ? Number(fee) / vsize : null;

  // dangers, in words
  for (const x of signing) {
    const d = sighashDanger(x.sighash, x.index);
    if (d) warnings.push({ level: 'danger', text: d });
  }
  for (const x of signing) {
    if (x.mine === 'p2wpkh' && x.verified === 'claimed') warnings.push({ level: 'danger', text: `plum couldn't check what input ${x.index} holds (the PSBT carries only its witness UTXO, and the chain didn't answer): a PSBT that lies about it can make you pay a huge fee` });
    if (x.holds?.inscriptions?.length) warnings.push({ level: 'danger', text: `input ${x.index} holds ${x.holds.inscriptions.length === 1 ? 'an inscription' : `${x.holds.inscriptions.length} inscriptions`} (${x.holds.inscriptions.slice(0, 3).map((n) => short(n.id)).join(', ')}): ${whereInscriptionsGo(x, inputs, outputs, fixedAll)}` });
    if (x.holds?.runes?.length) warnings.push({ level: 'danger', text: `input ${x.index} holds runes (${x.holds.runes.slice(0, 3).map((r) => `${r.amount} ${r.name}`).join(', ')}): signing lets them go where this transaction's runestone sends them, and a malformed one burns them` });
  }
  if (fee != null && fee < 0n && fixedAll) warnings.push({ level: 'warn', text: "its outputs are worth more than its inputs, so it can't be sent as it is: someone has to add coins first" });
  if (feeRate != null && known) {
    const ceiling = Math.max(500, (rates?.fast ?? 50) * 10);
    if (feeRate > ceiling) warnings.push({ level: 'danger', text: `the network fee is absurd: ${btc(fee)}, about ${Math.round(feeRate).toLocaleString('en-US')} sat/vB${rates ? ` when the fastest rate today is ${rates.fast}` : ''}. It goes to miners, not to anyone you're paying` });
    else if (rates && feeRate > rates.fast * 3 && fee > 20_000n) warnings.push({ level: 'warn', text: `the network fee is high: ${btc(fee)}, about ${Math.round(feeRate)} sat/vB (the fastest rate today is ${rates.fast})` });
  }
  if (!known) warnings.push({ level: 'warn', text: "plum can't tell the network fee: the PSBT doesn't say what every input spends" });
  // an address dressed up as yours: change "back to you" that goes elsewhere
  for (const o of toOthers) {
    const twin = [owner.segwit, owner.taproot].filter(Boolean).find((a) => o.address && a !== o.address && a.slice(0, 7) === o.address.slice(0, 7) && a.slice(-4) === o.address.slice(-4));
    if (twin) warnings.push({ level: 'danger', text: `output ${o.index} goes to ${o.address}, which looks like your address but isn't: your coins would go to someone else` });
  }
  if (outputs.some((o) => o.mine === null && o.value < DUST && o.kind !== 'data' && o.kind !== 'runestone')) warnings.push({ level: 'info', text: 'it makes an output below the dust limit, which most nodes won\'t relay' });

  return {
    inputs, outputs, leaves, arrives, net: arrives - leaves, fee, feeRate, vsize, fixed: fixedAll,
    toOthers: sum(toOthers.map((o) => o.value)),
    complete: inputs.every((x) => x.sign || x.signed),
    warnings,
  };
}

/** The transaction's virtual size once every input is signed: final inputs measured, the rest estimated by kind. */
function signedSize(p, inputs) {
  const outBytes = p.tx.outputs.reduce((n, o) => n + 8 + varint(o.script.length).length + o.script.length, 0);
  const frame = 4 * (8 + varint(inputs.length).length + varint(p.tx.outputs.length).length + outBytes) + 2;
  const weight = inputs.reduce((n, x) => {
    const v = p.inputs[x.index];
    if (v.finalScriptSig || v.finalScriptWitness) {
      const sig = v.finalScriptSig ?? new Uint8Array(0);
      const wit = v.finalScriptWitness ?? [];
      return n + 4 * (40 + varint(sig.length).length + sig.length) + varint(wit.length).length + wit.reduce((m, w) => m + varint(w.length).length + w.length, 0);
    }
    const kind = x.mine ?? x.kind;
    return n + (kind === 'p2tr' && x.sighash ? INPUT_WU.p2tr + 1 : INPUT_WU[kind] ?? INPUT_WU.p2wpkh);
  }, frame);
  return Math.ceil(weight / 4);
}

const short = (s) => (s.length > 16 ? `${s.slice(0, 8)}..${s.slice(-6)}` : s);

/** Where an input's inscriptions land, by ordinal theory: sats go first in, first out, so an inscription at offset k of
 * input i sits at (the inputs before it + k) and lands in the output covering that sat, or in the fee past the last. */
function whereInscriptionsGo(x, inputs, outputs, fixed) {
  if (!fixed) return 'signing lets them leave your wallet with this coin';
  if (inputs.slice(0, x.index).some((y) => y.value == null)) return 'signing lets them leave with this coin (plum can\'t follow them: an earlier input\'s amount is unknown)';
  const before = sum(inputs.slice(0, x.index).map((y) => y.value));
  const where = x.holds.inscriptions.map((n) => {
    if (n.offset == null) return "leaves with this coin (plum couldn't tell where in the coin it sits, so not where it lands)";
    let at = before + BigInt(n.offset);
    for (const o of outputs) {
      if (at < o.value) return o.mine ? 'stays with you' : `goes to ${o.address ?? 'a script'}`;
      at -= o.value;
    }
    return 'ends up in the network fee (lost to a miner)';
  });
  const uniq = [...new Set(where)];
  return uniq.length === 1 ? `it ${uniq[0]}` : `they ${uniq.join(' / ')}`;
}

/**
 * Sign the inputs a review marked, with `sign(address, sighashes)` (the wallet's signBitcoinAs), each signature
 * checked against the coin it spends; with `finalize`, those inputs are finalized too. Returns the PSBT's bytes.
 */
export async function signPsbt(p, review, owner, sign, { finalize = false } = {}) {
  const tx = p.tx;
  const prevouts = review.inputs.map((x) => (x.script ? { value: x.value, script: x.script } : null));
  const keyHash = addressScript(owner.segwit).script.subarray(2);
  const signing = review.inputs.filter((x) => x.sign);
  const segwit = signing.filter((x) => x.mine === 'p2wpkh');
  const taproot = signing.filter((x) => x.mine === 'p2tr');
  const done = [];
  if (segwit.length) {
    const digests = segwit.map((x) => sighashV0(tx, x.index, p2pkhCode(keyHash), x.value, x.sighash));
    const { publicKey, signatures } = await sign(owner.segwit, digests);
    if (hex(hash160(publicKey)) !== hex(keyHash)) throw fail("the key that signed isn't this wallet's: nothing was signed");
    segwit.forEach((x, k) => {
      if (!secp256k1.verify(signatures[k], digests[k], publicKey, { prehash: false, format: 'der' })) throw fail('a signature did not verify: nothing was signed');
      const sig = concat(signatures[k], Uint8Array.of(x.sighash));
      setRecord(p.inputs[x.index].map, I.PARTIAL_SIG, publicKey, sig);
      done.push([x.index, 'p2wpkh', { signature: sig, pubkey: publicKey }]);
    });
  }
  if (taproot.length) {
    const outputKey = addressScript(owner.taproot).script.subarray(2);
    const digests = taproot.map((x) => sighashV1(tx, x.index, x.sighash & SIGHASH.ANYONECANPAY ? prevouts.map((y, i) => (i === x.index ? y : y ?? { value: 0n, script: new Uint8Array(0) })) : prevouts, x.sighash));
    const res = await sign(owner.taproot, digests);
    if (hex(res.outputKey) !== hex(outputKey)) throw fail("the key that signed isn't this wallet's: nothing was signed");
    taproot.forEach((x, k) => {
      if (!verifyKeyPath(res.signatures[k], digests[k], outputKey)) throw fail('a signature did not verify: nothing was signed');
      const sig = x.sighash === SIGHASH.DEFAULT ? res.signatures[k] : concat(res.signatures[k], Uint8Array.of(x.sighash));
      setRecord(p.inputs[x.index].map, I.TAP_KEY_SIG, new Uint8Array(0), sig);
      // the internal key too (BIP-371), so a site's own library can check the signature before it sends
      setRecord(p.inputs[x.index].map, I.TAP_INTERNAL_KEY, new Uint8Array(0), Uint8Array.from(owner.taprootKey.match(/../g), (b) => Number.parseInt(b, 16)));
      done.push([x.index, 'p2tr', { signature: sig }]);
    });
  }
  if (finalize) for (const [i, kind, s] of done) finalizeInput(p, i, kind, s);
  return encodePsbt(p);
}

export const _test = { btc };
