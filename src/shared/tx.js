// A Solana transaction, read and written straight from its bytes (legacy, v0 and v1): where the message starts (that's
// what gets signed), which accounts are writable, and a writer for the few transactions plum builds itself (sends),
// so no Solana library is needed anywhere.
//
// v1 (SIMD-0385) is laid out differently: the message comes first, from its version byte 0x81, and the signatures sit at
// the tail, one for each required signer, with no count in front. Its message is
//   0x81 | 3-byte header | u32 config mask | 32-byte blockhash | u8 instructions | u8 addresses | addresses |
//   config values | per instruction (u8 program, u8 accounts, u16 data length) | per instruction (accounts, data)
// The compute budget lives in the config values (the priority fee in whole lamports), so compute-budget instructions
// do nothing in it, and it has no lookup tables. It can be 4096 bytes long.
import { base58Decode, base58Encode } from './base58.js';
import { concat, readU32, readU64, u32le, u64le } from './bytes.js';

/** The most a legacy or v0 transaction can be. */
export const MAX_TX_BYTES = 1232;
/** The most a v1 transaction can be. */
export const MAX_V1_TX_BYTES = 4096;
/** The byte a v1 transaction (and its message) starts with. */
export const V1_PREFIX = 0x81;
/** The most bytes a transaction can be, by how it starts: a v1 one 4096, legacy and v0 1232. */
export const maxTxBytes = (bytes) => (bytes?.[0] === V1_PREFIX ? MAX_V1_TX_BYTES : MAX_TX_BYTES);

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

// v1's config mask: bits 0 and 1 together carry the priority fee (a u64 of lamports), bit 2 the compute unit limit,
// bit 3 the loaded accounts data size limit and bit 4 the heap size (a u32 each), in that order. Any other bit, or
// one priority bit without the other, makes the transaction invalid.
const V1_PRIORITY = 0b11;
const V1_UNITS = 0b100;
const V1_LOADED = 0b1000;
const V1_HEAP = 0b10000;
const V1_KNOWN = 0b11111;
/** The runtime's limits for a v1 message: signers, addresses, instructions, and the heap size it may ask for. */
export const V1_LIMITS = { signatures: 12, addresses: 64, instructions: 64, heapMin: 32 * 1024, heapMax: 256 * 1024 };

/** A v1 message, read from `start` (its 0x81) and checked the way the runtime sanitizes one. */
function readV1MessageAt(bytes, start, exact) {
  const r = reader(bytes, start);
  if (r.byte() !== V1_PREFIX) throw new Error("it isn't a v1 message");
  const [required, readonlySigned, readonlyUnsigned] = r.take(3);
  const mask = readU32(r.take(4), 0);
  if (mask & ~V1_KNOWN) throw new Error('its config sets fields Solana does not have');
  if ((mask & V1_PRIORITY) && (mask & V1_PRIORITY) !== V1_PRIORITY) throw new Error('its config sets half of the priority fee');
  const blockhash = base58Encode(r.take(32));
  const ixCount = r.byte();
  const keyCount = r.byte();
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push(base58Encode(r.take(32)));
  const config = { priorityFee: null, computeUnitLimit: null, loadedAccountsDataSizeLimit: null, heapSize: null };
  if (mask & V1_PRIORITY) config.priorityFee = readU64(r.take(8), 0);
  if (mask & V1_UNITS) config.computeUnitLimit = readU32(r.take(4), 0);
  if (mask & V1_LOADED) config.loadedAccountsDataSizeLimit = readU32(r.take(4), 0);
  if (mask & V1_HEAP) config.heapSize = readU32(r.take(4), 0);
  const heads = [];
  for (let i = 0; i < ixCount; i++) {
    const h = r.take(4);
    heads.push({ programIndex: h[0], count: h[1], length: h[2] | (h[3] << 8) });
  }
  const instructions = heads.map((h) => ({ programIndex: h.programIndex, accounts: [...r.take(h.count)], data: r.take(h.length) }));
  if (exact && r.at !== bytes.length) throw new Error('it has bytes left over at the end');
  if (!required) throw new Error('it has no fee payer');
  if (required > V1_LIMITS.signatures) throw new Error(`it asks for ${required} signatures, more than Solana allows`);
  if (ixCount > V1_LIMITS.instructions) throw new Error(`it has ${ixCount} instructions, more than Solana allows`);
  if (keyCount > V1_LIMITS.addresses) throw new Error(`it names ${keyCount} addresses, more than Solana allows`);
  if (keyCount < required + readonlyUnsigned || readonlySigned >= required) throw new Error('its header is impossible');
  if (new Set(keys).size !== keys.length) throw new Error('it names the same address twice');
  const heap = config.heapSize;
  if (heap != null && (heap % 1024 || heap < V1_LIMITS.heapMin || heap > V1_LIMITS.heapMax)) throw new Error('its heap size is invalid');
  for (const ix of instructions) {
    // the fee payer can't be a program, and every account must be one it names
    if (ix.programIndex === 0 || ix.programIndex >= keyCount || ix.accounts.some((a) => a >= keyCount)) throw new Error('an instruction names an account the transaction does not have');
  }
  return { version: 1, required, readonlySigned, readonlyUnsigned, keys, blockhash, instructions, lookups: [], config, mask };
}

/** The message part (what a signature covers), read from position `start` (to the very end, unless `exact` is off). */
function readMessageAt(bytes, start, exact = true) {
  if (bytes[start] === V1_PREFIX) return readV1MessageAt(bytes, start, exact);
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

/** A v1 transaction: its message, then one 64-byte signature per required signer, at the tail. */
function readV1Tx(bytes) {
  if (bytes.length > MAX_V1_TX_BYTES) throw new Error(`it is ${bytes.length} bytes, more than the ${MAX_V1_TX_BYTES} a v1 transaction can be`);
  if (bytes.length < 2) throw new Error('it ends too early');
  const sigStart = bytes.length - 64 * bytes[1];
  if (sigStart < 2) throw new Error('it ends too early');
  const message = bytes.subarray(0, sigStart);
  const m = readV1MessageAt(message, 0, true);
  const signatures = [];
  for (let i = 0; i < m.required; i++) signatures.push(bytes.subarray(sigStart + 64 * i, sigStart + 64 * (i + 1)));
  return { bytes, size: bytes.length, signatures, sigStart, messageStart: 0, message, ...m };
}

/**
 * A legacy, v0 or v1 transaction, decoded. `message` is the signed part and `sigStart` where the first signature sits.
 * Throws on anything else (a newer version included: plum can't read it, so it never signs it).
 */
export function readTx(input) {
  const bytes = asBytes(input);
  if (!bytes.length) throw new Error('it is empty');
  if (bytes[0] === V1_PREFIX) return readV1Tx(bytes);
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

/** Compute-budget instructions a transaction carries (they do nothing in a v1 transaction). */
export const budgetInstructions = (t, programOf = (ix) => t.keys[ix.programIndex]) => t.instructions.filter((ix) => programOf(ix) === COMPUTE_BUDGET_PROGRAM);

/** The compute budget a transaction sets: { units, microLamports, priorityLamports } (a v1 transaction's from its
 * config, where the priority fee is whole lamports and an unset limit is 0; microLamports is null for it). */
export function computeBudgetOf(t, programOf = (ix) => t.keys[ix.programIndex]) {
  if (t.version === 1) return { units: t.config.computeUnitLimit ?? 0, microLamports: null, priorityLamports: t.config.priorityFee ?? 0n };
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
 * The accounts of a message built from instructions: [{ programId, keys: [{ pubkey, isSigner, isWritable }], data }].
 * The payer comes first; accounts are grouped signer+writable, signer, writable, read-only as the runtime expects.
 */
function accountsOf(payer, instructions) {
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
  return {
    keys,
    index: new Map(keys.map((k, i) => [k, i])),
    header: Uint8Array.of(group(true, true).length + group(true, false).length, group(true, false).length, group(false, false).length),
  };
}

/** A legacy message from instructions (see accountsOf). */
export function compileLegacy({ payer, blockhash, instructions }) {
  const { keys, index, header } = accountsOf(payer, instructions);
  const parts = [header, compactU16(keys.length), ...keys.map((k) => base58Decode32(k)), base58Decode32(blockhash), compactU16(instructions.length)];
  for (const ix of instructions) {
    parts.push(Uint8Array.of(index.get(ix.programId)), compactU16(ix.keys.length), Uint8Array.from(ix.keys.map((a) => index.get(a.pubkey))));
    parts.push(compactU16(ix.data.length), ix.data);
  }
  return concat(...parts);
}

/**
 * A v1 message from instructions (see accountsOf), with its compute budget in its config: { priorityFee (lamports),
 * computeUnitLimit, loadedAccountsDataSizeLimit, heapSize }, each left out when null. Read back before it's returned,
 * so it never holds what the runtime would refuse.
 */
export function compileV1({ payer, blockhash, instructions, config = {} }) {
  const { keys, index, header } = accountsOf(payer, instructions);
  if (keys.length > V1_LIMITS.addresses) throw new Error(`a v1 transaction can name ${V1_LIMITS.addresses} addresses, not ${keys.length}`);
  if (instructions.length > V1_LIMITS.instructions) throw new Error(`a v1 transaction can hold ${V1_LIMITS.instructions} instructions`);
  const set = (v) => v != null;
  const mask = (set(config.priorityFee) ? V1_PRIORITY : 0) | (set(config.computeUnitLimit) ? V1_UNITS : 0)
    | (set(config.loadedAccountsDataSizeLimit) ? V1_LOADED : 0) | (set(config.heapSize) ? V1_HEAP : 0);
  const parts = [Uint8Array.of(V1_PREFIX), header, u32le(mask), base58Decode32(blockhash), Uint8Array.of(instructions.length, keys.length), ...keys.map((k) => base58Decode32(k))];
  if (set(config.priorityFee)) parts.push(u64le(config.priorityFee));
  if (set(config.computeUnitLimit)) parts.push(u32le(config.computeUnitLimit));
  if (set(config.loadedAccountsDataSizeLimit)) parts.push(u32le(config.loadedAccountsDataSizeLimit));
  if (set(config.heapSize)) parts.push(u32le(config.heapSize));
  for (const ix of instructions) {
    if (ix.keys.length > 255 || ix.data.length > 0xffff) throw new Error('an instruction is too large for a v1 transaction');
    parts.push(Uint8Array.of(index.get(ix.programId), ix.keys.length, ix.data.length & 0xff, ix.data.length >> 8));
  }
  for (const ix of instructions) parts.push(Uint8Array.from(ix.keys.map((a) => index.get(a.pubkey))), ix.data);
  const message = concat(...parts);
  readV1MessageAt(message, 0, true);
  return message;
}

/** An unsigned transaction around a message: one empty signature slot per signer (in front for legacy and v0, at the
 * tail for v1). */
export function unsignedTx(message) {
  const m = readMessage(message);
  if (m.version === 1) return concat(message, new Uint8Array(64 * m.required));
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
