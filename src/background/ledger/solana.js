// The Ledger Solana app (CLA 0xE0): its settings, an address (an ed25519 public key) for a path, a transaction's
// message signed after you check it on the device, and off-chain messages. Long payloads go in 255-byte pieces: P2 has
// 0x02 ("more to come") on every piece but the last, and 0x01 ("extends the last") on every piece but the first.
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '../../shared/base58.js';
import { concat, readUtf8, utf8 } from '../../shared/bytes.js';
import { LedgerError, atLeast, pathBytes, send } from './apdu.js';

export const APP = 'Solana';
const CLA = 0xe0;
const INS = { config: 0x04, pubkey: 0x05, sign: 0x06, offchain: 0x07 };
const P2_EXTEND = 0x01;
const P2_MORE = 0x02;
const OWN = {
  0x6808: ['blind-sign', "your Ledger's Solana app needs blind signing to sign this: turn it on in the app's settings, then try again"],
  0x6982: ['rejected', 'you turned it down on your Ledger'],
  0x6a80: ['refused', "your Ledger's Solana app can't read this"],
  0x6a81: ['refused', "your Ledger's Solana app can't read this message"],
  0x6a82: ['refused', "your Ledger's Solana app can't read this message"],
  0x6a83: ['too-large', 'this is too large for your Ledger to take'],
};
const opts = { app: APP, own: OWN };

/** The app's settings: { blindSigning, version }. */
export async function config(link) {
  const { data } = await send(link, CLA, INS.config, 0x00, 0x00, undefined, opts);
  if (data.length < 5) throw new LedgerError('error', "your Ledger's Solana app answered with settings plum can't read");
  return { blindSigning: data[0] === 1, version: `${data[2]}.${data[3]}.${data[4]}` };
}

/** The address at a path (shown on the device too, when `display`): base58, checked to be a real ed25519 key. */
export async function address(link, path, { display = false } = {}) {
  const { data } = await send(link, CLA, INS.pubkey, display ? 0x01 : 0x00, 0x00, pathBytes(path), opts);
  if (data.length !== 32) throw new LedgerError('mismatch', 'your Ledger answered with a Solana address that has the wrong length');
  try { ed25519.Point.fromBytes(data); } catch { throw new LedgerError('mismatch', "your Ledger answered with a Solana address that isn't one"); }
  return base58Encode(data);
}

/** Send `payload` in 255-byte pieces; returns the last piece's answer. */
async function sendLong(link, ins, payload) {
  let p2 = 0, at = 0;
  while (payload.length - at > 255) {
    await send(link, CLA, ins, 0x01, p2 | P2_MORE, payload.subarray(at, at + 255), opts);
    at += 255;
    p2 |= P2_EXTEND;
  }
  return (await send(link, CLA, ins, 0x01, p2, payload.subarray(at), opts)).data;
}

/** A transaction's message (legacy or v0) signed by the key at `path`, after you check it on the device. */
export async function signTransaction(link, path, message) {
  if (message[0] & 0x80 && message[0] !== 0x80) throw new LedgerError('refused', `your Ledger's Solana app reads legacy and v0 transactions only, and this is a v${message[0] & 0x7f}`);
  const sig = await sendLong(link, INS.sign, concat(Uint8Array.of(1), pathBytes(path), message));
  if (sig.length !== 64) throw new LedgerError('mismatch', 'your Ledger answered with a signature that has the wrong length');
  return sig;
}

/* ------------------------------------------------------------ off-chain messages */

/** Solana's off-chain message domain: what every off-chain message starts with, so it can never be a transaction. */
export const OFFCHAIN_DOMAIN = concat(Uint8Array.of(0xff), utf8('solana offchain'));
/** The most a Ledger takes for a whole off-chain message, header included (a transaction's size). */
export const OFFCHAIN_LEDGER_MAX = 1232;

/**
 * A message wrapped as an off-chain message (version 0), as the Ledger app reads it today: the domain, version 0, an
 * empty application domain (32 zero bytes), its format (0: printable ASCII, 1: other UTF-8), one signer (its public
 * key), the message's length (2 bytes, little-endian), then the message. With `legacy`, the shorter header older apps
 * and the Solana CLI write: the domain, version 0, the format, the length, the message. Throws when a Ledger can't
 * take it.
 */
export function offchainMessage(bytes, signer, { legacy = false } = {}) {
  if (readUtf8(bytes) == null) throw new LedgerError('refused', "a Ledger signs Solana messages only when they're text, and this one isn't");
  const format = bytes.every((b) => b >= 0x20 && b <= 0x7e) ? 0 : 1;
  const len = Uint8Array.of(bytes.length & 0xff, bytes.length >> 8);
  const out = legacy
    ? concat(OFFCHAIN_DOMAIN, Uint8Array.of(0, format), len, bytes)
    : concat(OFFCHAIN_DOMAIN, Uint8Array.of(0), new Uint8Array(32), Uint8Array.of(format, 1), signer, len, bytes);
  if (out.length > OFFCHAIN_LEDGER_MAX) throw new LedgerError('too-large', `a Ledger signs Solana messages of about ${OFFCHAIN_LEDGER_MAX - (out.length - bytes.length)} bytes at most; this one is ${bytes.length}`);
  return out;
}

/**
 * A message signed by the key at `path` as an off-chain message: { signature, signed } (`signed` is the wrapped message,
 * which is what the signature is over). Text that isn't plain ASCII is shown as a hash on the device, and the app then
 * wants blind signing on. An app that doesn't read today's header gets the older one.
 */
export async function signOffchain(link, path, bytes, signer, { version = null } = {}) {
  if (version && !atLeast(version, '1.3.0')) throw new LedgerError('old-app', 'the Solana app on your Ledger is too old to sign messages: update it with Ledger Live (My Ledger)');
  const attempt = async (legacy) => {
    const signed = offchainMessage(bytes, signer, { legacy });
    const signature = await sendLong(link, INS.offchain, concat(Uint8Array.of(1), pathBytes(path), signed));
    if (signature.length !== 64) throw new LedgerError('mismatch', 'your Ledger answered with a signature that has the wrong length');
    return { signature, signed };
  };
  try { return await attempt(false); } catch (e) {
    if (e.sw !== 0x6a81) throw e;
    return attempt(true);
  }
}
