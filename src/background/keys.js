// Keys: recovery phrases (BIP-39), the wallets they hold on Solana, Ethereum and Bitcoin, private keys pasted in, and
// signing. Everything here runs in the background only: no other part of plum, and no web page, ever holds a secret.
//
// One recovery phrase is an account; wallet n of it is the same index on every chain, on the paths Phantom uses (so a
// phrase brought from Phantom shows the same wallets, with the same addresses):
//   Solana    m/44'/501'/n'/0'   SLIP-0010 ed25519 (Phantom, Solflare, Backpack)
//   Ethereum  m/44'/60'/0'/0/n   BIP-32 secp256k1 (Phantom, MetaMask, Rabby, Trust)
//   Bitcoin   m/84'/0'/0'/0/n    BIP-84 native segwit, bc1q... (Phantom; a BIP-84 wallet's receive addresses)
// Phantom's older grouping (bip44: Solana m/44'/501'/n', Ethereum m/44'/60'/1'/0/n) and the Solana CLI's no-path key
// are found on import when they've been used.
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createBase58check, bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { base58Decode, base58Encode } from '../shared/base58.js';
import { concat, equal, hex, utf8, wipe } from '../shared/bytes.js';

export const WORDS = wordlist;
export const CHAINS = ['sol', 'eth', 'btc'];

/** A fresh phrase: 12 words (128 bits) or 24 (256 bits), from the browser's CSPRNG (crypto.getRandomValues). */
export const newMnemonic = (words = 12) => generateMnemonic(wordlist, words === 24 ? 256 : 128);

/** A phrase as typed (any spacing, any case) in the one form BIP-39 hashes. */
export const normalizeMnemonic = (s) => String(s).normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');

export const isMnemonic = (s) => validateMnemonic(normalizeMnemonic(s), wordlist);

export const seedOf = (mnemonic) => mnemonicToSeedSync(normalizeMnemonic(mnemonic), '');

/* ------------------------------------------------------------ paths */

/**
 * The ways a phrase becomes wallets. `bip44change` is plum's own (wallet n is index n on every chain); the others are
 * read only when a phrase from another wallet has used them.
 */
export const SCHEMES = {
  bip44change: { sol: (n) => `m/44'/501'/${n}'/0'`, eth: (n) => `m/44'/60'/0'/0/${n}`, btc: (n) => `m/84'/0'/0'/0/${n}` },
  bip44: { sol: (n) => `m/44'/501'/${n}'`, eth: (n) => `m/44'/60'/1'/0/${n}` },
  cli: { sol: () => null },
};

/** Is this one of plum's derivations? (Own names only: "toString" is not a scheme.) */
export const isScheme = (scheme) => typeof scheme === 'string' && Object.hasOwn(SCHEMES, scheme);

/** The paths of wallet n of a scheme: { sol, eth?, btc? } (a null path is the cli's no-path key). */
export function schemePaths(scheme, n) {
  if (!isScheme(scheme)) throw new Error('unknown derivation');
  return Object.fromEntries(Object.entries(SCHEMES[scheme]).map(([chain, f]) => [chain, f(n)]));
}

// the paths plum will derive: these patterns only, so a tampered wallet list can't make plum sign with some other key
const PATH_RE = {
  sol: /^m\/44'\/501'\/\d{1,9}'(\/0')?$/,
  eth: /^m\/44'\/60'\/[01]'\/0\/\d{1,9}$/,
  btc: /^m\/84'\/0'\/0'\/0\/\d{1,9}$/,
};
export const validPath = (chain, path) => (chain === 'sol' && path === null) || (typeof path === 'string' && Object.hasOwn(PATH_RE, chain) && PATH_RE[chain].test(path));

/** A path's numbers: "m/44'/501'/0'/0'" -> [44, 501, 0, 0] (Solana's are all hardened). */
export function solPathParts(path) {
  if (!PATH_RE.sol.test(path)) throw new Error('that Solana path is not one plum uses');
  return path.slice(2).split('/').map((p) => Number.parseInt(p, 10));
}

/** "cli (no path)" for the Solana CLI's key, the path itself otherwise. */
export const pathText = (path) => path ?? 'cli (no path)';

/* ------------------------------------------------------------ Solana: SLIP-0010 ed25519 */

const HARDENED = 0x80000000;

/** SLIP-0010 for ed25519 (hardened steps only): the 32-byte secret at `path` under a BIP-39 seed. */
export function slip10(seed, path) {
  let I = hmac(sha512, utf8('ed25519 seed'), seed);
  let key = I.slice(0, 32), chain = I.slice(32);
  for (const step of path) {
    const index = new Uint8Array(4);
    new DataView(index.buffer).setUint32(0, (step | HARDENED) >>> 0, false);
    const next = hmac(sha512, chain, concat(Uint8Array.of(0), key, index));
    wipe(I, key, chain);
    I = next;
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  wipe(I, chain);
  return key;
}

/* ------------------------------------------------------------ Ethereum and Bitcoin: BIP-32 secp256k1 */

function bip32(seed, path) {
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(path);
  const key = node.privateKey.slice();
  node.wipePrivateData();
  root.wipePrivateData();
  return key;
}

/** The secret for one chain of a wallet: Solana's 32-byte ed25519 seed, or a 32-byte secp256k1 key. */
export function secretAt(seed, chain, path) {
  if (!validPath(chain, path)) throw new Error(`plum doesn't derive ${chain} keys on ${path}`);
  if (chain === 'sol') return path === null ? seed.slice(0, 32) : slip10(seed, solPathParts(path));
  return bip32(seed, path);
}

/* ------------------------------------------------------------ addresses */

const N = secp256k1.Point.CURVE().n;

export const solPublicKey = (secret) => ed25519.getPublicKey(secret);

/** An Ethereum address in its checksummed form (EIP-55): mixed case that catches typos. */
export function checksumEth(addr) {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  const h = hex(keccak_256(utf8(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += Number.parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export function ethAddressOfPublicKey(pub) {
  const full = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  return checksumEth(hex(keccak_256(full.subarray(1)).subarray(12)));
}

export const hash160 = (bytes) => ripemd160(sha256(bytes));

/** A native segwit (P2WPKH) address for a compressed public key: bc1q... */
export const btcAddressOfPublicKey = (pub) => bech32.encode('bc', [0, ...bech32.toWords(hash160(pub))]);

/** The public address a chain's secret opens. */
export function addressOf(chain, secret) {
  if (chain === 'sol') return base58Encode(ed25519.getPublicKey(secret));
  const pub = secp256k1.getPublicKey(secret, true);
  return chain === 'eth' ? ethAddressOfPublicKey(pub) : btcAddressOfPublicKey(pub);
}

export const btcPublicKey = (secret) => secp256k1.getPublicKey(secret, true);

/* ------------------------------------------------------------ signing */

/** Solana: an ed25519 signature over the message bytes. */
export const signSol = (message, secret) => ed25519.sign(message, secret);
export const verifySol = (signature, message, publicKey) => {
  try { return ed25519.verify(signature, message, publicKey); } catch { return false; }
};

/** Ethereum: a signature over a 32-byte digest, as { r, s, yParity } (low s, RFC 6979 deterministic). */
export function signEthDigest(digest, secret) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('an Ethereum signature is over a 32-byte hash');
  const sig = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
  return { yParity: sig[0], r: sig.slice(1, 33), s: sig.slice(33, 65) };
}

/** Bitcoin: a DER signature (low s) over a 32-byte sighash. */
export function signBtcDigest(digest, secret) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('a Bitcoin signature is over a 32-byte hash');
  return secp256k1.sign(digest, secret, { prehash: false, format: 'der' });
}

/* ------------------------------------------------------------ private keys pasted in */

const b58check = createBase58check(sha256);

/** Which chain a pasted private key is for, from its shape alone: { chain, secret } (32 bytes). */
export function parsePrivateKey(input) {
  const s = String(input).trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return { chain: 'eth', secret: secpSecret(Uint8Array.from(s.replace(/^0x/, '').match(/../g), (b) => Number.parseInt(b, 16))) };
  if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) return { chain: 'btc', secret: parseWif(s) };
  return { chain: 'sol', secret: parseSolKey(s) };
}

function secpSecret(bytes) {
  const k = BigInt(`0x${hex(bytes) || '0'}`);
  if (k <= 0n || k >= N) { wipe(bytes); throw new Error("that isn't a key: it's outside the range secp256k1 keys live in"); }
  return bytes;
}

/** A Bitcoin key in Wallet Import Format: mainnet, compressed (what every native segwit wallet exports). */
function parseWif(s) {
  let raw;
  try { raw = b58check.decode(s); } catch { throw new Error("that isn't a key: its checksum doesn't match (check you copied all of it)"); }
  if (raw[0] === 0xef) { wipe(raw); throw new Error("that's a testnet Bitcoin key: plum is on Bitcoin's main network"); }
  if (raw[0] !== 0x80) { wipe(raw); throw new Error("that isn't a Bitcoin private key"); }
  if (raw.length === 33) { wipe(raw); throw new Error("that's an old uncompressed Bitcoin key (it starts with 5): plum's bc1q addresses need a compressed one (K or L)"); }
  if (raw.length !== 34 || raw[33] !== 1) { wipe(raw); throw new Error("that isn't a Bitcoin private key"); }
  const secret = raw.slice(1, 33);
  wipe(raw);
  return secpSecret(secret);
}

/**
 * A Solana key as people paste it: base58 (64 bytes as Phantom exports it, or a 32-byte secret) or a JSON array of 64
 * numbers (a Solana CLI keypair file). Returns the 32-byte secret; a 64-byte key must carry its own public key.
 */
function parseSolKey(s) {
  let bytes;
  if (s.startsWith('[')) {
    let arr;
    try { arr = JSON.parse(s); } catch { throw new Error("that isn't a key: the list doesn't read"); }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("that isn't a key: it should be a list of numbers from 0 to 255");
    bytes = Uint8Array.from(arr);
  } else {
    try { bytes = base58Decode(s); } catch { throw new Error("that isn't a key: paste a Solana key (base58 or a list of numbers), an Ethereum key (64 hex characters) or a Bitcoin key (WIF, K... or L...)"); }
  }
  if (bytes.length === 64) {
    const secret = bytes.slice(0, 32);
    if (!equal(ed25519.getPublicKey(secret), bytes.subarray(32))) {
      wipe(bytes, secret);
      throw new Error("that key doesn't match its own public half: check you copied all of it");
    }
    wipe(bytes);
    return secret;
  }
  if (bytes.length === 32) return bytes;
  wipe(bytes);
  throw new Error(`that isn't a key: it is ${bytes.length} bytes, and a Solana key is 64 (or 32)`);
}

/** A secret as its chain's wallets export it: Solana base58 (secret + public key, as Phantom), Ethereum 0x hex,
 * Bitcoin WIF (mainnet, compressed). */
export function exportPrivateKey(chain, secret) {
  if (chain === 'sol') {
    const full = concat(secret, ed25519.getPublicKey(secret));
    const out = base58Encode(full);
    wipe(full);
    return out;
  }
  if (chain === 'eth') return `0x${hex(secret)}`;
  const raw = concat(Uint8Array.of(0x80), secret, Uint8Array.of(1));
  const out = b58check.encode(raw);
  wipe(raw);
  return out;
}
