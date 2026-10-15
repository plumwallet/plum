// A Solana transaction, read and written straight from its bytes (legacy and v0): where the message starts (that's
// what gets signed), which accounts are writable, and a writer for the few transactions plum builds itself (sends),
// so no Solana library is needed anywhere.
import { base58Decode, base58Encode } from './base58.js';
import { concat, readU32, readU64, u32le, u64le } from './bytes.js';

/** The most a legacy or v0 transaction can be. */
export const MAX_TX_BYTES = 1232;

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SIGNATURE_FEE = 5000n;

/** A cursor over the bytes that refuses to read past the end. */
function reader(bytes, start = 0) {
  let at = start;
  const take = (n) => {
    if (at + n > bytes.length) throw new Error('it ends too early');
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const byte = () => take(1)[0];
  // compact-u16: 7 bits a byte, low first, at most 3 bytes
  const short = () => {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const b = byte();
      v |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) return v;
    }
    throw new Error('a length is malformed');
  };
  return { take, byte, short, get at() { return at; } };
}

export function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('length out of range');
  const out = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v) out.push(b | 0x80);
    else { out.push(b); return Uint8Array.from(out); }
  }
}

/** The message part (what a signature covers), read from position `start` (to the very end, unless `exact` is off). */
function readMessageAt(bytes, start, exact = true) {
  const r = reader(bytes, start);
  let version = 'legacy';
  if (bytes[r.at] & 0x80) {
    version = r.byte() & 0x7f;
    if (version !== 0) throw new Error(`it is a version ${version} transaction, which plum can't read yet`);
  }
  const [required, readonlySigned, readonlyUnsigned] = r.take(3);
  const keys = [];
  for (let i = r.short(); i > 0; i--) keys.push(base58Encode(r.take(32)));
  if (required > keys.length || readonlySigned > required || readonlyUnsigned > keys.length - required) {
    throw new Error('its header is impossible');
  }
  const blockhash = base58Encode(r.take(32));
  const instructions = [];
  for (let i = r.short(); i > 0; i--) {
    const programIndex = r.byte();
    const accounts = [...r.take(r.short())];
    const data = r.take(r.short());
    instructions.push({ programIndex, accounts, data });
  }
  const lookups = [];
  if (version === 0) {
    for (let i = r.short(); i > 0; i--) {
      const table = base58Encode(r.take(32));
      const writable = [...r.take(r.short())];
      const readonly = [...r.take(r.short())];
      lookups.push({ table, writable, readonly });
    }
  }
  if (exact && r.at !== bytes.length) throw new Error('it has bytes left over at the end');
  return { version, required, readonlySigned, readonlyUnsigned, keys, blockhash, instructions, lookups };
}

const asBytes = (input) => (input instanceof Uint8Array ? input : Uint8Array.from(input));

/**
 * A legacy or v0 transaction, decoded. `message` is the signed part and `sigStart` where the first signature sits.
 * Throws on anything else (a v1 transaction included: plum can't read it, so it never signs it).
 */
export function readTx(input) {
  const bytes = asBytes(input);
  if (!bytes.length) throw new Error('it is empty');
  if (bytes[0] === 0x81) throw new Error("it is a v1 transaction, which plum can't read yet");
  const r = reader(bytes);
  const count = r.short();
  const sigStart = r.at;
  const signatures = [];
  for (let i = 0; i < count; i++) signatures.push(r.take(64));
  const messageStart = r.at;
  const m = readMessageAt(bytes, messageStart);
  if (signatures.length !== m.required) throw new Error(`it has ${signatures.length} signature slots for ${m.required} signers`);
  return { bytes, size: bytes.length, signatures, sigStart, messageStart, message: bytes.subarray(messageStart), ...m };
}

/** A bare message (no signatures in front), decoded; throws when the bytes aren't exactly one. */
export const readMessage = (input) => readMessageAt(asBytes(input), 0);

/** Do these bytes read as a transaction or a transaction's message? (A "message" to sign must never be one.) */
export function isTransactionShaped(bytes) {
  for (const read of [readTx, readMessage]) {
    try { read(bytes); return true; } catch { /* not this shape */ }
  }
  return false;
}

/** Do these bytes begin like a transaction or a message, even with more after them? */
export function startsLikeTransaction(input) {
  const bytes = asBytes(input);
  try { readMessageAt(bytes, 0, false); return true; } catch { /* no */ }
  try {
    const r = reader(bytes);
    const count = r.short();
    if (count < 1 || count > 64) return false;
    r.take(64 * count);
    return readMessageAt(bytes, r.at, false).required === count;
  } catch {
    return false;
  }
}

/** Is a static account key (by index) writable, by the message header? */
export function isStaticWritable(t, i) {
  if (i < t.required) return i < t.required - t.readonlySigned;
  return i < t.keys.length - t.readonlyUnsigned;
}

export const signersOf = (t) => t.keys.slice(0, t.required);
export const isSigned = (sig) => sig.some((b) => b !== 0);

/** The compute budget a transaction sets: { units, microLamports, priorityLamports }. */
export function computeBudgetOf(t, programOf = (ix) => t.keys[ix.programIndex]) {
  let units = null, price = 0n, counted = 0;
  for (const ix of t.instructions) {
    if (programOf(ix) === COMPUTE_BUDGET_PROGRAM) {
      // the runtime ignores bytes after the value, so a padded instruction still counts
      if (ix.data[0] === 2 && ix.data.length >= 5) units = readU32(ix.data, 1);
      if (ix.data[0] === 3 && ix.data.length >= 9) price = readU64(ix.data, 1);
      continue;
    }
    counted++;
  }
  // without a limit, each instruction may use 200,000 units (1,400,000 at most)
  const used = BigInt(units ?? Math.min(counted * 200_000, 1_400_000));
  return { units, microLamports: price, priorityLamports: (used * price + 999_999n) / 1_000_000n };
}

/** The network fee a transaction will pay: 5000 lamports a signature plus its priority fee. */
export function feeOf(t) {
  return SIGNATURE_FEE * BigInt(t.required) + computeBudgetOf(t).priorityLamports;
}

/** Put `signature` in `signer`'s slot. Returns new bytes; throws if the transaction doesn't ask `signer` to sign. */
export function withSignature(input, signer, signature) {
  const t = readTx(input);
  const at = signersOf(t).indexOf(signer);
  if (at < 0) throw new Error("this transaction doesn't ask for your signature");
  if (signature.length !== 64) throw new Error('a signature is 64 bytes');
  const out = t.bytes.slice();
  out.set(signature, t.sigStart + at * 64);
  return out;
}

/* ------------------------------------------------------------ writing: the transactions plum builds (legacy) */

/**
 * A legacy message from instructions: [{ programId, keys: [{ pubkey, isSigner, isWritable }], data }]. The payer comes
 * first; accounts are grouped signer+writable, signer, writable, read-only as the runtime expects.
 */
export function compileLegacy({ payer, blockhash, instructions }) {
  const metas = new Map();
  const touch = (k, signer, writable) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    m.signer ||= signer;
    m.writable ||= writable;
    metas.set(k, m);
  };
  touch(payer, true, true);
  for (const ix of instructions) for (const a of ix.keys) touch(a.pubkey, !!a.isSigner, !!a.isWritable);
  for (const ix of instructions) touch(ix.programId, false, false);
  const all = [...metas.entries()];
  const group = (s, w) => all.filter(([, m]) => m.signer === s && m.writable === w).map(([k]) => k);
  const keys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const index = new Map(keys.map((k, i) => [k, i]));
  const required = group(true, true).length + group(true, false).length;
  const header = Uint8Array.of(required, group(true, false).length, group(false, false).length);
  const parts = [header, compactU16(keys.length), ...keys.map((k) => base58Decode32(k)), base58Decode32(blockhash), compactU16(instructions.length)];
  for (const ix of instructions) {
    parts.push(Uint8Array.of(index.get(ix.programId)), compactU16(ix.keys.length), Uint8Array.from(ix.keys.map((a) => index.get(a.pubkey))));
    parts.push(compactU16(ix.data.length), ix.data);
  }
  return concat(...parts);
}

/** An unsigned transaction around a message: one empty signature slot per signer. */
export function unsignedTx(message) {
  const m = readMessage(message);
  return concat(compactU16(m.required), new Uint8Array(64 * m.required), message);
}

export function base58Decode32(s) {
  const b = base58Decode(s);
  if (b.length !== 32) throw new Error(`not a 32-byte address: ${s}`);
  return b;
}

/* ------------------------------------------------------------ instructions */

export const ix = {
  /** System: move lamports from one wallet to another. */
  transfer: (from, to, lamports) => ({
    programId: SYSTEM_PROGRAM,
    keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
    data: concat(u32le(2), u64le(lamports)),
  }),
  unitLimit: (units) => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat(Uint8Array.of(2), u32le(units)) }),
  unitPrice: (microLamports) => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat(Uint8Array.of(3), u64le(microLamports)) }),
  /** Associated Token Account: create `ata` for (owner, mint) unless it's there already. */
  createAtaIdempotent: (payer, ata, owner, mint, tokenProgram) => ({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  }),
  /** Token / Token-2022: TransferChecked (12), which also checks the mint and its decimals. */
  transferChecked: (source, mint, dest, owner, amount, decimals, tokenProgram) => ({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: concat(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)),
  }),
};
