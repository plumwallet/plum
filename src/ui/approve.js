// The approval window: plum's own window, which no web page can draw over or click for you. One request at a time
// (a queue when a site asks for several): who is asking, what it would do (simulated), every warning, then your answer.
// The approve button wakes up only once the window has been in front for a beat, and goes back to sleep whenever the
// window loses focus or hides, so a click (or the second half of a double-click) meant for the page can't land on it.
import { short } from '../shared/format.js';
import { call, keepAlive } from './api.js';
import { BTC_TITLES, btcAsk, btcBody, btcPreview } from './btc-approve.js';
import { busyButton, h, mount } from './dom.js';
import { netLoud } from './evm.js';
import { deviceBox, ledgerNote } from './ledger.js';
import { CHAIN, box, chip, kv, netChip, previewBlock, riskBanner, secretField, spinner, warnings } from './parts.js';
import './scrollbar.js';

const app = document.getElementById('app');
const ARM_MS = 900;
const TITLES = {
  connect: 'connect', sign: 'sign', signAndSend: 'sign + send', message: 'sign a message', signIn: 'sign in',
  evmConnect: 'connect', evmMessage: 'sign a message', evmTyped: 'sign typed data', evmTx: 'send a transaction',
  ...BTC_TITLES,
};
const errLine = () => h('div', { class: 'err-line', hidden: true });
const showErr = (el, e) => { el.textContent = e?.message ?? String(e); el.hidden = false; };

let current = null;
let armers = null;

function head(view) {
  return h('header', { class: 'top' },
    h('div', { class: 'top-in' },
      h('div', { class: 'who' }, h('b', null, 'plum'), h('div', { class: 'dim' }, view.queue > 1 ? `request 1 of ${view.queue}` : 'a site is asking')),
      h('span', { class: 'grow' }),
      // an Ethereum request's network, always and loudly: the same address works on four
      view.chain === 'eth' ? netLoud(view.evmNet?.key) : netChip(view.network ?? 'mainnet')));
}

function siteBox(view) {
  const what = {
    connect: 'wants to see your Solana address and ask you to approve transactions. It cannot move anything without asking.',
    sign: view.txCount > 1 ? `wants you to sign ${view.txCount} transactions. It sends them itself.` : 'wants you to sign a transaction. It sends it itself.',
    signAndSend: view.txCount > 1 ? `wants you to sign ${view.txCount} transactions, which plum then sends.` : 'wants you to sign a transaction, which plum then sends.',
    message: "wants you to sign a message. Signing a message can't move funds by itself, but some apps act on signed messages (orders, logins): read it.",
    signIn: 'wants you to sign in with your wallet.',
    evmConnect: 'wants to see your Ethereum address and ask you to approve transactions. It cannot move anything without asking.',
    evmMessage: "wants you to sign a message. Signing a message can't move funds by itself, but some apps act on signed messages (orders, logins): read it.",
    evmTyped: 'wants your signature on structured data. Some of these move money without another prompt (permits, marketplace orders): read every line.',
    evmTx: 'wants you to send a transaction from your wallet, which plum signs and sends.',
  }[view.kind] ?? (view.chain === 'btc' ? btcAsk(view) : '');
  return box(TITLES[view.kind], { tone: view.risk?.level === 'blocked' ? 'red' : 'ink' },
    h('div', { class: 'site-line' }, h('b', { class: 'host' }, view.host), view.connected ? chip('connected', 'green') : chip('new site', 'hot')),
    view.secure ? null : h('div', { class: 't-gold' }, 'not https: this is your own computer (localhost)'),
    h('p', null, what),
    view.evmNet ? kv('on', `${view.evmNet.title.toLowerCase()} (chain ${view.evmNet.id})`, 'loud') : kv('on', CHAIN[view.chain ?? 'sol'].name),
    view.evmNet?.siteNow ? h('div', { class: 'note hot' }, `this site moved to ${view.evmNet.siteNow} after it asked: this request is still for ${view.evmNet.title}, and is signed for ${view.evmNet.title} only`) : null,
    view.account ? kv('wallet', `${view.account.name}  ${short(view.account.address)}`) : null);
}

/** Typed data (EIP-712), read before it's signed: who it's for (its domain), what kind it is, every field. */
function typedBody(view) {
  const t = view.typed;
  return [
    warnings(t.warnings),
    box('you sign', { tone: t.warnings.some((w) => w.level === 'danger') ? 'hot' : 'soft' },
      kv('kind', t.primaryType),
      t.domain.name ? kv('for', `${t.domain.name}${t.domain.version ? ` v${t.domain.version}` : ''}`) : null,
      t.domain.contract ? kv('contract', short(t.domain.contract, 6)) : null,
      t.domain.chainId ? kv('chain id', t.domain.chainId) : null),
    box('the message', { tone: 'soft' },
      h('div', { class: 'kvs typed' }, t.lines.map((l) => kv(l.path, l.value)))),
  ];
}

function unlockBox(onDone) {
  const pwF = secretField({ placeholder: 'your password' });
  const pw = pwF.input;
  const err = errLine();
  const go = h('button', { class: 'btn-go block', type: 'submit', dataset: { busyText: 'unlocking' } }, 'unlock ->');
  const form = h('form', { class: 'stack tight' }, pwF.node, err, go);
  form.addEventListener('submit', (e) => e.preventDefault());
  busyButton(go, async () => {
    try { await call('unlock', { password: pw.value }); pw.value = ''; onDone(); } catch (e) { showErr(err, e); pw.select(); }
  });
  setTimeout(() => pw.focus(), 50);
  return box('plum is locked', { tone: 'soft' }, h('p', null, 'unlock to answer this request.'), form);
}

function messageBody(view) {
  const m = view.message;
  if (m.text != null) return box('the message', { tone: 'soft' }, h('pre', { class: 'msg' }, m.text));
  return box('the message', { tone: 'hot' },
    h('div', { class: 'note hot' }, "this message isn't readable text, so plum can't tell you what it is. Only sign it if you know exactly what the site uses it for."),
    h('pre', { class: 'msg hex' }, m.hex + (m.bytes > 512 ? ' ...' : '')), kv('size', `${m.bytes} bytes`));
}

function signInBody(view) {
  const s = view.signIn;
  return [
    s.problems.length ? h('div', { class: 'warns' }, s.problems.map((p) => h('div', { class: 'note err lvl-danger' }, p))) : null,
    box('you sign', { tone: 'soft' }, h('pre', { class: 'msg' }, s.text)),
  ];
}

async function render() {
  const view = await call('approval.get');
  if (!view) {
    // nothing left: say so before closing, so a request that lands right now gets a window instead of a "no"
    if (await call('approval.done').catch(() => 0)) { await render(); return; }
    window.close();
    return;
  }
  current = view.id;
  const err = errLine();
  const body = h('div', { class: 'stack' });
  const connecting = view.kind === 'connect' || view.kind === 'evmConnect' || view.kind === 'btcConnect';
  const risky = view.risk?.level === 'blocked' || (view.kind === 'signIn' && view.signIn.problems.length > 0)
    || ((view.kind === 'message' || view.kind === 'evmMessage') && view.message.text == null)
    || (view.kind === 'evmMessage' && view.message.problems?.length > 0)
    || (view.kind === 'evmTyped' && view.typed.warnings.some((w) => w.level === 'danger'))
    || (view.kind === 'btcMessage' && (view.btc.text == null || view.btc.problems?.length > 0));
  let dangers = risky;
  const ack = h('button', { class: 'toggle', 'aria-pressed': 'false' }, view.risk?.level === 'blocked' ? 'i know this site is listed, continue anyway' : 'i understand the risk, approve anyway');
  const sends = view.kind === 'signAndSend' || view.kind === 'evmTx' || view.kind === 'btcSend' || (view.kind === 'btcPsbt' && view.btc?.broadcast);
  const approve = h('button', { class: 'btn-go lg', disabled: true, dataset: { busyText: sends ? 'signing + sending' : 'signing' } }, connecting ? 'connect ->' : 'approve ->');
  const reject = h('button', { class: 'btn no' }, connecting ? 'cancel' : 'reject');
  let armed = false, armedAt = Infinity, pressedAt = -1, acked = false, ready = !view.txCount;
  const sync = () => { approve.disabled = !armed || !ready || (dangers && !acked) || !view.unlocked; };
  ack.addEventListener('click', () => { acked = !acked; ack.classList.toggle('on', acked); ack.setAttribute('aria-pressed', String(acked)); sync(); });
  // arm only after the window has been in front, visible, for ARM_MS; disarm the moment it isn't
  let timer = null;
  const disarm = () => { clearTimeout(timer); armed = false; armedAt = Infinity; sync(); };
  const arm = () => {
    clearTimeout(timer);
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    timer = setTimeout(() => { armed = true; armedAt = performance.now(); sync(); }, ARM_MS);
  };
  armers?.abort();
  armers = new AbortController();
  window.addEventListener('blur', disarm, { signal: armers.signal });
  window.addEventListener('focus', arm, { signal: armers.signal });
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? arm() : disarm()), { signal: armers.signal });
  arm();
  // a press that began before the button armed doesn't count
  approve.addEventListener('pointerdown', () => { pressedAt = performance.now(); });
  approve.addEventListener('keydown', () => { pressedAt = performance.now(); });

  reject.addEventListener('click', async () => { try { await call('approval.reject', { id: view.id }); } finally { next(); } });
  // a site that floods you: answer all of its requests "no" at once
  const rejectSite = view.siteQueue > 1 ? h('button', { class: 'btn btn-sm danger' }, `reject all ${view.siteQueue} from ${view.site}`) : null;
  rejectSite?.addEventListener('click', async () => { try { await call('approval.rejectSite', { id: view.id }); } finally { next(); } });
  // a Ledger signs after you approve here: its state, live, until it has answered
  const device = view.ledger ? deviceBox(view.ledger.app, { hidden: true }) : null;
  busyButton(approve, async () => {
    err.hidden = true;
    if (!armed || pressedAt < armedAt) return;
    device?.watch();
    try {
      await call('approval.resolve', { id: view.id, approve: true, ignoreRisk: acked });
      device?.stop();
      next();
    } catch (e) {
      if (!device?.failed(e)) showErr(err, e);
      // a no on the device (or a request it can't take) has answered the site: the window moves on once you've read it
      else if (/^ledger-(rejected|refused|too-large|cancelled)$/.test(e.code)) setTimeout(() => { if (current === view.id) next(); }, 2500);
    }
  });

  mount(app, head(view), h('main', { class: 'screen approve' },
    riskBanner(view.risk),
    siteBox(view),
    view.ledger ? ledgerNote(view) : null,
    view.unlocked ? null : unlockBox(() => render()),
    body,
    device?.node,
    h('div', { class: 'ack-row', hidden: !risky }, ack),
    err,
    h('div', { class: 'actions answer' }, reject, approve),
    rejectSite ? h('div', { class: 'row' }, rejectSite) : null));

  // a sign-in message (EIP-4361) for another site than the one asking: how a phishing page logs in there as you
  if (view.message?.problems?.length) body.append(h('div', { class: 'warns' }, view.message.problems.map((p) => h('div', { class: 'note err lvl-danger' }, p))));
  if (view.kind === 'message' || view.kind === 'evmMessage') body.append(messageBody(view));
  if (view.kind === 'signIn') body.append(...signInBody(view));
  if (view.kind === 'evmTyped') body.append(...typedBody(view).filter(Boolean));
  if (view.chain === 'btc') body.append(...btcBody(view));
  else if (connecting) body.append(h('p', { class: 'fine' }, 'only connect to sites you trust'));
  if (view.txCount) {
    body.append(h('div', { class: 'note', 'aria-label': 'simulating' }, spinner()));
    try {
      const previews = await call('approval.preview', { id: view.id });
      if (current !== view.id) return;
      const fixed = view.chain === 'btc' ? btcBody(view) : [];
      body.replaceChildren(...fixed, ...previews.map((p, i) => (view.chain === 'btc' ? btcPreview(p) : previewBlock(p, { index: i, count: previews.length }))));
      dangers = dangers || previews.some((p) => p.error || p.warnings?.some((w) => w.level === 'danger'));
      if (dangers) { ack.parentElement.hidden = false; }
      // a Bitcoin request plum refuses (a lie about a coin, an input that isn't yours) can't be approved at all
      if (view.chain === 'btc' && previews.some((p) => p.error)) { ack.parentElement.hidden = true; sync(); return; }
    } catch (e) {
      body.replaceChildren(h('div', { class: 'note err' }, `plum couldn't simulate this: ${e.message}. Approve only if you trust the site completely.`));
      dangers = true;
      ack.parentElement.hidden = false;
    }
    ready = true;
  }
  sync();
}

async function next() {
  current = null;
  await render().catch((e) => mount(app, h('div', { class: 'note err' }, e.message)));
}

keepAlive();
next();
