// The content script (the page can't see it): carries requests from plum's wallets in the page (Solana's and
// Ethereum's) to the background, and answers back. It adds nothing of its own: the background decides everything, and
// knows the page's origin from the browser, not from these messages.
import { ext as api } from '../shared/ext.js';

const CHANNEL = 'plum-wallet:v1';
const ext = api();

let port = null;
const inflight = new Set();
let beat = null;

function post(data) {
  window.postMessage({ channel: CHANNEL, dir: 'to-page', ...data }, window.location.origin);
}

function getPort() {
  if (port) return port;
  port = ext.runtime.connect({ name: 'plum-page' });
  port.onMessage.addListener((m) => {
    if (!m || typeof m.id !== 'string') return;
    inflight.delete(m.id);
    if (!inflight.size) stopBeat();
    post({ id: m.id, result: m.result, error: m.error });
  });
  port.onDisconnect.addListener(() => {
    port = null;
    stopBeat();
    for (const id of inflight) post({ id, error: { message: 'Plum restarted before answering: try again', code: -32603 } });
    inflight.clear();
  });
  return port;
}

// while a request waits for you, keep the background awake (Firefox suspends an idle event page, Chromium an idle
// service worker; a message on the port counts as activity for both)
function startBeat() {
  if (!beat) beat = setInterval(() => { try { port?.postMessage({ ping: true }); } catch { /* reconnects on the next request */ } }, 10_000);
}
function stopBeat() {
  if (beat) clearInterval(beat);
  beat = null;
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.channel !== CHANNEL || d.dir !== 'to-ext') return;
  if (typeof d.id !== 'string' || d.id.length > 64 || typeof d.method !== 'string' || d.method.length > 40) return;
  inflight.add(d.id);
  startBeat();
  try {
    getPort().postMessage({ id: d.id, method: d.method, params: d.params });
  } catch {
    port = null;
    getPort().postMessage({ id: d.id, method: d.method, params: d.params });
  }
});

// the background tells every tab when accounts or networks change; connected pages then ask again
ext.runtime.onMessage.addListener((m) => {
  if (m?.type === 'plum-event' && typeof m.event === 'string') post({ event: m.event });
});
