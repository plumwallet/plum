// One Ledger at a time, from the background. plum finds the device you allowed it to use, makes sure the right app is
// open (asking the dashboard to open it, or closing another app first, when the device lets it), and waits for you
// while it's unplugged, locked or showing another app, saying which in status() for plum's windows to draw. Then one
// operation runs; another one asked meanwhile is turned away, so nothing can pile work up on your device.
import { DASHBOARD, LedgerError, appInfo, openApp, quitApp } from './apdu.js';
import { HidLink, hidSupported } from './hid.js';

/** How long plum waits for you to plug the device in, unlock it or open the app before it gives up. */
export const WAIT_MS = 120_000;
const POLL_MS = 1000;
const SWITCH_MS = 30_000;
const STATES_TO_WAIT = new Set(['connect', 'locked', 'open-app', 'wrong-app', 'timeout']);

const defaultOpener = () => HidLink.open();
let opener = defaultOpener;
let waitMs = WAIT_MS;
/** Tests (and the emulator) give their own device here, and a shorter wait. */
export function _setOpener(fn) { opener = fn ?? defaultOpener; }
export function _setWait(ms) { waitMs = ms ?? WAIT_MS; }

let current = { state: 'idle', message: '', app: null, model: null, at: 0 };
let job = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function set(state, message = '', extra = {}) {
  current = { ...current, state, message, ...extra, at: Date.now() };
}

/** What the device is doing, for plum's windows: { state, message, app, model, busy, supported }. */
export const status = () => ({ ...current, busy: !!job, supported: opener !== defaultOpener || hidSupported() });

/** Stop waiting on the device (you rejected the request in plum). A review already on its screen stays there until
 * you answer it on the device. */
export function cancel() {
  if (!job) return;
  job.cancelled = true;
  job.link?.close?.();
}

/** A link whose answers must come within `ms` (commands that don't wait for you). */
const quick = (link, ms) => ({ exchange: (a) => link.exchange(a, { timeout: ms }) });

/**
 * Run `fn(link, info, { confirm })` with the app `app` open: `info` is { name, version }, and `confirm(message)` says
 * that the device is now waiting for you to check and approve. While there's no device, it's locked or another app is
 * open, this waits (up to WAIT_MS), saying so in status(). Errors from `fn` (a no on the device, a bad answer) end it.
 */
export async function use(app, fn, { wait = waitMs } = {}) {
  if (job) throw new LedgerError('busy', 'your Ledger is busy with another request: answer that one first');
  const me = { cancelled: false, link: null, quit: false, open: false };
  job = me;
  const until = Date.now() + wait;
  const stopped = () => new LedgerError('cancelled', 'stopped in plum');
  try {
    set('busy', '', { app });
    for (;;) {
      if (me.cancelled) throw stopped();
      let info = null;
      try {
        me.link ??= await opener();
        set('busy', '', { app, model: me.link.model ?? current.model });
        info = await appInfo(quick(me.link, 10_000));
      } catch (e) {
        if (me.cancelled) throw stopped();
        if (!(e instanceof LedgerError) || !STATES_TO_WAIT.has(e.state)) { set(e.state ?? 'error', e.message); throw e; }
        set(e.state, e.message);
        if (e.state === 'connect' || e.state === 'timeout') { await me.link?.close?.(); me.link = null; }
      }
      if (info?.name === app) {
        try {
          const out = await fn(me.link, info, { confirm: (message) => set('confirm', message ?? 'check it on your Ledger, then approve it there') });
          set('idle', '');
          return out;
        } catch (e) {
          if (me.cancelled) throw stopped();
          set(e.state ?? 'error', e.message);
          throw e;
        }
      }
      if (info && info.name !== DASHBOARD && !me.quit) {
        // another app is open: close it (the device goes back to its dashboard and comes back on USB)
        me.quit = true;
        set('wrong-app', `your Ledger has ${info.name} open: plum is closing it to open ${app}`);
        await quitApp(quick(me.link, 5000)).catch(() => {});
        await me.link.close?.();
        me.link = null;
        await sleep(1500);
        continue;
      }
      if (info?.name === DASHBOARD && !me.open) {
        me.open = true;
        set('open-app', `plum asked your Ledger to open ${app}: confirm it there if it asks`);
        try { await openApp(quick(me.link, SWITCH_MS), app); } catch (e) {
          if (e.state === 'not-installed') { set(e.state, e.message); throw e; }
        }
        await me.link?.close?.();
        me.link = null;
        await sleep(1500);
        continue;
      }
      if (info) set(info.name === DASHBOARD ? 'open-app' : 'wrong-app', info.name === DASHBOARD ? `open the ${app} app on your Ledger` : `your Ledger has ${info.name} open: close it and open ${app}`);
      if (Date.now() > until) throw new LedgerError(current.state === 'busy' ? 'timeout' : current.state, current.message || 'your Ledger stopped answering');
      await sleep(POLL_MS);
    }
  } finally {
    await me.link?.close?.();
    if (job === me) job = null;
  }
}
