// Ledger's Speculos emulator, from Node: its APDU socket as a link for plum's Ledger clients (a 4-byte big-endian
// length, then the APDU; the answer is the length of its data, the data, then the two-byte status word), and its REST
// API to read the screen and press the buttons, so a test can approve or reject on the "device".
import { Socket } from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A link to Speculos's APDU port: exchange(apdu) -> data + status word. Every exchange is logged in `log`. */
export async function speculosLink({ host = '127.0.0.1', port = 9999 } = {}) {
  const sock = new Socket();
  await new Promise((resolve, reject) => { sock.once('error', reject); sock.connect(port, host, resolve); });
  let buf = Buffer.alloc(0);
  let wake = null;
  let gone = false;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
  sock.on('close', () => { gone = true; wake?.(); });
  const log = [];
  const readExact = async (n) => {
    while (buf.length < n) {
      if (gone) throw new Error('the emulator closed the link');
      await new Promise((r) => { wake = r; });
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  return {
    log,
    async exchange(apdu) {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(apdu.length);
      sock.write(Buffer.concat([head, Buffer.from(apdu)]));
      const len = (await readExact(4)).readUInt32BE(0);
      const answer = new Uint8Array(await readExact(len + 2));
      log.push([Buffer.from(apdu).toString('hex'), Buffer.from(answer).toString('hex')]);
      return answer;
    },
    close() { sock.destroy(); },
  };
}

/** Speculos's REST API: the words on the screen, and the buttons. */
export function speculosApi({ base = 'http://127.0.0.1:5000' } = {}) {
  // the screen's lines, joined with a space (a sentence can run over two lines)
  const screen = async () => {
    const r = await fetch(`${base}/events?currentscreenonly=true`).then((x) => x.json()).catch(() => ({ events: [] }));
    return (r.events ?? []).map((e) => e.text.trim()).filter(Boolean).join(' ');
  };
  const press = async (button) => {
    await fetch(`${base}/button/${button}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'press-and-release' }) });
    await sleep(120);
  };
  /** Step right through a review until a screen says one of `goal` (a regex), then press both buttons. Returns the
   * screens seen on the way. */
  const answer = async (goal, { max = 40, start = 15_000 } = {}) => {
    const seen = [];
    // wait for the review to come up (the screen changes once the app has the request)
    const before = await screen();
    const until = Date.now() + start;
    let now = before;
    while (Date.now() < until) {
      now = await screen();
      if (now && now !== before) break;
      await sleep(150);
    }
    for (let i = 0; i < max; i++) {
      now = await screen();
      seen.push(now);
      if (goal.test(now)) { await press('both'); return seen; }
      // a warning to get past (blind signing ahead: both buttons accept the risk and the review goes on)
      await press(/press both buttons|to accept risk/i.test(now) ? 'both' : 'right');
    }
    throw new Error(`never reached ${goal} on the device; screens: ${seen.join(' || ')}`);
  };
  /** Turn on an app setting from the home screen (its label matched by `label`), then go back home. */
  const setting = async (label) => {
    const seen = [];
    const find = async (re, max = 12) => {
      for (let i = 0; i < max; i++) {
        const now = await screen();
        seen.push(now);
        if (re.test(now)) return now;
        // an error screen (like "blind signing must be enabled") goes away with both buttons
        await press(/must be|error/i.test(now) ? 'both' : 'right');
      }
      throw new Error(`no ${re} in the menus; screens: ${seen.join(' || ')}`);
    };
    await sleep(400);
    await find(/^app settings$|^settings$/i);
    await press('both');
    const at = await find(label);
    if (!/enabled|\bon\b/i.test(at)) await press('both');
    const after = await screen();
    await find(/back/i);
    await press('both');
    return after;
  };
  return { screen, press, answer, setting, approve: (o) => answer(/^(approve|accept and send|accept risk and sign|sign (transaction|message|typed message|psbt|operation)|sign|confirm|hold to sign)\b/i, o), reject: (o) => answer(/^reject\b/i, o) };
}
