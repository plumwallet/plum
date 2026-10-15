// Ethereum (mainnet only): transactions (EIP-1559), signed messages (EIP-191) and typed data (EIP-712) written from
// bytes here, with nothing but keccak and secp256k1; balances, tokens and history read from public RPCs and Blockscout.
// Like the Solana side, nothing a provider or a site says is trusted: amounts are read back from what plum builds, and
// a transaction's sender is recovered from its own signature before it goes out.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concat, hex, utf8 } from '../shared/bytes.js';
import { cleanLine, hasHidden } from '../shared/text.js';
import { checksumEth, ethAddressOfPublicKey } from './keys.js';
import { NetError, failover, getJson, pool, request } from './net.js';

export const CHAIN_ID = 1;
export const CHAIN_HEX = '0x1';
/** Public RPCs with CORS, batching and eth_simulateV1, tried in turn. */
export const PUBLIC_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'];
/** Sends go to MEV Blocker first: a private route to block builders, so nobody sees a transaction early and trades
 * in front of it; then the public ones. The same signed bytes everywhere, so a second send can't double-spend. */
const SEND_RPCS = ['https://rpc.mevblocker.io', ...PUBLIC_RPCS];
const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
export const EXPLORER = 'https://etherscan.io';
/** Where eth_simulateV1's traced ETH transfers come from (they're logged as if this address were a token). */
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const APPROVAL_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
/** Permit2's own Approval(owner, token, spender, amount, expiration): spending rights inside Permit2, over tokens most
 * wallets already approved to it without limit. */
const PERMIT2_APPROVAL_TOPIC = '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b';
const MAX_UINT = (1n << 256n) - 1n;

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});

/* ------------------------------------------------------------ hex and numbers */

export const toHex = (bytes) => `0x${hex(bytes)}`;
export function fromHex(s) {
  if (typeof s !== 'string') throw fail('expected hex');
  const h = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw fail('expected hex');
  return Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}
/** A JSON-RPC quantity: 0x-hex without leading zeros. */
export const qty = (n) => `0x${BigInt(n).toString(16)}`;
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
const bytesToBig = (b) => (b.length ? BigInt(toHex(b)) : 0n);
/** A big-endian integer with no leading zeros (zero is no bytes at all), as RLP wants it. */
function intBytes(n) {
  const v = big(n);
  if (v < 0n) throw fail('negative number');
  if (v === 0n) return new Uint8Array(0);
  let s = v.toString(16);
  if (s.length % 2) s = `0${s}`;
  return fromHex(s);
}
const word = (n) => { const out = new Uint8Array(32); const b = intBytes(n); out.set(b, 32 - b.length); return out; };

/** An amount in an asset's smallest units as a decimal string, never rounded up. */
export const units = (raw, decimals) => {
  const v = big(raw), base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${v / base}${frac ? `.${frac}` : ''}`;
};

/* ------------------------------------------------------------ addresses */

/** An address as plum keeps it (checksummed); a mixed-case one whose checksum is wrong is a typo, refused. */
export function checkAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.trim())) throw fail("that isn't an Ethereum address: it's 0x and 40 characters");
  const s = a.trim();
  const body = s.slice(2);
  const sum = checksumEth(s);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && sum !== s) throw fail("that Ethereum address has a typo: its capital letters don't match its checksum");
  return sum;
}
export const isEthAddress = (a) => { try { checkAddress(a); return true; } catch { return false; } };
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/* ------------------------------------------------------------ RLP and transactions */

function rlpLength(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = intBytes(len);
  return concat(Uint8Array.of(offset + 55 + l.length), l);
}
export function rlp(item) {
  if (item instanceof Uint8Array) return item.length === 1 && item[0] < 0x80 ? item : concat(rlpLength(item.length, 0x80), item);
  const body = concat(...item.map(rlp));
  return concat(rlpLength(body.length, 0xc0), body);
}

/**
 * An EIP-1559 transaction on mainnet: { nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data } (numbers as
 * bigints, `to` a 0x address, `data` 0x hex).
 */
function txFields(tx) {
  return [intBytes(CHAIN_ID), intBytes(tx.nonce), intBytes(tx.maxPriorityFeePerGas), intBytes(tx.maxFeePerGas), intBytes(tx.gas),
    tx.to ? fromHex(tx.to) : new Uint8Array(0), intBytes(tx.value ?? 0n), fromHex(tx.data ?? '0x'), []];
}
export const unsignedTx = (tx) => concat(Uint8Array.of(2), rlp(txFields(tx)));
/** What the key signs: keccak of the typed transaction. */
export const txDigest = (tx) => keccak_256(unsignedTx(tx));
export const signedTx = (tx, sig) => concat(Uint8Array.of(2), rlp([...txFields(tx), intBytes(sig.yParity), intBytes(bytesToBig(sig.r)), intBytes(bytesToBig(sig.s))]));
export const txHash = (raw) => toHex(keccak_256(raw));

/** The address a signature over a digest came from. */
export function signerOf(digest, { r, s, yParity }) {
  const sig = secp256k1.Signature.fromBytes(concat(Uint8Array.of(yParity), r, s), 'recovered');
  return ethAddressOfPublicKey(sig.recoverPublicKey(digest).toBytes(false));
}

/** A signature as dApps want it: r, s, then v (27 or 28), in hex. */
export const sigHex = ({ r, s, yParity }) => toHex(concat(r, s, Uint8Array.of(27 + yParity)));

/* ------------------------------------------------------------ messages (EIP-191) and typed data (EIP-712) */

/** What personal_sign signs: the message behind Ethereum's prefix, so it can never be a transaction. */
export const personalDigest = (message) => keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${message.length}`), message));

const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']];

/** Typed data as a site sends it (a JSON string or an object), checked for shape: { types, primaryType, domain, message }. */
export function parseTypedData(input) {
  let td = input;
  if (typeof td === 'string') {
    if (td.length > 64 * 1024) throw fail('that typed data is too large to show');
    try { td = JSON.parse(td); } catch { throw fail("that typed data isn't JSON"); }
  }
  if (!td || typeof td !== 'object' || !td.types || typeof td.types !== 'object' || typeof td.primaryType !== 'string' || typeof td.message !== 'object') throw fail('that typed data is malformed');
  // own names only: a type called "toString" or "constructor" is just unknown, never something inherited
  const types = Object.assign(Object.create(null), td.types);
  const domain = td.domain && typeof td.domain === 'object' ? td.domain : {};
  if (!types.EIP712Domain) types.EIP712Domain = DOMAIN_FIELDS.filter(([k]) => domain[k] != null).map(([name, type]) => ({ name, type }));
  for (const [name, fields] of Object.entries(types)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || !Array.isArray(fields)) throw fail('that typed data is malformed');
    for (const f of fields) if (!f || typeof f.name !== 'string' || typeof f.type !== 'string') throw fail('that typed data is malformed');
  }
  if (!types[td.primaryType]) throw fail(`that typed data has no type ${String(td.primaryType).slice(0, 40)}`);
  return { types, primaryType: td.primaryType, domain, message: td.message };
}

const baseType = (t) => t.replace(/(\[\d*\])+$/, '');

function dependencies(type, types, found = []) {
  const t = baseType(type);
  if (found.includes(t) || !types[t]) return found;
  found.push(t);
  for (const f of types[t]) dependencies(f.type, types, found);
  return found;
}
function encodeType(primary, types) {
  const [first, ...rest] = dependencies(primary, types);
  return [first, ...rest.sort()].map((n) => `${n}(${types[n].map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}
const typeHash = (primary, types) => keccak_256(utf8(encodeType(primary, types)));

function intValue(v, bits, signed) {
  let n;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) n = BigInt(v.trim());
  else if (typeof v === 'string' && /^-?0x[0-9a-fA-F]+$/.test(v.trim())) n = v.trim().startsWith('-') ? -BigInt(v.trim().slice(1)) : BigInt(v.trim());
  else throw fail(`a number in the typed data isn't one (${String(v).slice(0, 30)})`);
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  if (n > max || n < min) throw fail('a number in the typed data is out of range for its type');
  return n < 0n ? (1n << 256n) + n : n;
}

function encodeValue(type, value, types, depth) {
  if (depth > 16) throw fail('that typed data nests too deeply');
  if (types[type]) return hashStruct(type, value, types, depth + 1);
  if (type.endsWith(']')) {
    const inner = type.slice(0, type.lastIndexOf('['));
    const n = type.slice(type.lastIndexOf('[') + 1, -1);
    if (!Array.isArray(value) || (n && value.length !== Number(n))) throw fail(`a list in the typed data doesn't match its type ${type}`);
    if (value.length > 1000) throw fail('a list in the typed data is too long');
    return keccak_256(concat(...value.map((v) => encodeValue(inner, v, types, depth + 1))));
  }
  // a list or an object would be signed as text other than what's shown ({} as "[object Object]"), so it's refused
  if (type === 'string') {
    if (value !== null && typeof value === 'object') throw fail("a text in the typed data isn't text");
    return keccak_256(utf8(String(value)));
  }
  // hex, or a list of byte values: anything else (a number, an object, 256) would be signed as other bytes than shown
  if (type === 'bytes') {
    if (typeof value === 'string') return keccak_256(fromHex(value));
    if (value instanceof Uint8Array || (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))) return keccak_256(Uint8Array.from(value));
    throw fail('a bytes value in the typed data is malformed');
  }
  if (type === 'bool') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false' && value !== 0 && value !== 1) throw fail('a yes/no in the typed data is neither');
    return word(value === true || value === 'true' || value === 1 ? 1n : 0n);
  }
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw fail('an address in the typed data is malformed');
    return word(BigInt(value));
  }
  let m = /^bytes(\d+)$/.exec(type);
  if (m) {
    const n = Number(m[1]);
    const b = fromHex(String(value));
    if (n < 1 || n > 32 || b.length !== n) throw fail(`a ${type} in the typed data is the wrong length`);
    const out = new Uint8Array(32);
    out.set(b);
    return out;
  }
  m = /^(u?)int(\d*)$/.exec(type);
  if (m) {
    const bits = m[2] ? Number(m[2]) : 256;
    if (bits < 8 || bits > 256 || bits % 8) throw fail(`the typed data has a bad type ${type}`);
    return word(intValue(value, bits, m[1] !== 'u'));
  }
  throw fail(`the typed data has a type plum doesn't know: ${type.slice(0, 40)}`);
}

function hashStruct(type, data, types, depth = 0) {
  if (!data || typeof data !== 'object') throw fail(`the typed data's ${type} is missing`);
  const parts = [typeHash(type, types)];
  for (const f of types[type]) {
    if (data[f.name] === undefined) throw fail(`the typed data's ${type} has no ${f.name}`);
    parts.push(encodeValue(f.type, data[f.name], types, depth));
  }
  return keccak_256(concat(...parts));
}

/** What eth_signTypedData_v4 signs: keccak(0x19 0x01 | domain separator | the message's struct hash). */
export function typedDigest(td) {
  const domainSeparator = hashStruct('EIP712Domain', td.domain, td.types);
  if (td.primaryType === 'EIP712Domain') return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSeparator));
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSeparator, hashStruct(td.primaryType, td.message, td.types)));
}

/** Typed data as lines to read, depth-first: { lines: [{ path, value }] (at most `max`), more: how many didn't fit,
 * cut: how many shown values are shorter than what's signed (cut at 120 characters, or with hidden characters taken
 * out) }. Nothing that is signed goes unshown without being counted in `more` or `cut`. */
export function typedLines(td, max = 300) {
  const lines = [];
  let more = 0, cut = 0;
  const walk = (type, value, path, depth = 0) => {
    // the digest goes one level deeper than this walk starts counting: whatever is past it is counted, never dropped
    if (depth > 16) { more++; return; }
    const t = baseType(type);
    if (type.endsWith(']') && Array.isArray(value)) { value.forEach((v, i) => walk(type.slice(0, type.lastIndexOf('[')), v, `${path}[${i}]`, depth + 1)); return; }
    if (Object.hasOwn(td.types, t) && value && typeof value === 'object') { for (const f of td.types[t]) walk(f.type, value[f.name], path ? `${path}.${f.name}` : f.name, depth + 1); return; }
    if (lines.length >= max) { more++; return; }
    const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if ([...raw].length > 120 || hasHidden(raw)) cut++;
    lines.push({ path: cleanLine(path, 200), value: cleanLine(raw, 120) });
  };
  walk(td.primaryType, td.message, '');
  return { lines, more, cut };
}

/** What typed data would let someone do: dangers named in words. */
export function typedWarnings(td, { owner }) {
  const w = [];
  const d = td.domain ?? {};
  const m = td.message ?? {};
  const chain = d.chainId != null ? (() => { try { return intValue(d.chainId, 256, false); } catch { return null; } })() : null;
  if (chain != null && chain !== 1n) w.push({ level: 'danger', text: `this is made for another chain (id ${chain}), not Ethereum: a site asking you to sign for one chain while you're on another is a classic trick` });
  const who = (a) => (typeof a === 'string' ? a : '?');
  const name = cleanLine(String(d.name ?? 'a token'), 40);
  const p = td.primaryType;
  if (p === 'Permit' && m.spender != null) {
    const unlimited = (() => { try { return intValue(m.value, 256, false) >= MAX_UINT / 2n; } catch { return false; } })();
    w.push({ level: 'danger', text: `a permit: signing lets ${who(m.spender)} spend ${unlimited ? 'all of your' : 'your'} ${name} without asking you again. Drainers ask for exactly this.` });
  } else if (/^Permit(Single|Batch)$/.test(p)) {
    w.push({ level: 'danger', text: `a Permit2 allowance: signing lets ${who(m.spender)} move your tokens without asking you again. Only sign on sites you trust completely.` });
  } else if (/^Permit(Batch)?(Witness)?TransferFrom$/.test(p)) {
    w.push({ level: 'danger', text: `a Permit2 transfer: signing lets ${who(m.spender)} take the tokens it names from your wallet.` });
  } else if (p === 'OrderComponents' || p === 'Order' || p === 'BulkOrder') {
    w.push({ level: 'danger', text: 'a marketplace order: once signed, anyone can fill it and take what it lists for the price it names. Check every item and price.' });
  }
  const at = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null);
  if (at(m.owner) && owner && !sameAddress(m.owner, owner)) w.push({ level: 'warn', text: `it names ${m.owner} as the owner, not your wallet` });
  return w;
}

/* ------------------------------------------------------------ what a contract call does (for previews) */

const SELECTORS = {
  a9059cbb: { name: 'transfer', args: ['address', 'uint256'] },
  '095ea7b3': { name: 'approve', args: ['address', 'uint256'] },
  '23b872dd': { name: 'transferFrom', args: ['address', 'address', 'uint256'] },
  '39509351': { name: 'increaseAllowance', args: ['address', 'uint256'] },
  a22cb465: { name: 'setApprovalForAll', args: ['address', 'bool'] },
  '42842e0e': { name: 'safeTransferFrom', args: ['address', 'address', 'uint256'] },
  '87517c45': { name: 'approve (Permit2)', args: ['address', 'address', 'uint160', 'uint48'] },
  d0e30db0: { name: 'deposit', args: [] },
  '2e1a7d4d': { name: 'withdraw', args: ['uint256'] },
};

/** A call's function and its simple arguments, when plum knows it: { selector, name, args } or { selector } or null. */
export function decodeCall(data) {
  const d = typeof data === 'string' ? data.toLowerCase() : '0x';
  if (d.length < 10) return null;
  const selector = d.slice(2, 10);
  const known = SELECTORS[selector];
  if (!known) return { selector };
  const body = d.slice(10);
  if (body.length < known.args.length * 64) return { selector, name: known.name };
  const args = known.args.map((t, i) => {
    const w = BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`);
    if (t === 'address') return checksumEth(`0x${w.toString(16).padStart(40, '0').slice(-40)}`);
    if (t === 'bool') return w !== 0n;
    return w;
  });
  return { selector, name: known.name, args };
}

/** ERC-20 transfer(to, amount) as call data. */
export const transferData = (to, amount) => `0xa9059cbb${hex(word(BigInt(to)))}${hex(word(amount))}`;

/* ------------------------------------------------------------ talking to the chain */

const rpcId = (() => { let n = 1; return () => n++; })();

/** One JSON-RPC call, asked of each RPC in turn: a provider that's down or rate limiting moves on, an error the
 * chain itself gave (a revert, a nonce too low) is the answer. */
export function ethRpc(urls, method, params = [], { timeout = 15_000 } = {}) {
  return failover(urls, async (url) => {
    const r = await request(url, { method: 'POST', body: { jsonrpc: '2.0', id: rpcId(), method, params }, timeout });
    if (r.status === 429 || r.status >= 500) throw new NetError(`the Ethereum RPC answered ${r.status}`);
    let j = null;
    try { j = JSON.parse(r.text); } catch { /* not json */ }
    if (!j) throw new NetError(`the Ethereum RPC answered ${r.status} with something that isn't JSON`);
    if (j.error) throw Object.assign(new Error(j.error.message || 'the Ethereum RPC returned an error'), { final: true, rpcCode: j.error.code, data: j.error.data });
    return j.result;
  });
}

/** Many addresses' ETH and sent-transaction counts, twenty addresses to a batched request (a recovery phrase's scan):
 * Map(address -> { wei, nonce }); an address a provider didn't answer for is left out (not known). */
export async function usageOf(urls, addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    const body = chunk.flatMap((a, j) => [
      { jsonrpc: '2.0', id: 2 * j, method: 'eth_getBalance', params: [a, 'latest'] },
      { jsonrpc: '2.0', id: 2 * j + 1, method: 'eth_getTransactionCount', params: [a, 'latest'] },
    ]);
    const answers = await failover(urls, async (url) => {
      const r = await request(url, { method: 'POST', body, timeout: 20_000 });
      if (r.status === 429 || r.status >= 500) throw new NetError(`the Ethereum RPC answered ${r.status}`);
      let j = null;
      try { j = JSON.parse(r.text); } catch { /* not json */ }
      if (!Array.isArray(j)) throw new NetError("the Ethereum RPC didn't answer the batch");
      return j;
    });
    const byId = new Map(answers.filter((x) => x && typeof x.id === 'number' && x.result != null).map((x) => [x.id, x.result]));
    chunk.forEach((a, j) => {
      try { if (byId.has(2 * j) && byId.has(2 * j + 1)) out.set(a, { wei: big(byId.get(2 * j)), nonce: big(byId.get(2 * j + 1)) }); } catch { /* malformed: not known */ }
    });
  }
  return out;
}

/** The fee to offer now: { base, tip, maxFee } in wei per gas. The tip is what recent blocks paid (their median),
 * kept between 0.01 and 3 gwei; the cap is twice the base fee plus the tip, so a few full blocks can't strand it. */
export async function feeQuote(urls) {
  const [block, history] = await Promise.all([
    ethRpc(urls, 'eth_getBlockByNumber', ['latest', false]),
    ethRpc(urls, 'eth_feeHistory', ['0x5', 'latest', [50]]).catch(() => null),
  ]);
  const base = big(block?.baseFeePerGas ?? 0);
  const tips = (history?.reward ?? []).map((r) => { try { return big(r[0]); } catch { return null; } }).filter((x) => x != null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tip = tips.length ? tips[Math.floor(tips.length / 2)] : 1_000_000_000n;
  if (tip < 10_000_000n) tip = 10_000_000n;
  if (tip > 3_000_000_000n) tip = 3_000_000_000n;
  return { base, tip, maxFee: base * 2n + tip };
}

/** A token's decimals, from the token contract itself. */
export async function tokenDecimals(urls, token) {
  const r = await ethRpc(urls, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
  const d = Number(BigInt(r && r !== '0x' ? r : '0x0'));
  if (!Number.isInteger(d) || d > 36) throw fail("that token doesn't say how many decimals it has");
  return d;
}

/** Name and ticker from Blockscout (shown as text, cleaned of hidden characters); nulls if it doesn't know. */
export async function tokenMeta(token) {
  try {
    const t = await getJson(`${BLOCKSCOUT}/tokens/${token}`, { timeout: 10_000 });
    return { symbol: cleanLine(String(t?.symbol ?? ''), 16) || null, name: cleanLine(String(t?.name ?? ''), 48) || null, price: Number(t?.exchange_rate) || null };
  } catch { return { symbol: null, name: null, price: null }; }
}

/** ETH and ERC-20 tokens an address holds. Tokens come from Blockscout: a token without a market price is shown as
 * unverified (anyone can call a token "USDC"), and ones Blockscout marks as scams are left out. */
export async function balances(urls, address, { hideZero = true } = {}) {
  const [wei, list] = await Promise.all([
    ethRpc(urls, 'eth_getBalance', [address, 'latest']).then(big),
    getJson(`${BLOCKSCOUT}/addresses/${address}/token-balances`, { timeout: 15_000 }).catch(() => []),
  ]);
  const tokens = [];
  for (const it of Array.isArray(list) ? list : []) {
    const t = it?.token;
    if (!t || t.type !== 'ERC-20' || typeof t.address_hash !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.address_hash)) continue;
    if (t.reputation === 'scam') continue;
    let raw;
    try { raw = BigInt(it.value); } catch { continue; }
    if (hideZero && raw === 0n) continue;
    const decimals = Number.parseInt(t.decimals ?? '', 10);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const price = Number(t.exchange_rate);
    const known = Number.isFinite(price) && price > 0;
    tokens.push({
      chain: 'eth', mint: checksumEth(t.address_hash), amount: raw.toString(), decimals,
      symbol: cleanLine(String(t.symbol ?? ''), 16) || null, name: cleanLine(String(t.name ?? ''), 48) || null,
      verified: known, price: known ? price : null, usd: known ? (Number(raw) / 10 ** decimals) * price : null, change24h: null,
    });
  }
  return { wei, tokens };
}

/** Recent transactions of an address (its own and the tokens it got), newest first. */
export async function activity(address, limit = 25) {
  const [txs, tts] = await Promise.all([
    getJson(`${BLOCKSCOUT}/addresses/${address}/transactions`, { timeout: 15_000 }),
    getJson(`${BLOCKSCOUT}/addresses/${address}/token-transfers?type=ERC-20`, { timeout: 15_000 }).catch(() => ({ items: [] })),
  ]);
  const seen = new Map();
  for (const t of txs?.items ?? []) {
    if (typeof t?.hash !== 'string') continue;
    seen.set(t.hash, { id: t.hash, time: Math.floor(Date.parse(t.timestamp) / 1000) || null, ok: t.status === 'ok' || t.result === 'success', pending: t.status == null && !t.block_number });
  }
  for (const t of tts?.items ?? []) {
    const h = t?.transaction_hash ?? t?.tx_hash;
    if (typeof h !== 'string' || seen.has(h)) continue;
    seen.set(h, { id: h, time: Math.floor(Date.parse(t.timestamp) / 1000) || null, ok: true, pending: false });
  }
  return [...seen.values()].sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity)).slice(0, limit)
    .map((x) => ({ ...x, explorer: `${EXPLORER}/tx/${x.id}` }));
}

/** Send signed bytes; returns the transaction hash. "Already known" from a second RPC means the first one took it. */
export async function sendRaw(raw, urls = SEND_RPCS) {
  const hash = txHash(raw);
  try {
    const got = await failover(urls, async (url) => ethRpc([url], 'eth_sendRawTransaction', [toHex(raw)]));
    if (typeof got === 'string' && got.toLowerCase() !== hash.toLowerCase()) throw fail('the RPC answered with a different transaction hash');
  } catch (e) {
    if (/already known|known transaction|already imported/i.test(e.message ?? '')) return hash;
    throw e;
  }
  return hash;
}

/** Has a transaction landed? 'pending', 'confirmed' or 'failed'. */
export async function txStatus(urls, hash) {
  const r = await ethRpc(urls, 'eth_getTransactionReceipt', [hash]);
  if (!r) return 'pending';
  return r.status === '0x1' ? 'confirmed' : 'failed';
}

/** The explorer page for a transaction. */
export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;

/**
 * What a transaction does to `owner`, by running it on the latest block (eth_simulateV1 with transfers traced): ETH and
 * token amounts in and out, approvals it gives, and whether it reverts. { ok, error, changes: [{ token, delta }],
 * approvals: [{ token, spender, all }], gasUsed } or null when no RPC can simulate.
 */
export async function simulate(urls, owner, call) {
  const tx = { from: owner, to: call.to ?? undefined, value: qty(call.value ?? 0n), data: call.data ?? '0x' };
  if (call.gas) tx.gas = qty(call.gas);
  // the fee it will really carry, on a block with the real base fee: a contract can't tell the simulation from the real
  // thing by tx.gasprice or block.basefee being 0
  if (call.fees) Object.assign(tx, { maxFeePerGas: qty(call.fees.maxFee), maxPriorityFeePerGas: qty(call.fees.tip) });
  const block = { calls: [tx], ...(call.fees ? { blockOverrides: { baseFeePerGas: qty(call.fees.base) } } : {}) };
  let res;
  try {
    res = await ethRpc(urls, 'eth_simulateV1', [{ blockStateCalls: [block], traceTransfers: true, validation: false }, 'latest'], { timeout: 20_000 });
  } catch (e) {
    // no RPC answered, or none can simulate: not known
    if (!e.final || /not found|not supported|does not exist|unknown method/i.test(e.message)) return null;
    // the chain itself turned it down (not enough ETH for it, say): that's the answer, it would fail
    return { ok: false, error: cleanLine(String(e.message || 'it fails'), 160), gasUsed: null, changes: [], approvals: [] };
  }
  const c = res?.[0]?.calls?.[0];
  if (!c) return null;
  const ok = c.status === '0x1';
  const deltas = new Map();
  const approvals = [];
  const me = owner.toLowerCase();
  let native = false; // did the RPC trace ETH at all?
  const add = (token, v) => deltas.set(token, (deltas.get(token) ?? 0n) + v);
  for (const log of c.logs ?? []) {
    const topics = (log.topics ?? []).map((t) => String(t).toLowerCase());
    const token = String(log.address ?? '').toLowerCase();
    const addrAt = (i) => (topics[i] ? `0x${topics[i].slice(-40)}` : null);
    if (topics[0] === TRANSFER_TOPIC && topics.length === 3) {
      let v;
      try { v = BigInt(log.data && log.data !== '0x' ? log.data : '0x0'); } catch { continue; }
      if (token === NATIVE) native = true;
      if (addrAt(1) === me) add(token, -v);
      if (addrAt(2) === me) add(token, v);
    } else if (topics[0] === TRANSFER_TOPIC && topics.length === 4) {
      // an NFT (ERC-721): its id is the third topic
      if (addrAt(1) === me) approvals.push({ token, nft: BigInt(topics[3]).toString(), out: true });
      if (addrAt(2) === me) approvals.push({ token, nft: BigInt(topics[3]).toString(), out: false });
    } else if (topics[0] === APPROVAL_TOPIC && addrAt(1) === me && topics.length === 3) {
      let v;
      try { v = BigInt(log.data && log.data !== '0x' ? log.data : '0x0'); } catch { v = 0n; }
      if (v > 0n) approvals.push({ token, spender: checksumEth(addrAt(2)), amount: v, unlimited: v >= MAX_UINT / 2n });
    } else if (topics[0] === APPROVAL_TOPIC && addrAt(1) === me && topics.length === 4) {
      // an NFT (ERC-721) approve(spender, id): that one item may be taken; spender 0 clears it
      if (BigInt(addrAt(2)) !== 0n) approvals.push({ token, spender: checksumEth(addrAt(2)), item: BigInt(topics[3]).toString() });
    } else if (topics[0] === PERMIT2_APPROVAL_TOPIC && addrAt(1) === me && topics.length === 4) {
      // Permit2.approve(token, spender, amount, expiration): the token is the second topic, the amount the first word
      let v;
      try { v = BigInt(`0x${String(log.data ?? '').slice(2, 66) || '0'}`); } catch { v = 0n; }
      if (v > 0n) approvals.push({ token: addrAt(2), spender: checksumEth(addrAt(3)), amount: v, unlimited: v >= 1n << 159n, permit2: true });
    } else if (topics[0] === APPROVAL_ALL_TOPIC && addrAt(1) === me) {
      const on = (() => { try { return BigInt(log.data) !== 0n; } catch { return false; } })();
      if (on) approvals.push({ token, spender: checksumEth(addrAt(2)), all: true });
    }
  }
  return {
    ok,
    error: ok ? null : cleanLine(String(c.error?.message ?? 'it reverts'), 160),
    gasUsed: c.gasUsed ? big(c.gasUsed) : null,
    changes: [...deltas].filter(([, v]) => v !== 0n).map(([token, delta]) => ({ token: token === NATIVE ? null : checksumEth(token), delta })),
    approvals,
    native,
  };
}

/** Names and decimals for the tokens a preview touches (Blockscout, then the contract), for showing amounts. */
export async function describeTokens(urls, tokens) {
  const out = new Map();
  await pool([...new Set(tokens)], 4, async (t) => {
    const meta = await tokenMeta(t);
    let decimals = null;
    try { decimals = await tokenDecimals(urls, t); } catch { /* an NFT, or not a token */ }
    out.set(t, { ...meta, decimals });
  });
  return out;
}

export const _test = { intBytes, word };
