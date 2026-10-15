// Talking to a Ledger: APDUs (the command format every Ledger app reads), the status words a device answers with, in
// plain words, and the commands every app shares (which app is open, open one, close it). A link is anything with
// `exchange(apdu) -> answer` (the answer is the reply's data followed by its two-byte status word): WebHID in the
// browser (hid.js), a test double or Speculos in tests.
import { concat, utf8 } from '../../shared/bytes.js';

export const LEDGER_VENDOR = 0x2c97;
export const SW_OK = 0x9000;

/**
 * What a device answer means for you, as one state the windows can draw:
 *   connect      no Ledger plugged in, or plum isn't allowed to use it yet
 *   locked       it's waiting for its PIN
 *   open-app     its dashboard is showing: the app plum needs isn't open
 *   wrong-app    another app is open
 *   not-installed  the app plum needs isn't on it
 *   old-app      the app is too old for what plum asks
 *   blind-sign   the app wants blind signing turned on in its settings before it signs this
 *   rejected     you turned it down on the device
 *   refused      the device (or plum, for the device) can't sign this kind of request
 *   cancelled    you stopped it in plum
 *   mismatch     the device answered with an address or signature that isn't this wallet's
 *   too-large    the request is bigger than the device can take
 *   busy         the device is already working on another request
 *   timeout      the device stopped answering
 *   unsupported  this browser can't talk to USB devices (Firefox has no WebHID)
 *   error        anything else (the status word is in the message)
 */
export class LedgerError extends Error {
  constructor(state, message, { sw = null, app = null } = {}) {
    super(message);
    this.state = state;
    this.sw = sw;
    this.app = app;
    this.code = `ledger-${state}`;
    // a device that wasn't ready can be tried again once it is; a no (on the device or in plum), or a request the
    // device can't take at all, can't
    this.retry = !['rejected', 'cancelled', 'refused', 'too-large'].includes(state);
  }
}

export const isLedgerError = (e) => e instanceof LedgerError || (typeof e?.code === 'string' && e.code.startsWith('ledger-'));

/** A command: CLA INS P1 P2, then the data's length (one byte) and the data. */
export function apdu(cla, ins, p1, p2, data = new Uint8Array(0)) {
  if (data.length > 255) throw new Error('an APDU carries 255 bytes at most');
  return concat(Uint8Array.of(cla, ins, p1, p2, data.length), data);
}

const HARD = 0x80000000;

/** A BIP-32 path's steps: "m/44'/501'/0'/0'" -> [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]. */
export function pathSteps(path) {
  if (typeof path !== 'string' || !/^m(\/\d{1,10}'?)+$/.test(path)) throw new Error(`that isn't a derivation path: ${String(path).slice(0, 40)}`);
  return path.slice(2).split('/').map((s) => {
    const n = Number.parseInt(s, 10);
    if (n >= HARD) throw new Error('a path step is out of range');
    return (s.endsWith("'") ? n + HARD : n) >>> 0;
  });
}

/** A path as Ledger apps read it: the number of steps (one byte), then each step as 4 bytes big-endian. */
export function pathBytes(path) {
  const steps = pathSteps(path);
  if (steps.length > 10) throw new Error('a path has 10 steps at most');
  const out = new Uint8Array(1 + 4 * steps.length);
  out[0] = steps.length;
  const v = new DataView(out.buffer);
  steps.forEach((s, i) => v.setUint32(1 + 4 * i, s, false));
  return out;
}

/** An answer split in two: { data, sw }. */
export function splitAnswer(answer) {
  if (!(answer instanceof Uint8Array) || answer.length < 2) throw new LedgerError('error', 'your Ledger answered with nothing plum can read');
  return { data: answer.subarray(0, answer.length - 2), sw: (answer[answer.length - 2] << 8) | answer[answer.length - 1] };
}

const hex4 = (sw) => `0x${sw.toString(16).padStart(4, '0')}`;

/** Status words every Ledger shares, in plain words. Apps have their own on top (each app's client passes them in). */
export function swError(sw, { app = null, own = {} } = {}) {
  if (own[sw]) return new LedgerError(own[sw][0], own[sw][1], { sw, app });
  const name = app ?? 'the app';
  if (sw === 0x5515 || sw === 0x5514) return new LedgerError('locked', 'your Ledger is locked: type its PIN on it', { sw, app });
  if (sw === 0x6985 || sw === 0x5501) return new LedgerError('rejected', 'you turned it down on your Ledger', { sw, app });
  if (sw === 0x6e00 || sw === 0x6e01 || sw === 0x6d00 || sw === 0x6d02 || sw === 0x6511 || sw === 0x6a15) {
    return new LedgerError('open-app', `open the ${name} app on your Ledger`, { sw, app });
  }
  if (sw === 0x6807) return new LedgerError('not-installed', `the ${name} app isn't on your Ledger: install it with Ledger Live (My Ledger)`, { sw, app });
  if (sw === 0x6a84 || sw === 0x6a85 || sw === 0x6700) return new LedgerError('too-large', 'this is too large for your Ledger to take', { sw, app });
  if (sw === 0x6b00 || sw === 0x6a86) return new LedgerError('old-app', `the ${name} app on your Ledger is too old for this: update it with Ledger Live (My Ledger)`, { sw, app });
  return new LedgerError('error', `your Ledger answered ${hex4(sw)}`, { sw, app });
}

/** Send one command; returns its data, or throws the status word as a LedgerError. `ok` lists other status words
 * that count as an answer (the caller reads them from `sw`). */
export async function send(link, cla, ins, p1, p2, data, { app = null, own = {}, ok = [] } = {}) {
  const { data: out, sw } = splitAnswer(await link.exchange(apdu(cla, ins, p1, p2, data)));
  if (sw !== SW_OK && !ok.includes(sw)) throw swError(sw, { app, own });
  return { data: out, sw };
}

/* ------------------------------------------------------------ what every app answers (the dashboard too) */

/**
 * The app that's open, and its version: { name, version }. On the dashboard the name is "BOLOS". A locked device
 * answers 0x5515 (older firmware 0x6982).
 */
export async function appInfo(link) {
  const { data, sw } = splitAnswer(await link.exchange(apdu(0xb0, 0x01, 0x00, 0x00)));
  if (sw === 0x6982) throw new LedgerError('locked', 'your Ledger is locked: type its PIN on it', { sw });
  if (sw !== SW_OK) throw swError(sw);
  // format 1: name length, name, version length, version, flags length, flags
  let at = 0;
  const take = () => {
    const n = data[at++];
    if (n == null || at + n > data.length) throw new LedgerError('error', "your Ledger's answer about its app doesn't read");
    const s = data.subarray(at, at + n);
    at += n;
    return s;
  };
  if (data[at++] !== 1) throw new LedgerError('error', "your Ledger's answer about its app doesn't read");
  const ascii = (b) => String.fromCharCode(...b).replace(/[^\x20-\x7e]/g, '');
  return { name: ascii(take()), version: ascii(take()) };
}

export const DASHBOARD = 'BOLOS';

/** Ask the dashboard to open an app by name (the device may ask you first). */
export async function openApp(link, name) {
  await send(link, 0xe0, 0xd8, 0x00, 0x00, utf8(name), { app: name });
}

/** Close the open app and go back to the dashboard. */
export async function quitApp(link) {
  await send(link, 0xb0, 0xa7, 0x00, 0x00);
}

/** "1.10.4" -> [1, 10, 4] (anything after a dash is ignored). */
export function versionParts(v) {
  return String(v).split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
}

/** Is version `v` at least `min`? */
export function atLeast(v, min) {
  const a = versionParts(v), b = versionParts(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
