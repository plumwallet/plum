// The USB link to a Ledger, over WebHID (Chromium's API for USB devices; Firefox has none). An APDU travels in 64-byte
// HID reports, each one: the channel (2 bytes), the tag 0x05, the report's sequence number (2 bytes), then the bytes;
// the first report's bytes start with the APDU's length (2 bytes). The answer comes back framed the same way, and a
// report from another channel, with another tag or out of sequence is refused.
// The browser asks you, once, which device plum may use (navigator.hid.requestDevice, from one of plum's windows);
// after that the background finds it with navigator.hid.getDevices().
import { concat } from '../../shared/bytes.js';
import { LEDGER_VENDOR, LedgerError } from './apdu.js';

export const PACKET = 64;
const TAG = 0x05;
/** The usage page of a Ledger's APDU interface (its other interfaces, like U2F, aren't for this). */
const LEDGER_USAGE_PAGE = 0xffa0;
/** Waiting for you on the device can take a while; a device that says nothing for this long is gone. */
export const ANSWER_MS = 180_000;

/** An APDU cut into 64-byte reports. */
export function frames(channel, apdu) {
  const data = concat(Uint8Array.of(apdu.length >> 8, apdu.length & 0xff), apdu);
  const room = PACKET - 5;
  const count = Math.max(1, Math.ceil(data.length / room));
  const out = [];
  for (let i = 0; i < count; i++) {
    const f = new Uint8Array(PACKET);
    f[0] = channel >> 8; f[1] = channel & 0xff; f[2] = TAG; f[3] = i >> 8; f[4] = i & 0xff;
    f.set(data.subarray(i * room, (i + 1) * room), 5);
    out.push(f);
  }
  return out;
}

/** Collects an answer's reports: push(report) returns the whole answer once it's in, null until then. */
export function collector(channel) {
  let want = -1, seq = 0;
  let got = new Uint8Array(0);
  return {
    push(report) {
      const r = report instanceof Uint8Array ? report : new Uint8Array(report);
      if (r.length < 5) throw new LedgerError('error', 'your Ledger sent a report too short to read');
      if (((r[0] << 8) | r[1]) !== channel) throw new LedgerError('error', 'your Ledger answered on another channel');
      if (r[2] !== TAG) throw new LedgerError('error', 'your Ledger sent a report plum doesn\'t know');
      if (((r[3] << 8) | r[4]) !== seq) throw new LedgerError('error', "your Ledger's answer came out of order");
      let body = r.subarray(5);
      if (seq === 0) {
        if (body.length < 2) throw new LedgerError('error', 'your Ledger sent a report too short to read');
        want = (body[0] << 8) | body[1];
        body = body.subarray(2);
      }
      seq++;
      got = concat(got, body.subarray(0, Math.max(0, want - got.length)));
      return got.length >= want ? got : null;
    },
  };
}

export const hidSupported = () => typeof navigator !== 'undefined' && !!navigator.hid;

const isLedger = (d) => d?.vendorId === LEDGER_VENDOR;
/** Of a Ledger's interfaces, the one that speaks APDUs (any, when the browser doesn't say). */
const apduInterface = (d) => !d.collections?.length || d.collections.some((c) => c.usagePage === LEDGER_USAGE_PAGE);

/** The model from the USB product id's high byte (or the old fixed ids). */
export function modelOf(productId) {
  const byHigh = { 0x10: 'Nano S', 0x40: 'Nano X', 0x50: 'Nano S Plus', 0x60: 'Stax', 0x70: 'Flex', 0x80: 'Nano Gen5' };
  const old = { 0x0001: 'Nano S', 0x0004: 'Nano X', 0x0005: 'Nano S Plus', 0x0006: 'Stax', 0x0007: 'Flex' };
  return old[productId] ?? byHigh[productId >> 8] ?? 'Ledger';
}

/** The Ledgers plum may use already (you picked them in a window before). */
export async function grantedLedgers() {
  if (!hidSupported()) return [];
  return (await navigator.hid.getDevices()).filter((d) => isLedger(d) && apduInterface(d));
}

/** One open device, one exchange at a time. */
export class HidLink {
  constructor(device) {
    this.device = device;
    this.model = modelOf(device.productId);
    this.channel = (crypto.getRandomValues(new Uint16Array(1))[0] | 0x0101) & 0xffff;
    this.inbox = [];
    this.waiting = null;
    this.closed = false;
    this.onReport = (e) => {
      const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
      if (this.waiting) { const w = this.waiting; this.waiting = null; w(bytes); } else this.inbox.push(bytes);
    };
    device.addEventListener('inputreport', this.onReport);
  }

  /** Open the first Ledger plum may use; throws 'connect' when there's none (or 'unsupported' without WebHID). */
  static async open() {
    if (!hidSupported()) throw new LedgerError('unsupported', "this browser can't reach USB devices: Ledgers work in Chrome, Brave and Edge");
    const [device] = await grantedLedgers();
    if (!device) throw new LedgerError('connect', 'plug in your Ledger and unlock it');
    try { if (!device.opened) await device.open(); } catch (e) {
      throw new LedgerError('connect', `plum couldn't open your Ledger (${String(e?.message ?? e).slice(0, 80)}): close Ledger Live or any other app using it, then try again`);
    }
    const link = new HidLink(device);
    // unplugged, or restarting into another app: whatever was waiting on it stops at once
    link.onGone = (e) => { if (e.device === device) link.close(); };
    navigator.hid.addEventListener('disconnect', link.onGone);
    return link;
  }

  /** The next report, or a timeout. */
  next(ms) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = null; reject(new LedgerError('timeout', 'your Ledger stopped answering: unplug it, plug it back in and try again')); }, ms);
      this.waiting = (r) => { clearTimeout(t); resolve(r); };
      this.abort = () => { clearTimeout(t); this.waiting = null; reject(new LedgerError('connect', 'your Ledger was unplugged')); };
    });
  }

  async exchange(apdu, { timeout = ANSWER_MS } = {}) {
    if (this.closed) throw new LedgerError('connect', 'your Ledger was unplugged');
    this.inbox = [];
    for (const f of frames(this.channel, apdu)) {
      try { await this.device.sendReport(0, f); } catch { this.close(); throw new LedgerError('connect', 'plum lost your Ledger: plug it back in'); }
    }
    const c = collector(this.channel);
    for (;;) {
      const done = c.push(await this.next(timeout));
      if (done) return done;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.device.removeEventListener('inputreport', this.onReport);
    if (this.onGone) navigator.hid?.removeEventListener('disconnect', this.onGone);
    this.abort?.();
    try { await this.device.close(); } catch { /* already gone */ }
  }
}
