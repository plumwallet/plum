// plum's background (Firefox's event page, Chromium's service worker): the only place secrets are used. Two doors,
// kept apart:
//   - plum's own pages (popup, approval window) send runtime messages; anything that doesn't come from an extension
//     page is ignored.
//   - web pages talk through the content script's port, one per tab. A page's origin is what the browser says the tab
//     is showing (port.sender.url), never anything the page writes in its message. A page can ask; only you approve,
//     in a window the page can't draw over. Solana sites ask through the Wallet Standard, Ethereum sites through
//     EIP-1193 (found by EIP-6963), and each chain's connections are kept apart.
import { base58Decode, isAddress } from '../shared/base58.js';
import { b64decode, b64encode, hex, readUtf8, utf8 } from '../shared/bytes.js';
import { ext } from '../shared/ext.js';
import { formatUnits, parseUnits, short } from '../shared/format.js';
import { associatedTokenAddress, isOnCurve } from '../shared/pda.js';
import { hasHidden } from '../shared/text.js';
import {
  MAX_TX_BYTES, MAX_V1_TX_BYTES, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, compileLegacy, compileV1, isSigned, isTransactionShaped, ix, maxTxBytes, readTx,
  signersOf, startsLikeTransaction, unsignedTx, withSignature,
} from '../shared/tx.js';
import * as B from './btc.js';
import { prepareSpend, spendable } from './btc-send.js';
import { BTC_APPROVALS, bitcoinSites, ownerOf } from './btc-site.js';
import * as E from './eth.js';
import { EVM_NETWORKS, MAINNET, chainHex, networkById, networkByKey, unsupportedChain } from './evm-chains.js';
import { forgetSite, moveSite, siteNetwork } from './evm-site.js';
import { isMnemonic, newMnemonic, normalizeMnemonic } from './keys.js';
import { pool } from './net.js';
import { checkHost, fetchLists } from './phishing.js';
import { previewTx } from './preview.js';
import { priceOf } from './prices.js';
import { NETWORKS, checkRpcUrl, client, explorerUrl, networkOfChain } from './rpc.js';
import { quote as jupQuote, searchTokens, swapTransaction, tokenInfo } from './jupiter.js';
import * as N from './nfts.js';
import * as S from './stake.js';
import { AUTOLOCK_CHOICES, getSettings, local, session, setSettings } from './store.js';
import * as W from './wallet.js';

export const VERSION = '0.1.6';
const PHISH_ALARM = 'plum-phish';
const RENT_EXEMPT_EMPTY = 890_880n;
const MAX_MESSAGE = 16 * 1024;
const MAX_TXS = 20;
const CHAIN_NAMES = { sol: 'Solana', eth: 'Ethereum', btc: 'Bitcoin' };

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const rejected = () => fail('User rejected the request.', 4001);
const newId = () => b64encode(crypto.getRandomValues(new Uint8Array(12))).replace(/[+/=]/g, 'x');

/** Changes to accounts, wallets, settings and the vault, one at a time (two quick clicks can't interleave). */
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

/* ------------------------------------------------------------ networks */

/** The RPC URL for a Solana network: yours if it's set and still valid (it's checked every time it's read, not only
 * when it's saved, since the profile on disk could have been edited), else plum's own. */
export function rpcUrlFor(settings, network) {
  const custom = settings.rpc?.[network];
  if (custom) {
    try { return checkRpcUrl(custom); } catch { /* a bad saved URL is ignored */ }
  }
  return NETWORKS[network].url;
}

async function net(name) {
  const s = await getSettings();
  const network = name && NETWORKS[name] ? name : s.network;
  const url = rpcUrlFor(s, network);
  return { network, url, chain: NETWORKS[network].chain, rpc: client(url), mainnet: network === 'mainnet' };
}

/** The RPCs to ask on an Ethereum network: yours alone if you set one for it (checked like Solana's), else plum's
 * public ones in turn. */
async function ethUrls(net = MAINNET) {
  const s = await getSettings();
  const custom = net === MAINNET ? s.ethRpc : s.evmRpc?.[net.key];
  if (custom) {
    try { return [checkRpcUrl(custom)]; } catch { /* a bad saved URL is ignored */ }
  }
  return net.rpcs;
}

/** Where a signed transaction goes: on Ethereum, MEV Blocker first; then the network's RPCs. */
const sendUrls = async (net) => [...net.private, ...(await ethUrls(net))];

async function jupOpts() {
  const s = await getSettings();
  return { apiKey: s.jupiterKey || undefined };
}

/** Token names for previews (mainnet only; elsewhere tokens show by address). */
function namer(network) {
  if (network !== 'mainnet') return null;
  return async (mints) => tokenInfo(mints, await jupOpts());
}

/** The active wallet's address on a chain (null if it has none there). */
async function activeOn(chain) {
  return (await W.activeWallet())?.chains[chain]?.address ?? null;
}

async function requireActive(chain) {
  const w = await W.activeWallet();
  if (!w) throw fail('plum has no wallet yet');
  const address = w.chains[chain]?.address;
  if (!address) throw fail(`${w.name} has no ${CHAIN_NAMES[chain]} address (it's an imported ${Object.keys(w.chains).map((c) => CHAIN_NAMES[c]).join('/')} key)`);
  return { wallet: w, address };
}

/* ------------------------------------------------------------ sites you've connected */

const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');

/** Connected sites: { origin: { accounts: [Solana addresses you connected there], evm: [Ethereum ones], connectedAt,
 * lastUsed } }. Connecting one wallet never shows a site your others, and a Solana connection shows nothing on
 * Ethereum (and back). */
export const sites = () => local.get('sites', {});
const FIELD = { sol: 'accounts', eth: 'evm', btc: 'btc' };

async function trusted(origin, address, chain = 'sol') {
  const s = (await sites())[origin];
  const list = s?.[FIELD[chain]];
  return Array.isArray(list) && (address ? list.includes(address) : list.length > 0);
}

async function trust(origin, address, chain = 'sol') {
  const all = await sites();
  const now = Date.now();
  const cur = all[origin] ?? {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const list = [...new Set([...arr(cur[FIELD[chain]]), address])];
  all[origin] = { accounts: arr(cur.accounts), evm: arr(cur.evm), btc: arr(cur.btc), connectedAt: cur.connectedAt ?? now, [FIELD[chain]]: list, lastUsed: now };
  await local.set({ sites: all });
}

/** Forget a site on one chain (both when no chain is given). What it left waiting goes too: nothing a site asked for
 * before it was disconnected is signed after. */
async function untrust(origin, chain = null) {
  for (const r of [...pending.values()]) if (r.origin === origin && (!chain || r.chain === chain)) { pending.delete(r.id); r.reject(rejected()); }
  if (!chain || chain === 'eth') await forgetSite(origin);
  const all = await sites();
  if (!all[origin]) return;
  if (chain) all[origin] = { ...all[origin], [FIELD[chain]]: [] };
  if (!chain || (!all[origin].accounts?.length && !all[origin].evm?.length && !all[origin].btc?.length)) delete all[origin];
  await local.set({ sites: all });
}

async function revoke(origin) {
  await untrust(origin);
  await broadcast('accountChanged');
}

/* ------------------------------------------------------------ phishing */

let lists = null;

async function phishLists() {
  if (!lists) {
    const stored = await local.get('phish');
    lists = { block: new Set(stored?.block ?? []), allow: new Set(stored?.allow ?? []), at: stored?.at ?? 0 };
  }
  return lists;
}

export async function refreshPhish() {
  try {
    const fresh = await fetchLists();
    await local.set({ phish: fresh });
    lists = { block: new Set(fresh.block), allow: new Set(fresh.allow), at: fresh.at };
  } catch { /* keep the last good copy */ }
}

/** A site's standing on the phishing list: always looked up (there's no switch for it). */
async function riskOf(origin) {
  return checkHost(new URL(origin).hostname, await phishLists());
}

/* ------------------------------------------------------------ events to pages (they re-ask for their accounts) */

async function broadcast(event) {
  let tabs = [];
  try { tabs = await ext().tabs.query({}); } catch { return; }
  await Promise.all(tabs.map((t) => Promise.resolve().then(() => ext().tabs.sendMessage(t.id, { type: 'plum-event', event })).catch(() => {})));
}

/* ------------------------------------------------------------ approvals: one window, a queue of requests */

const pending = new Map(); // id -> request
let approvalWindow = null;
/** The approval window's id while it's open or being opened (a promise), so a burst of requests opens it once. */
let windowReady = null;

/**
 * Open the approval window, or flag the open one. A new request never pulls the window in front of you: a page could
 * time that with your clicks (and the window's buttons only arm once it has been in front for a moment anyway).
 */
async function openApprovalWindow() {
  const opts = { url: ext().runtime.getURL('approve.html'), type: 'popup', width: 400, height: 660 };
  try {
    const last = await ext().windows.getLastFocused();
    if (last?.left != null && last?.width) { opts.left = Math.max(0, last.left + last.width - 420); opts.top = Math.max(0, (last.top ?? 0) + 70); }
  } catch { /* no window to sit beside */ }
  const win = await ext().windows.create(opts);
  approvalWindow = win.id;
  return win.id;
}

function showApproval({ focus = false } = {}) {
  // decided synchronously: the first request of a burst opens the window, the rest wait for that same window
  if (!windowReady) {
    const opening = openApprovalWindow().catch((e) => { if (windowReady === opening) windowReady = null; throw e; });
    windowReady = opening;
    return opening;
  }
  const ready = windowReady;
  return ready.then(async (id) => {
    try {
      await ext().windows.update(id, focus ? { focused: true } : { drawAttention: true });
    } catch {
      // the window went away without telling us: open a fresh one (once)
      if (windowReady === ready) { windowReady = null; approvalWindow = null; }
      return showApproval({ focus });
    }
    return id;
  });
}

/** Approval windows closing themselves because nothing is left to answer: that's not you saying no. */
const leaving = new Set();

/** The approval window is done (it found nothing left to show): forget it, so the next request opens a fresh one. If a
 * request slipped in meanwhile, it stays open for that instead. */
function approvalDone() {
  if (pending.size) return pending.size;
  if (approvalWindow != null) leaving.add(approvalWindow);
  approvalWindow = null;
  windowReady = null;
  return 0;
}

function onWindowRemoved(id) {
  if (id === welcomeWindow) welcomeWindow = null;
  if (leaving.delete(id)) {
    // a request that arrived while it was closing gets a window of its own
    if (pending.size && windowReady == null) showApproval().catch(() => {});
    return;
  }
  if (id !== approvalWindow) return;
  // you closed the window: every request in it is a no
  approvalWindow = null;
  windowReady = null;
  for (const r of pending.values()) r.reject(rejected());
  pending.clear();
}

/** Queue a request for your approval; resolves with what approving it produced (accounts, signatures...). */
function approval(req) {
  return new Promise((resolve, reject) => {
    const id = newId();
    if (req.ctx?.closed) { reject(fail('the page closed')); return; }
    const entry = { chain: 'sol', ...req, id, created: Date.now(), resolve, reject, previews: null };
    pending.set(id, entry);
    req.ctx?.owned.add(id);
    showApproval().catch((e) => { pending.delete(id); reject(e); });
  });
}

function nextPending() {
  return pending.values().next().value ?? null;
}

/** What the approval window shows (cheap; previews come from approvalPreview). */
async function approvalView() {
  const r = nextPending();
  if (!r) return null;
  const w = await W.walletOf(r.chain, r.account);
  const view = {
    id: r.id,
    kind: r.kind,
    chain: r.chain,
    origin: r.origin,
    host: new URL(r.origin).host,
    secure: r.origin.startsWith('https:'),
    connected: await trusted(r.origin, r.account, r.chain),
    network: r.network,
    risk: r.risk,
    queue: pending.size,
    siteQueue: [...pending.values()].filter((x) => siteOf(x.origin) === siteOf(r.origin)).length,
    site: siteOf(r.origin),
    account: w ? { name: w.name, icon: w.icon, address: r.account } : { name: '?', icon: null, address: r.account },
    unlocked: await W.isUnlocked(),
    txCount: r.txs?.length ?? (r.kind === 'evmTx' || r.kind === 'btcPsbt' || r.kind === 'btcSend' ? 1 : 0),
  };
  if (r.btcView) view.btc = r.btcView;
  if (r.kind === 'message' || r.kind === 'evmMessage') view.message = r.messageView;
  if (r.kind === 'signIn') view.signIn = r.signInView;
  if (r.kind === 'evmTyped') view.typed = r.typedView;
  if (r.kind === 'evmTx') view.evmTx = r.txView;
  if (r.chain === 'eth') {
    const n = networkByKey(r.network) ?? MAINNET;
    view.evmNet = { key: n.key, title: n.title, id: n.id, tag: n.tag, symbol: n.native.symbol };
    // the site moved since it asked: this request stays on the network it was made on, and the window says so
    const now = await siteNetwork(r.origin);
    if (now !== n) view.evmNet.siteNow = now.title;
  }
  return view;
}

async function approvalPreview(id) {
  const r = pending.get(id);
  if (!r) return null;
  if (r.kind === 'evmTx') {
    // what's previewed is what's signed: the gas limit and fees it was simulated with are kept for the signature
    r.previews ??= evmPreview(r.account, r.call, networkByKey(r.network) ?? MAINNET).then(({ signWith, ...p }) => { r.signWith = signWith; return [p]; });
    return r.previews;
  }
  if (r.kind === 'btcPsbt' || r.kind === 'btcSend') {
    r.previews ??= btcSite.preview(r).then((p) => [p]);
    return r.previews;
  }
  if (!r.txs) return null;
  r.previews ??= (async () => {
    const { rpc, network } = await net(r.network);
    const meta = namer(network);
    const out = [];
    for (const b64 of r.txs) {
      try { out.push(await previewTx(b64decode(b64), { owner: r.account, rpc, meta })); } catch (e) { out.push({ error: e.message }); }
    }
    // each is simulated on its own: a later one doesn't see what the earlier ones change
    if (out.length > 1) {
      for (const p of out) {
        p.warnings?.splice(p.warnings.filter((w) => w.level === 'danger').length, 0, { level: 'warn', text: `one of ${out.length} transactions, each previewed on its own: an earlier one can change what a later one does. The site sends them when it likes.` });
      }
    }
    return out;
  })();
  return r.previews;
}

async function approvalResolve({ id, approve, ignoreRisk }) {
  const r = pending.get(id);
  if (!r) throw fail('that request is gone (the page closed or it timed out)');
  if (!approve) {
    pending.delete(id);
    r.reject(rejected());
    return { done: true };
  }
  if (!(await W.isUnlocked())) throw fail('unlock plum first', 'locked');
  if (r.txs && r.network !== (await getSettings()).network) throw fail("plum's network changed since this request was made: reject it and ask again");
  if (r.risk?.level === 'blocked' && !ignoreRisk) throw fail('this site is on the phishing blocklist');
  if (r.kind === 'signIn' && r.signInView.problems.length && !ignoreRisk) throw fail("this sign-in doesn't match the site asking");
  if (r.kind === 'evmTyped' && r.typedView.warnings.some((w) => w.level === 'danger') && !ignoreRisk) throw fail('this signature carries a danger: tick "i understand" to sign it anyway');
  // bytes that aren't text, or a sign-in for another site, need "i understand" here too, not only in the window
  if (r.kind === 'evmMessage' && (r.messageView.text == null || r.messageView.problems?.length) && !ignoreRisk) throw fail('this message carries a danger: tick "i understand" to sign it anyway');
  if (r.kind === 'evmTx') {
    // always previewed first (it fixes the gas and fees that get signed); one that couldn't be read is a danger too
    const p = await approvalPreview(id).then((list) => list?.[0], () => null);
    if (!ignoreRisk && (!p || p.warnings?.some((w) => w.level === 'danger'))) throw fail('this transaction carries a danger: tick "i understand" to send it anyway');
  }
  if (r.chain === 'btc') await btcSite.check(r, ignoreRisk);
  pending.delete(id);
  try {
    const result = await perform(r);
    r.resolve(result);
    return { done: true, result: r.kind === 'signAndSend' || r.kind === 'evmTx' ? result : undefined };
  } catch (e) {
    r.reject(fail(e.message));
    throw e;
  }
}

/** What approving does, per kind. */
async function perform(r) {
  if (r.chain === 'btc') return btcSite.perform(r);
  if (r.kind === 'connect') {
    await trust(r.origin, r.account);
    return [r.account];
  }
  if (r.kind === 'sign') {
    const out = [];
    for (const b64 of r.txs) out.push(b64encode(await signTx(b64decode(b64), r.account)));
    return out;
  }
  if (r.kind === 'signAndSend') {
    const { rpc, network } = await net(r.network);
    const sigs = [];
    for (const b64 of r.txs) {
      const signed = await signTx(b64decode(b64), r.account);
      sigs.push(await sendSigned(signed, { rpc, network, options: r.options }));
    }
    return sigs;
  }
  if (r.kind === 'message') {
    const sig = await W.signSolAs(r.account, r.messageBytes);
    return { signature: b64encode(sig), signedMessage: b64encode(r.messageBytes) };
  }
  if (r.kind === 'signIn') {
    const bytes = utf8(r.signInView.text);
    const sig = await W.signSolAs(r.account, bytes);
    return { address: r.account, signature: b64encode(sig), signedMessage: b64encode(bytes) };
  }
  if (r.kind === 'evmConnect') {
    await trust(r.origin, r.account, 'eth');
    return [r.account];
  }
  if (r.kind === 'evmMessage') return E.sigHex(await W.signEthAs(r.account, E.personalDigest(r.messageBytes)));
  if (r.kind === 'evmTyped') return E.sigHex(await W.signEthAs(r.account, E.typedDigest(r.typed)));
  if (r.kind === 'evmTx') return sendEth(r.account, r.call, r.signWith, networkByKey(r.network) ?? MAINNET);
  throw fail('unknown request');
}

async function signTx(bytes, address) {
  const t = readTx(bytes);
  const sig = await W.signSolAs(address, t.message);
  return withSignature(t.bytes, address, sig);
}

/* ------------------------------------------------------------ sending, and following a transaction until it lands */

const sent = new Map(); // id (signature, hash, txid) -> { chain, status, network, at, error }

/** Send a signed Solana transaction; returns its signature (base58) and keeps re-sending until it lands or expires. */
async function sendSigned(bytes, { rpc, network, options = {} }) {
  const b64 = b64encode(bytes);
  const signature = await rpc.send(b64, { skipPreflight: !!options.skipPreflight, preflightCommitment: options.preflightCommitment || 'confirmed', maxRetries: 0 });
  sent.set(signature, { chain: 'sol', status: 'sent', network, at: Date.now() });
  follow(signature, b64, rpc).catch(() => {});
  return signature;
}

async function follow(signature, b64, rpc) {
  const until = Date.now() + 75_000;
  let lastSend = Date.now();
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    let st = null;
    try { [st] = await rpc.statuses([signature]); } catch { continue; }
    if (st?.err) { sent.set(signature, { ...sent.get(signature), status: 'failed', error: JSON.stringify(st.err) }); return; }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { sent.set(signature, { ...sent.get(signature), status: 'confirmed' }); return; }
    if (Date.now() - lastSend > 4000) {
      lastSend = Date.now();
      rpc.send(b64, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
  sent.set(signature, { ...sent.get(signature), status: 'expired' });
}

/** Follow an Ethereum or Bitcoin send until it's in a block (or we stop looking). */
async function followOther(chain, id, net = MAINNET) {
  const urls = chain === 'eth' ? await ethUrls(net) : null;
  const until = Date.now() + (chain === 'eth' ? 180_000 : 1_800_000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, chain === 'eth' ? 4000 : 20_000));
    let st;
    try { st = chain === 'eth' ? await E.txStatus(urls, id) : await B.txStatus(id); } catch { continue; }
    if (st !== 'pending') { sent.set(id, { ...sent.get(id), status: st }); return; }
  }
}

/* ------------------------------------------------------------ requests from Solana pages */

function decodeTxs(list, owner) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_TXS) throw fail(`send between 1 and ${MAX_TXS} transactions`);
  return list.map((b64) => {
    if (typeof b64 !== 'string' || b64.length > Math.ceil(MAX_V1_TX_BYTES / 3) * 4) throw fail('a transaction is malformed');
    const bytes = b64decode(b64);
    if (bytes.length > maxTxBytes(bytes)) throw fail(`a transaction is ${bytes.length} bytes, more than the ${maxTxBytes(bytes)} Solana allows`);
    let t;
    try { t = readTx(bytes); } catch (e) { throw fail(`Plum can't read this transaction: ${e.message}`); }
    if (!signersOf(t).includes(owner)) throw fail("this transaction doesn't ask for the connected account's signature");
    return b64;
  });
}

const OFFCHAIN = Uint8Array.of(0xff, ...utf8('solana offchain'));
const startsWithBytes = (a, b) => a.length >= b.length && b.every((x, i) => a[i] === x);

/** Readable text: valid UTF-8 with nothing hidden in it (newlines and tabs are fine). */
function readable(bytes) {
  const text = readUtf8(bytes);
  return text != null && !hasHidden(text) ? text : null;
}

/**
 * Why plum won't sign these bytes as a message, or null. It fails closed: anything that is, or begins like, a
 * transaction is refused, and so is binary that starts like a newer transaction version plum can't read yet.
 */
export function messageRefusal(bytes) {
  if (startsWithBytes(bytes, OFFCHAIN)) return null; // Solana's off-chain message format: never a transaction
  if (isTransactionShaped(bytes) || startsLikeTransaction(bytes)) return 'Plum refuses to sign this message: its bytes are (or begin like) a transaction, so signing it could move your funds';
  if (readable(bytes) == null && bytes[0] >= 0x80) return "Plum refuses to sign this message: it isn't text, and it begins like a newer kind of transaction";
  return null;
}

function messageView(bytes) {
  return { text: readable(bytes), hex: hex(bytes.subarray(0, 512)), bytes: bytes.length };
}

const SIWS_FIELDS = ['domain', 'address', 'statement', 'uri', 'version', 'chainId', 'nonce', 'issuedAt', 'expirationTime', 'notBefore', 'requestId'];

/** Sign In With Solana: the message text (exactly as the standard writes it) and anything wrong with it. */
export function signInMessage(input, { origin, address }) {
  const host = new URL(origin).host;
  const i = { ...(input ?? {}) };
  const problems = [];
  for (const k of SIWS_FIELDS) {
    if (i[k] == null) continue;
    if (typeof i[k] !== 'string' || i[k].length > 1000 || /[\r\n]/.test(i[k]) || hasHidden(i[k])) throw fail(`the sign-in's ${k} is malformed`);
  }
  if (i.resources != null && (!Array.isArray(i.resources) || i.resources.length > 20 || i.resources.some((r) => typeof r !== 'string' || r.length > 500 || /[\r\n]/.test(r) || hasHidden(r)))) {
    throw fail("the sign-in's resources are malformed");
  }
  if (i.address && i.address !== address) throw fail('the sign-in is for a different account');
  i.domain ??= host;
  i.address = address;
  if (i.domain !== host) problems.push(`it signs you in to ${i.domain}, but the site asking is ${host}`);
  if (i.uri) {
    try { if (new URL(i.uri).host !== host) problems.push(`its link points at ${new URL(i.uri).host}, not ${host}`); } catch { problems.push("its link isn't a URL"); }
  }
  let text = `${i.domain} wants you to sign in with your Solana account:\n${i.address}`;
  if (i.statement) text += `\n\n${i.statement}`;
  const fields = [];
  if (i.uri) fields.push(`URI: ${i.uri}`);
  if (i.version) fields.push(`Version: ${i.version}`);
  if (i.chainId) fields.push(`Chain ID: ${i.chainId}`);
  if (i.nonce) fields.push(`Nonce: ${i.nonce}`);
  if (i.issuedAt) fields.push(`Issued At: ${i.issuedAt}`);
  if (i.expirationTime) fields.push(`Expiration Time: ${i.expirationTime}`);
  if (i.notBefore) fields.push(`Not Before: ${i.notBefore}`);
  if (i.requestId) fields.push(`Request ID: ${i.requestId}`);
  if (i.resources?.length) { fields.push('Resources:'); for (const r of i.resources) fields.push(`- ${r}`); }
  if (fields.length) text += `\n\n${fields.join('\n')}`;
  return { text, problems, domain: i.domain };
}

/**
 * Requests that can end in an approval are counted the moment they arrive (before anything is awaited), per site and in
 * all, so a page firing a burst can't slip past the caps while the first ones are still being looked at. A site is the
 * last two labels of the host, so twenty subdomains of one attacker share one allowance.
 */
const SITE_CAP = 5;
const TOTAL_CAP = 20;
const APPROVAL_METHODS = new Set(['connect', 'signTransaction', 'signAndSendTransaction', 'signMessage', 'signIn']);
const EVM_APPROVALS = new Set(['eth_requestAccounts', 'wallet_requestPermissions', 'personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_sendTransaction']);
const busy = new Map(); // site -> requests in progress or waiting
let busyTotal = 0;

export function siteOf(origin) {
  const host = new URL(origin).hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  return host.split('.').slice(-2).join('.');
}

function dappRequest(origin, method, params, ctx) {
  const evmMethod = method === 'evm' && params && typeof params === 'object' && typeof params.method === 'string' ? params.method : null;
  const btcMethod = method === 'btc' && params && typeof params === 'object' && typeof params.method === 'string' ? params.method : null;
  if (method === 'btc' && !btcMethod) return Promise.reject(fail('a request needs a method', -32600));
  const counted = evmMethod ? EVM_APPROVALS.has(evmMethod) : btcMethod ? BTC_APPROVALS.has(btcMethod) : APPROVAL_METHODS.has(method);
  const run = () => (evmMethod ? handleEvm(origin, evmMethod, params.params, ctx) : btcMethod ? btcSite.request(origin, btcMethod, params.params, ctx) : handleRequest(origin, method, params, ctx));
  if (!counted) return run();
  const site = siteOf(origin);
  if ((busy.get(site) ?? 0) >= SITE_CAP) return Promise.reject(fail(`this site already has ${SITE_CAP} requests waiting`, 4100));
  if (busyTotal >= TOTAL_CAP) return Promise.reject(fail(`plum already has ${TOTAL_CAP} requests waiting: answer those first`, 4100));
  busy.set(site, (busy.get(site) ?? 0) + 1);
  busyTotal++;
  const release = () => {
    const n = (busy.get(site) ?? 1) - 1;
    if (n > 0) busy.set(site, n); else busy.delete(site);
    busyTotal--;
  };
  return run().finally(release);
}

async function handleRequest(origin, method, params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  if (method === 'accounts') {
    const a = await activeOn('sol');
    return a && (await trusted(origin, a)) ? [a] : [];
  }
  if (method === 'connect') {
    const w = await W.activeWallet();
    if (!w) {
      if (p.silent) return [];
      await openWelcome({ fromSite: true });
      throw fail('Plum has no wallet yet: finish setting it up, then connect again', 4100);
    }
    const a = w.chains.sol?.address;
    if (!a) {
      if (p.silent) return [];
      throw fail("Plum's active wallet has no Solana address: switch to another wallet in plum, then connect again", 4100);
    }
    const risk = await riskOf(origin);
    if ((await trusted(origin, a)) && risk.level !== 'blocked') {
      await trust(origin, a);
      return [a];
    }
    if (p.silent) return [];
    return approval({ kind: 'connect', origin, risk, account: a, ctx, network: (await getSettings()).network });
  }
  if (method === 'disconnect') {
    // a site that disconnects asks again next time
    await untrust(origin, 'sol');
    return true;
  }

  // everything else: a connected site, asking for the account it was given, on plum's network
  const a = await activeOn('sol');
  if (!a || !(await trusted(origin, a))) throw fail('connect to Plum first', 4100);
  if (p.account !== a) throw fail("that account isn't the one connected (it may have switched): reconnect", 4100);
  const risk = await riskOf(origin);
  const base = { origin, risk, account: a, ctx };

  if (method === 'signTransaction' || method === 'signAndSendTransaction') {
    const txs = decodeTxs(p.transactions, a);
    // the network is plum's, never the page's: a transaction previewed on one network and sent on another could do
    // anything (the same program can behave differently on each)
    const network = (await getSettings()).network;
    if (p.chain != null) {
      const asked = typeof p.chain === 'string' ? networkOfChain(p.chain) : null;
      if (!asked) throw fail(`Plum doesn't know the chain ${String(p.chain).slice(0, 40)}`);
      if (asked !== network) throw fail(`this site wants ${asked}, but plum is on ${network}. Switch networks in plum's settings first.`, 4100);
    }
    const options = method === 'signAndSendTransaction' ? { skipPreflight: !!p.options?.skipPreflight, preflightCommitment: ['processed', 'confirmed', 'finalized'].includes(p.options?.preflightCommitment) ? p.options.preflightCommitment : 'confirmed' } : undefined;
    return approval({ ...base, kind: method === 'signTransaction' ? 'sign' : 'signAndSend', txs, network, options });
  }
  if (method === 'signMessage') {
    if (typeof p.message !== 'string' || p.message.length > MAX_MESSAGE * 1.4) throw fail(`a message can be ${MAX_MESSAGE / 1024} KB at most`);
    const bytes = b64decode(p.message);
    if (!bytes.length || bytes.length > MAX_MESSAGE) throw fail(`a message can be ${MAX_MESSAGE / 1024} KB at most`);
    const refusal = messageRefusal(bytes);
    if (refusal) throw fail(refusal);
    return approval({ ...base, kind: 'message', messageBytes: bytes, messageView: messageView(bytes), network: (await getSettings()).network });
  }
  if (method === 'signIn') {
    const view = signInMessage(p.input, { origin, address: a });
    return approval({ ...base, kind: 'signIn', signInView: view, network: (await getSettings()).network });
  }
  throw fail(`unknown method ${String(method).slice(0, 40)}`);
}

/* ------------------------------------------------------------ requests from Ethereum pages (EIP-1193) */

/** Read-only calls a page may make through plum's RPC (the chain's public data: nothing about you). */
const EVM_READS = new Set(['eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber',
  'eth_getCode', 'eth_getLogs', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_syncing', 'web3_clientVersion', 'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash']);
const evmErr = (message, code) => fail(message, code);

/** Sign-In with Ethereum (EIP-4361) inside a personal_sign: what's wrong with it for the site asking ([] if the text
 * isn't one, or is right). A sign-in for another site is how a phishing page logs in there as you. */
function siweProblems(text, { origin, address }) {
  const m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your Ethereum account:\n(\S+)\n/.exec(text ?? '');
  if (!m) return [];
  const u = new URL(origin);
  const problems = [];
  if (m[2].toLowerCase() !== u.host.toLowerCase()) problems.push(`it signs you in to ${m[2]}, but the site asking is ${u.host}`);
  if (m[1] && `${m[1].toLowerCase()}:` !== u.protocol) problems.push(`it signs you in over ${m[1]}, but the site asking uses ${u.protocol.slice(0, -1)}`);
  if (!E.sameAddress(m[3], address)) problems.push(`it signs in ${m[3]}, not this wallet`);
  const uri = /\nURI: (\S+)/.exec(text)?.[1];
  if (uri) { try { if (new URL(uri).host.toLowerCase() !== u.host.toLowerCase()) problems.push(`its link points at ${new URL(uri).host}, not ${u.host}`); } catch { problems.push("its link isn't a URL"); } }
  return problems;
}

/** personal_sign's message as bytes: 0x hex is bytes, anything else is text. */
function evmMessageBytes(m) {
  if (typeof m !== 'string') throw evmErr('the message must be text or 0x hex', -32602);
  if (/^0x([0-9a-fA-F]{2})*$/.test(m)) return E.fromHex(m);
  return utf8(m);
}

/** A transaction a page wants sent, checked and put in plum's terms: { to, value, data, gas } (the nonce and fees are
 * always plum's own, and so is the network: the one the site is on). */
function evmCall(tx, from, net = MAINNET) {
  if (!tx || typeof tx !== 'object') throw evmErr('the transaction is malformed', -32602);
  if (tx.from != null && !E.sameAddress(tx.from, from)) throw evmErr("that transaction is from an address that isn't the one connected", 4100);
  if (tx.chainId != null) {
    const asked = networkById(tx.chainId);
    if (asked !== net) throw evmErr(`this transaction is for ${asked ? `${asked.title} (chain ${asked.id})` : `chain ${String(tx.chainId).slice(0, 20)}`}, but this site is on ${net.title} (chain ${net.id}): switch networks in the site first`, 4901);
  }
  const to = tx.to == null || tx.to === '' ? null : E.checkAddress(String(tx.to));
  const num = (v, what) => { try { const n = v == null ? 0n : BigInt(v); if (n < 0n) throw new Error(); return n; } catch { throw evmErr(`the transaction's ${what} is malformed`, -32602); } };
  const data = tx.data ?? tx.input ?? '0x';
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + 2 * 128 * 1024) throw evmErr("the transaction's data is malformed", -32602);
  const gas = tx.gas ?? tx.gasLimit;
  return { to, value: num(tx.value, 'value'), data, gas: gas == null ? null : num(gas, 'gas') };
}

async function handleEvm(origin, method, params, ctx) {
  const p = Array.isArray(params) ? params : params == null ? [] : [params];
  // the network this site is on: whatever it asks for now is for that network, and stays so while it waits
  const net = await siteNetwork(origin);
  if (method === 'eth_chainId') return chainHex(net);
  if (method === 'net_version') return String(net.id);
  if (EVM_READS.has(method)) return E.ethRpc(await ethUrls(net), method, p);
  const w = await W.activeWallet();
  const me = w?.chains.eth?.address ?? null;
  if (method === 'eth_accounts') return me && (await trusted(origin, me, 'eth')) ? [me] : [];
  if (method === 'wallet_getPermissions') return me && (await trusted(origin, me, 'eth')) ? [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [me] }] }] : [];
  if (method === 'wallet_revokePermissions') { await untrust(origin, 'eth'); return null; }
  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
    // only the networks plum knows, on its own RPCs: the RPCs, names and explorers a site sends along are never used
    const asked = p[0] && typeof p[0] === 'object' ? p[0].chainId : undefined;
    if (!networkById(asked)) throw evmErr(unsupportedChain(asked), method === 'wallet_switchEthereumChain' ? 4902 : 4200);
    const to = await moveSite(origin, asked);
    // the site's other tabs hear of it too (they ask again and see chainChanged)
    if (to !== net) await broadcast('chainChanged');
    return null;
  }
  if (method === 'eth_sign') throw evmErr('Plum never signs eth_sign: it signs a raw hash blind, which can be a transaction that empties your wallet', 4200);
  if (method === 'eth_signTransaction') throw evmErr("Plum signs transactions only to send them itself (eth_sendTransaction)", 4200);
  if (method === 'eth_signTypedData' || method === 'eth_signTypedData_v1') throw evmErr("Plum signs typed data v3 and v4 only", 4200);
  if (method === 'wallet_watchAsset' || method === 'wallet_sendCalls' || method === 'wallet_getCapabilities') throw evmErr(`Plum doesn't support ${method} yet`, 4200);

  if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') {
    if (!w) {
      await openWelcome({ fromSite: true });
      throw evmErr('Plum has no wallet yet: finish setting it up, then connect again', 4100);
    }
    // (never the wallet's name: this page isn't connected)
    if (!me) throw evmErr("Plum's active wallet has no Ethereum address: switch to another wallet in plum, then connect again", 4100);
    const risk = await riskOf(origin);
    let accounts;
    if ((await trusted(origin, me, 'eth')) && risk.level !== 'blocked') {
      await trust(origin, me, 'eth');
      accounts = [me];
    } else {
      accounts = await approval({ chain: 'eth', kind: 'evmConnect', origin, risk, account: me, ctx, network: net.key });
    }
    return method === 'wallet_requestPermissions' ? [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts }] }] : accounts;
  }

  // everything else signs: a connected site, for the address it was given
  if (!me || !(await trusted(origin, me, 'eth'))) throw evmErr('connect to Plum first', 4100);
  const risk = await riskOf(origin);
  const base = { chain: 'eth', origin, risk, account: me, ctx, network: net.key };

  if (method === 'personal_sign') {
    // [message, address]; some sites send them the other way round
    let [m, a] = p;
    if (E.isEthAddress(m) && !E.isEthAddress(a)) [m, a] = [a, m];
    if (a != null && !E.sameAddress(a, me)) throw evmErr("that message is for an address that isn't the one connected", 4100);
    const bytes = evmMessageBytes(m);
    if (!bytes.length || bytes.length > MAX_MESSAGE) throw evmErr(`a message can be ${MAX_MESSAGE / 1024} KB at most`, -32602);
    const view = messageView(bytes);
    return approval({ ...base, kind: 'evmMessage', messageBytes: bytes, messageView: { ...view, problems: siweProblems(view.text, { origin, address: me }) } });
  }
  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
    let [a, data] = p;
    if (!E.isEthAddress(a) && E.isEthAddress(data)) [a, data] = [data, a];
    if (!E.sameAddress(a, me)) throw evmErr("that signature is for an address that isn't the one connected", 4100);
    let typed;
    try { typed = E.parseTypedData(data); E.typedDigest(typed); } catch (e) { throw evmErr(e.message, -32602); }
    // the domain as it's hashed: only the fields its EIP712Domain type names (anything else in it isn't signed)
    const signed = (k) => typed.types.EIP712Domain.some((f) => f.name === k);
    const d = Object.fromEntries(Object.entries(typed.domain ?? {}).filter(([k]) => signed(k)));
    // a bare EIP712Domain signs the domain alone, so that's what's listed
    const { lines, more, cut } = E.typedLines(typed.primaryType === 'EIP712Domain' ? { ...typed, message: typed.domain } : typed);
    const view = {
      primaryType: typed.primaryType,
      domain: { name: d.name != null ? String(d.name).slice(0, 60) : null, version: d.version != null ? String(d.version).slice(0, 20) : null, chainId: d.chainId != null ? String(d.chainId).slice(0, 20) : null, contract: typeof d.verifyingContract === 'string' ? d.verifyingContract : null },
      lines,
      warnings: E.typedWarnings(typed, { owner: me, chainId: net.id }),
    };
    if (typeof d.name === 'string' && hasHidden(d.name)) view.warnings.push({ level: 'danger', text: 'its name hides characters that change what you read' });
    // what you sign is what you see: anything plum can't show you counts as a danger
    if (more) view.warnings.push({ level: 'danger', text: `it holds ${more} more fields than plum can show: you'd be signing what you haven't read` });
    if (cut) view.warnings.push({ level: 'danger', text: `${cut} of its values ${cut === 1 ? 'is' : 'are'} longer than plum can show, or ${cut === 1 ? 'hides' : 'hide'} characters: you'd be signing what you haven't read` });
    if (!signed('chainId')) view.warnings.push({ level: 'warn', text: "it isn't tied to a chain: the same signature works on every chain its contract is on" });
    return approval({ ...base, kind: 'evmTyped', typed, typedView: view });
  }
  if (method === 'eth_sendTransaction') {
    const call = evmCall(p[0], me, net);
    const decoded = E.decodeCall(call.data);
    return approval({ ...base, kind: 'evmTx', call, txView: { to: call.to, value: call.value.toString(), data: call.data.length > 2 ? `${call.data.slice(0, 10)}... (${(call.data.length - 2) / 2} bytes)` : null, call: decoded ? { name: decoded.name ?? null, selector: decoded.selector } : null } });
  }
  throw evmErr(`Plum doesn't support ${String(method).slice(0, 40)}`, 4200);
}

/** What a page's Ethereum transaction would do, for the approval window: simulated on the latest block when an RPC can
 * (what changes in your wallet, the approvals it gives), its call read, its fee, and every danger in words. */
async function evmPreview(owner, call, net = MAINNET) {
  const urls = await ethUrls(net);
  const coin = net.native.symbol;
  const warnings = [];
  const decoded = E.decodeCall(call.data);
  // the gas limit and fees plum will sign with, first: the simulation runs that transaction, and it's what gets signed
  const fees = await E.feeQuote(urls, net).catch(() => null);
  let gas = null;
  try { gas = await gasLimit(urls, owner, call); } catch { gas = null; }
  let sim = null;
  try { sim = await E.simulate(urls, owner, { ...call, gas, fees }); } catch (e) { warnings.push({ level: 'danger', text: `plum couldn't simulate this: ${e.message}` }); }
  if (!gas && sim?.gasUsed) gas = (sim.gasUsed * 13n) / 10n;
  const tokens = [...new Set([...(sim?.changes ?? []).map((c) => c.token).filter(Boolean), ...(sim?.approvals ?? []).map((a) => a.token)])];
  const meta = tokens.length ? await E.describeTokens(urls, tokens.map((t) => E.checkAddress(t)), net) : new Map();
  const label = (t) => { const m = meta.get(t ? E.checkAddress(t) : null); return m?.symbol ? (m.price ? m.symbol : `${m.symbol} (${short(t, 6)})`) : short(t ?? '', 6); };
  const changes = (sim?.changes ?? []).map((c) => {
    if (!c.token) return { symbol: coin, decimals: 18, delta: c.delta.toString(), verified: true };
    const m = meta.get(E.checkAddress(c.token));
    return { symbol: label(c.token), decimals: m?.decimals ?? 0, delta: c.delta.toString(), verified: !!m?.price, token: c.token };
  });
  if (sim && !sim.ok) warnings.push({ level: 'danger', text: `this transaction would fail (${sim.error}): sending it can only cost you the fee` });
  if (!sim) warnings.push({ level: 'warn', text: `this wasn't simulated: plum's ${net.title} RPC can't simulate it, so what changes in your wallet isn't shown. Read what it calls below.` });
  // the coin only leaves your wallet as the transaction's own value: if the simulation traced none, show that value
  // leaving rather than "no change"
  if (sim?.ok && call.value > 0n && !sim.native) {
    changes.unshift({ symbol: coin, decimals: 18, delta: (-call.value).toString(), verified: true });
    warnings.push({ level: 'warn', text: `plum's RPC didn't trace ${coin}, so the ${coin} shown leaving is the transaction's own value (anything it sends back isn't shown)` });
  }
  for (const a of sim?.approvals ?? []) {
    if (a.nft != null) continue;
    if (a.item != null) { warnings.push({ level: 'warn', text: `it lets ${a.spender} take #${a.item.slice(0, 20)} of ${label(a.token)} from your wallet.` }); continue; }
    if (a.permit2) { warnings.push({ level: 'danger', text: `a Permit2 approval: it lets ${a.spender} move ${a.unlimited ? 'all of your' : 'some of your'} ${label(a.token)} without asking you again. Drainers ask for exactly this.` }); continue; }
    if (a.all) warnings.push({ level: 'danger', text: `it lets ${a.spender} take every item you hold in ${label(a.token)}, now and later. Drainers ask for exactly this.` });
    else if (a.unlimited) warnings.push({ level: 'danger', text: `it lets ${a.spender} spend all of your ${label(a.token)}, now and later, without asking you again.` });
    else warnings.push({ level: 'warn', text: `it lets ${a.spender} spend some of your ${label(a.token)} without asking you again.` });
  }
  for (const a of sim?.approvals ?? []) if (a.nft != null) warnings.push({ level: a.out ? 'warn' : 'info', text: `${a.out ? 'an NFT leaves' : 'an NFT comes into'} your wallet: ${a.amount && a.amount !== '1' ? `${a.amount.slice(0, 20)} of ` : ''}#${a.nft.slice(0, 20)} of ${label(a.token)}` });
  // what the call itself says, whenever the simulation showed no approval (none ran, or the approval came in a shape
  // its reader doesn't know)
  if (decoded?.name && !(sim?.approvals ?? []).some((a) => a.nft == null)) {
    if (decoded.name === 'setApprovalForAll' && decoded.args?.[1] === true) warnings.push({ level: 'danger', text: `it lets ${decoded.args[0]} take every item you hold in that collection, now and later.` });
    if ((decoded.name === 'approve' || decoded.name === 'increaseAllowance') && decoded.args) warnings.push({ level: decoded.args[1] >= (1n << 255n) ? 'danger' : 'warn', text: `it lets ${decoded.args[0]} spend ${decoded.args[1] >= (1n << 255n) ? 'all of your' : 'some of your'} tokens of ${short(call.to, 6)} without asking you again.` });
    if (decoded.name === 'approve (Permit2)') warnings.push({ level: 'danger', text: `a Permit2 approval: it lets ${decoded.args?.[1] ?? 'a spender'} move your tokens without asking you again.` });
  }
  if (!call.to) warnings.push({ level: 'warn', text: 'this deploys a new contract from your wallet' });
  // an OP Stack network adds a fee for the transaction's room on Ethereum
  const l1 = fees && gas ? (await E.l1Fee(urls, { nonce: 0n, maxPriorityFeePerGas: fees.tip, maxFeePerGas: fees.maxFee, gas, to: call.to, value: call.value, data: call.data }, net)) ?? 0n : 0n;
  const fee = fees && gas ? { est: (gas * (fees.base + fees.tip) + l1).toString(), max: (gas * fees.maxFee + l1).toString(), gas: gas.toString() } : null;
  return {
    chain: 'eth',
    net: { key: net.key, title: net.title, symbol: coin },
    sim: { ok: sim ? sim.ok : null, error: sim?.error ?? null },
    changes, warnings, fee,
    call: { to: call.to, value: call.value.toString(), name: decoded?.name ?? (call.data.length > 2 ? `0x${decoded?.selector ?? call.data.slice(2, 10)}` : null), bytes: (call.data.length - 2) / 2 },
    signWith: fees && gas ? { gas, fees } : null,
  };
}

/** The gas limit to sign: plum's own estimate with room to spare. A site's own limit is used only within reason (up to
 * twice the estimate), or when the chain can't estimate it at all. */
async function gasLimit(urls, from, call) {
  let est = null;
  try { est = BigInt(await E.ethRpc(urls, 'eth_estimateGas', [{ from, to: call.to ?? undefined, value: E.qty(call.value), data: call.data }])); } catch (e) {
    if (!call.gas) throw fail(`this transaction would fail: ${e.message}`);
  }
  if (est == null) return call.gas;
  const ours = (est * 12n) / 10n;
  if (call.gas && call.gas > ours) return call.gas < est * 2n ? call.gas : est * 2n;
  return ours;
}

/** Sign and send an Ethereum transaction from one of your wallets, on a network: plum sets the nonce and the fee, the
 * wallet's key is its only signer (checked by recovering the sender from the signature), MEV Blocker first on
 * Ethereum. */
async function sendEth(from, call, reviewed = null, net = MAINNET) {
  const urls = await ethUrls(net);
  const [nonceHex, fees, gas] = await Promise.all([E.ethRpc(urls, 'eth_getTransactionCount', [from, 'pending']), E.feeQuote(urls, net), gasLimit(urls, from, call)]);
  if (reviewed) {
    // the gas limit and fee cap you reviewed are the ones signed, while the chain still agrees with them
    if (gas > reviewed.gas) throw fail('this transaction needs more gas than when you reviewed it: reject it and ask again');
    if (fees.base > reviewed.fees.maxFee) throw fail('the network fee has risen past what you reviewed: reject it and ask again');
  }
  const use = reviewed ?? { gas, fees };
  const tx = { chainId: net.id, nonce: BigInt(nonceHex), maxPriorityFeePerGas: use.fees.tip, maxFeePerGas: use.fees.maxFee, gas: use.gas, to: call.to, value: call.value, data: call.data };
  return signAndSendEth(from, tx);
}

/** Sign a transaction (its chainId says which network) with your key alone, and send it there. */
async function signAndSendEth(from, tx) {
  const net = networkById(tx.chainId ?? MAINNET.id);
  if (!net) throw fail("plum doesn't work on that network; nothing was signed");
  const digest = E.txDigest(tx);
  const sig = await W.signEthAs(from, digest);
  if (E.signerOf(digest, sig) !== from) throw fail('plum signed with the wrong key; nothing was sent');
  const raw = E.signedTx(tx, sig);
  const hash = await E.sendRaw(raw, await sendUrls(net));
  sent.set(hash, { chain: 'eth', net: net.key, status: 'sent', at: Date.now() });
  followOther('eth', hash, net).catch(() => {});
  return hash;
}

/* ------------------------------------------------------------ requests from Bitcoin pages (btc-site.js) */

const btcSite = bitcoinSites({
  approval, trusted, trust, untrust, riskOf, openWelcome, version: VERSION,
  track: (txid) => { sent.set(txid, { chain: 'btc', status: 'sent', at: Date.now() }); followOther('btc', txid).catch(() => {}); },
});

function onConnect(port) {
  if (port.name !== 'plum-page') { port.disconnect(); return; }
  const s = port.sender;
  let origin = null;
  try {
    const u = new URL(s.url);
    if (s.id === ext().runtime.id && s.tab && s.frameId === 0 && (u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.hostname)))) origin = u.origin;
  } catch { /* no url */ }
  if (!origin) { port.disconnect(); return; }
  const ctx = { owned: new Set(), closed: false };
  const reply = (m) => { try { port.postMessage(m); } catch { /* the page is gone */ } };
  port.onMessage.addListener(async (m) => {
    if (!m || m.ping) return;
    if (typeof m.id !== 'string' || m.id.length > 64 || typeof m.method !== 'string') return;
    try {
      reply({ id: m.id, result: toWire(await dappRequest(origin, m.method, boundedCopy(m.params), ctx)) });
    } catch (e) {
      reply({ id: m.id, error: { message: e.message || 'Plum hit an error', code: e.code ?? -32603 } });
    }
  });
  port.onDisconnect.addListener(() => {
    ctx.closed = true;
    for (const id of ctx.owned) {
      const r = pending.get(id);
      if (r) { pending.delete(id); r.reject(fail('the page closed')); }
    }
  });
}
/** Bigints don't cross into the page (structured clone carries them, JSON doesn't): as hex quantities. */
const toWire = (v) => (typeof v === 'bigint' ? E.qty(v) : v);

/**
 * A page's params as a plain copy, refused past 20,000 values or 1 MB of text. Firefox carries structured clones from
 * the page, which keep shared references: a message of a few small arrays can name one array millions of times, and
 * anything that walks or serializes it (a JSON request to the RPC, a typed-data hash) pays for every one.
 */
function boundedCopy(v, budget = { values: 20_000, chars: 1 << 20 }) {
  if (--budget.values < 0) throw fail('that request is too large', -32602);
  if (typeof v === 'string' && (budget.chars -= v.length) < 0) throw fail('that request is too large', -32602);
  if (Array.isArray(v)) return v.map((x) => boundedCopy(x, budget));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, boundedCopy(x, budget)]));
  return v;
}

/** Setting plum up happens in its own popup; when a site asks before there's a wallet (or on install), plum opens that
 * popup in a little window of its own. One at a time, and a site can bring it up at most once every 30 seconds. */
let welcomeWindow = null;
let welcomeAskedAt = 0;
async function openWelcome({ fromSite = false } = {}) {
  if (fromSite && Date.now() - welcomeAskedAt < 30_000) return;
  if (fromSite) welcomeAskedAt = Date.now();
  if (welcomeWindow != null) {
    try { await ext().windows.update(welcomeWindow, { focused: true }); return; } catch { welcomeWindow = null; }
  }
  try {
    const win = await ext().windows.create({ url: ext().runtime.getURL('popup.html?window=1'), type: 'popup', width: 400, height: 640 });
    welcomeWindow = win.id;
  } catch { /* no window: the toolbar button still works */ }
}

/* ------------------------------------------------------------ your own sends and swaps */

const prepared = new Map(); // id -> { chain, ..., at }

function keep(entry) {
  for (const [k, v] of prepared) if (Date.now() - v.at > 120_000) prepared.delete(k);
  const id = newId();
  prepared.set(id, { ...entry, at: Date.now() });
  return id;
}

/** A priority price (micro-lamports a unit) from recent fees on these accounts: the 75th percentile, kept sensible. */
async function priorityPrice(rpc, writable) {
  try {
    const fees = (await rpc.priorityFees(writable)).map((f) => f.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
    const p75 = fees.length ? fees[Math.floor(fees.length * 0.75)] : 0;
    return BigInt(Math.min(Math.max(p75, 10_000), 2_000_000));
  } catch {
    return 50_000n;
  }
}

/** Build a legacy transaction for `payer` (a v1 one when it won't fit legacy's 1232 bytes), measure it, and set its
 * compute limit to what it uses. */
async function buildOwn(rpc, payer, instructions) {
  const price = await priorityPrice(rpc, [...new Set(instructions.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey)))]);
  const legacy = (units, blockhash) => unsignedTx(compileLegacy({ payer, blockhash, instructions: [ix.unitLimit(units), ix.unitPrice(price), ...instructions] }));
  // v1 carries its budget in its header, the priority fee as whole lamports
  const v1 = (units, blockhash) => unsignedTx(compileV1({ payer, blockhash, instructions, config: { computeUnitLimit: units, priorityFee: (BigInt(units) * price + 999_999n) / 1_000_000n, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 } }));
  let { blockhash } = await rpc.latestBlockhash();
  const make = legacy(200_000, blockhash).length > MAX_TX_BYTES ? v1 : legacy;
  let trial = await rpc.simulate(b64encode(make(200_000, blockhash)));
  // a heavier one (a programmable NFT's transfer) is measured again with all the room there is
  if (/ComputationalBudgetExceeded|exceeded CUs/.test(`${JSON.stringify(trial.err ?? '')}\n${(trial.logs ?? []).join('\n')}`)) trial = await rpc.simulate(b64encode(make(1_400_000, blockhash)));
  const units = trial.err || !trial.unitsConsumed ? 200_000 : Math.ceil(trial.unitsConsumed * 1.2) + 300;
  ({ blockhash } = await rpc.latestBlockhash());
  const bytes = make(units, blockhash);
  const t = readTx(bytes);
  // plum's own transactions: one signer, you, who also pays the fee
  if (t.required !== 1 || t.keys[0] !== payer) throw fail('plum built a transaction with the wrong signers; nothing was signed');
  return bytes;
}

/** Addresses you've sent to from plum, per chain (newest first). */
async function recents() {
  const r = await local.get('recents', {});
  return Array.isArray(r) ? { sol: r } : r;
}
async function remember(chain, to) {
  const all = await recents();
  const list = (all[chain] ?? []).filter((a) => a.toLowerCase() !== to.toLowerCase());
  await local.set({ recents: { ...all, [chain]: [to, ...list].slice(0, 50) } });
}

/** Warnings about where a send goes: a new address, a lookalike of one you've used (address poisoning), yourself. */
async function recipientChecks(chain, to, from) {
  const out = [];
  const past = (await recents())[chain] ?? [];
  // (a wallet's bc1p address is its own too)
  const own = (await W.wallets()).flatMap((w) => [w.chains[chain]?.address, chain === 'btc' ? w.chains.btc?.taproot?.address : null]).filter(Boolean);
  const norm = (a) => (chain === 'sol' ? a : a.toLowerCase());
  const known = [...new Set([...past, ...own].map(norm))];
  const head = chain === 'eth' ? 6 : chain === 'btc' ? 7 : 4;
  const t = norm(to);
  if (!known.includes(t)) {
    const twin = known.find((k) => k.slice(0, head) === t.slice(0, head) && k.slice(-4) === t.slice(-4));
    if (twin) out.push({ level: 'danger', text: `this looks like ${short(twin, head)}, an address you've used, but it is a different one. Scammers plant lookalike addresses in your history: check every character.` });
    else out.push({ level: 'info', text: "you haven't sent to this address from plum before" });
  }
  if (t === norm(from)) out.push({ level: 'warn', text: "that's the wallet you're sending from" });
  return out;
}

async function prepareSend(params) {
  const chain = params.chain ?? 'sol';
  if (chain === 'eth') return prepareEthSend(params);
  if (chain === 'btc') return prepareBtcSend(params);
  return prepareSolSend(params);
}

async function prepareSolSend({ mint, token, to, amount }) {
  mint = mint ?? token ?? null;
  const { address: from } = await requireActive('sol');
  const { rpc, network } = await net();
  if (!isAddress(to)) throw fail("that isn't a Solana address");
  const warnings = await recipientChecks('sol', to, from);
  const [dest] = await rpc.accounts([to]);
  if (dest?.executable) throw fail("that address is a program: sending to it would lose the funds");
  let instructions, symbol, decimals, raw;
  if (!mint || mint === 'SOL') {
    decimals = 9;
    symbol = 'SOL';
    raw = parseUnits(amount, 9);
    if (raw <= 0n) throw fail('type an amount above zero');
    if (!dest && raw < RENT_EXEMPT_EMPTY) throw fail(`a new address needs at least ${formatUnits(RENT_EXEMPT_EMPTY, 9)} SOL to open`);
    if (dest && (dest.owner === TOKEN_PROGRAM || dest.owner === TOKEN_2022_PROGRAM)) warnings.push({ level: 'danger', text: "that address is a token account, not a wallet: SOL sent there can't easily be got back" });
    instructions = [ix.transfer(from, to, raw)];
  } else {
    if (!isAddress(mint)) throw fail('that token is malformed');
    const held = await rpc.call('getTokenAccountsByOwner', [from, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const sources = held.value.map((v) => ({ address: v.pubkey, program: v.account.owner, info: v.account.data.parsed.info })).sort((x, y) => (BigInt(y.info.tokenAmount.amount) > BigInt(x.info.tokenAmount.amount) ? 1 : -1));
    if (!sources.length) throw fail("you don't hold this token");
    const src = sources[0];
    decimals = src.info.tokenAmount.decimals;
    raw = parseUnits(amount, decimals);
    if (raw <= 0n) throw fail('type an amount above zero');
    if (raw > BigInt(src.info.tokenAmount.amount)) throw fail(`you have ${formatUnits(src.info.tokenAmount.amount, decimals)} in your account`);
    if (src.info.state === 'frozen') throw fail('your account for this token is frozen by its issuer');
    let target;
    if (dest && (dest.owner === TOKEN_PROGRAM || dest.owner === TOKEN_2022_PROGRAM)) {
      const parsed = await rpc.call('getAccountInfo', [to, { encoding: 'jsonParsed' }]);
      const info = parsed.value?.data?.parsed?.info;
      if (!info || info.mint !== mint) throw fail("that address is an account for a different token");
      target = to;
      warnings.push({ level: 'warn', text: `you're sending into a token account directly (it belongs to ${short(info.owner)})` });
      instructions = [ix.transferChecked(src.address, mint, target, from, raw, decimals, src.program)];
    } else {
      if (!isOnCurve(base58Decode(to))) warnings.push({ level: 'danger', text: "this address belongs to a program, not a person's wallet. Only send if you know it can hold tokens (a Squads vault can)." });
      target = associatedTokenAddress(to, mint, src.program);
      instructions = [ix.createAtaIdempotent(from, target, to, mint, src.program), ix.transferChecked(src.address, mint, target, from, raw, decimals, src.program)];
    }
    const info = network === 'mainnet' ? (await tokenInfo([mint], await jupOpts()).catch(() => new Map())).get(mint) : null;
    symbol = info?.symbol ?? short(mint);
  }
  const bytes = await buildOwn(rpc, from, instructions);
  const preview = await previewTx(bytes, { owner: from, rpc, meta: namer(network) });
  const id = keep({ chain: 'sol', bytes, network, account: from, kind: 'send', recipient: to });
  return { id, chain: 'sol', preview, warnings, to, amount: formatUnits(raw, decimals), symbol, mint: mint || null, network };
}

/** ERC-20 balanceOf(owner). */
async function erc20Balance(urls, token, owner) {
  const r = await E.ethRpc(urls, 'eth_call', [{ to: token, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']);
  return BigInt(r && r !== '0x' ? r : '0x0');
}

/** When an OP Stack network's fee oracle doesn't answer: a fee for the room on Ethereum far above what it costs. */
const L1_FEE_GUESS = 10_000_000_000_000n;

async function prepareEthSend({ token, mint, to, amount, max = false, net: netKey = null }) {
  token = token ?? mint ?? null;
  const net = networkByKey(netKey) ?? MAINNET;
  const coin = net.native.symbol;
  const { address: from } = await requireActive('eth');
  const urls = await ethUrls(net);
  const dest = E.checkAddress(to);
  const warnings = await recipientChecks('eth', dest, from);
  const [code, weiHex, fees, nonceHex] = await Promise.all([
    E.ethRpc(urls, 'eth_getCode', [dest, 'latest']),
    E.ethRpc(urls, 'eth_getBalance', [from, 'latest']),
    E.feeQuote(urls, net),
    E.ethRpc(urls, 'eth_getTransactionCount', [from, 'pending']),
  ]);
  const wei = BigInt(weiHex);
  let call, raw, decimals, symbol;
  if (token) {
    const t = E.checkAddress(token);
    decimals = await E.tokenDecimals(urls, t);
    const held = await erc20Balance(urls, t, from);
    raw = max ? held : parseUnits(amount, decimals);
    if (raw <= 0n) throw fail(max ? "you don't hold any of this token" : 'type an amount above zero');
    if (raw > held) throw fail(`you have ${formatUnits(held, decimals)} of it`);
    symbol = (await E.tokenMeta(t, net)).symbol ?? short(t, 6);
    if (dest.toLowerCase() === t.toLowerCase()) throw fail("that's the token's own contract: tokens sent there are lost");
    call = { to: t, value: 0n, data: E.transferData(dest, raw) };
  } else {
    decimals = 18;
    symbol = coin;
    raw = max ? null : parseUnits(amount, 18);
    if (raw != null && raw <= 0n) throw fail('type an amount above zero');
    call = { to: dest, value: raw ?? 0n, data: '0x' };
  }
  const isContract = typeof code === 'string' && code !== '0x' && code !== '0x0';
  if (isContract && !token) warnings.push({ level: 'warn', text: `that address is a contract, not a person's wallet: only send ${coin} to it if you know it takes ${coin}` });
  if (net !== MAINNET) warnings.push({ level: 'info', text: `this goes out on ${net.title}: check that whoever you send to uses ${net.title} (an exchange's address may only take Ethereum)` });
  let gas;
  // a plain send on Ethereum is always 21,000 gas; elsewhere it's asked (Arbitrum's include its Ethereum data cost)
  if (!token && !isContract && net === MAINNET) gas = 21_000n;
  else {
    try { gas = (BigInt(await E.ethRpc(urls, 'eth_estimateGas', [{ from, to: call.to, value: E.qty(call.value), data: call.data }])) * 125n) / 100n; } catch (e) { throw fail(`this send would fail: ${e.message}`); }
  }
  // what Base charges for the transaction's room on Ethereum (asked with the largest value it could carry)
  const l1 = net.l1Fee ? ((await E.l1Fee(urls, { nonce: BigInt(nonceHex), maxPriorityFeePerGas: fees.tip, maxFeePerGas: fees.maxFee, gas, ...call, value: token ? 0n : wei }, net)) ?? L1_FEE_GUESS) : 0n;
  const feeMax = gas * fees.maxFee + l1 * 2n;
  if (!token && max) {
    // everything but the most the fee can cost
    raw = wei - feeMax;
    if (raw <= 0n) throw fail(`there isn't enough ${coin} to cover the network fee`);
    call.value = raw;
  }
  if (wei < feeMax + (token ? 0n : raw)) throw fail(`not enough ${coin} for this and its network fee: you have ${formatUnits(wei, 18)}, it needs up to ${formatUnits(feeMax + (token ? 0n : raw), 18)}`);
  const tx = { chainId: net.id, nonce: BigInt(nonceHex), maxPriorityFeePerGas: fees.tip, maxFeePerGas: fees.maxFee, gas, ...call };
  const preview = {
    chain: 'eth', net: { key: net.key, title: net.title, symbol: coin }, sim: { ok: true, error: null },
    changes: [{ symbol, decimals, delta: (-raw).toString(), verified: true }],
    fee: { est: (gas * (fees.base + fees.tip) + l1).toString(), max: feeMax.toString(), gas: gas.toString() },
    warnings: [], call: { to: call.to, value: call.value.toString(), name: token ? 'transfer' : null, bytes: (call.data.length - 2) / 2 },
  };
  const id = keep({ chain: 'eth', tx, from, recipient: dest });
  return { id, chain: 'eth', net: net.key, netTitle: net.title, preview, warnings, to: dest, amount: formatUnits(raw, decimals), symbol, mint: token };
}

async function prepareBtcSend({ to, amount, speed = 'normal', max = false }) {
  const { wallet, address: from } = await requireActive('btc');
  const dest = String(to ?? '').trim();
  B.addressScript(dest);
  const warnings = await recipientChecks('btc', dest, from);
  if (dest === wallet.chains.btc.taproot?.address) warnings.push({ level: 'warn', text: "that's this wallet's own taproot address: the bitcoin stays yours, less the fee" });
  const raw = max ? null : parseUnits(amount, 8);
  if (raw != null && raw <= 0n) throw fail('type an amount above zero');
  // coins from both addresses, the ones carrying inscriptions or runes kept out (btc-send.js)
  const owner = ownerOf(wallet);
  const prep = await prepareSpend({ owner, recipients: [{ to: dest, amount: raw ?? 0n }], speed, max });
  warnings.push(...prep.warnings);
  const id = keep({ chain: 'btc', plan: prep.plan, from, owner, recipient: dest });
  return { id, chain: 'btc', preview: prep.preview, warnings, to: dest, amount: formatUnits(prep.plan.amount, 8), symbol: 'BTC', speed };
}

/** The most you can send of something (what you hold, less what the fee could cost). */
async function maxSend({ chain = 'sol', token = null, to = null, speed = 'normal', net: netKey = null }) {
  if (chain === 'eth') {
    const net = networkByKey(netKey) ?? MAINNET;
    const { address: from } = await requireActive('eth');
    const urls = await ethUrls(net);
    if (token) { const t = E.checkAddress(token); return formatUnits(await erc20Balance(urls, t, from), await E.tokenDecimals(urls, t)); }
    const [wei, fees] = await Promise.all([E.ethRpc(urls, 'eth_getBalance', [from, 'latest']).then(BigInt), E.feeQuote(urls, net)]);
    // a plain send's gas, as the send itself will reckon it (Arbitrum's includes its Ethereum data cost), and Base's
    // fee for its room on Ethereum
    const dest = to && E.isEthAddress(to) ? E.checkAddress(to) : from;
    const gas = net === MAINNET ? 21_000n : (BigInt(await E.ethRpc(urls, 'eth_estimateGas', [{ from, to: dest, value: '0x0', data: '0x' }])) * 125n) / 100n;
    const l1 = net.l1Fee ? ((await E.l1Fee(urls, { nonce: 0n, maxPriorityFeePerGas: fees.tip, maxFeePerGas: fees.maxFee, gas, to: from, value: wei, data: '0x' }, net)) ?? L1_FEE_GUESS) * 2n : 0n;
    const left = wei - gas * fees.maxFee - l1;
    return formatUnits(left > 0n ? left : 0n, 18);
  }
  if (chain === 'btc') {
    const { wallet, address: from } = await requireActive('btc');
    const [{ free: coins }, rates] = await Promise.all([spendable(ownerOf(wallet)), B.feeRates()]);
    if (!coins.length) return '0';
    const p = B.plan({ utxos: coins, to: to && B.isBtcAddress(to) ? to : from, amount: 0n, feeRate: rates[speed] ?? rates.normal, change: from, max: true });
    return formatUnits(p.amount, 8);
  }
  throw fail('unknown chain');
}

async function prepareSwap({ quoteId }) {
  const q = quotes.get(quoteId);
  if (!q || Date.now() - q.at > 60_000) throw fail('that quote is old: get a new one');
  const { address: me } = await requireActive('sol');
  if (q.account !== me) throw fail('the wallet changed: get a new quote');
  const { rpc, network } = await net('mainnet');
  const bytes = b64decode(await swapTransaction(q.quote, me, await jupOpts()));
  const t = readTx(bytes);
  // the same rule plum's own sends follow: one signer, you; you pay; nothing signed before you
  if (t.required !== 1 || signersOf(t)[0] !== me) throw fail(`Jupiter's swap asks for ${t.required} signatures; plum only signs swaps you alone sign`);
  if (t.signatures.some(isSigned)) throw fail("Jupiter's swap arrived already signed; plum won't use it");
  if (t.size > maxTxBytes(t.bytes)) throw fail('the swap is too large to send');
  const preview = await previewTx(bytes, { owner: me, rpc, meta: namer(network) });
  // a swap is plum's own request, so there's no "sign anyway": anything wrong with it and plum refuses it outright
  if (!preview.sim.ok) throw fail(`the swap would fail (${preview.sim.error}): get a new quote`);
  // it may only spend what you're swapping (a compromised API could try to take more)
  const inMint = q.quote.inputMint;
  const inAmount = BigInt(q.quote.inAmount);
  for (const tk of preview.tokens) {
    const d = BigInt(tk.delta);
    if (d < 0n && tk.mint !== inMint) throw fail(`Jupiter's swap would also take ${tk.symbol ?? short(tk.mint)} from you; plum refused it`);
    if (d < 0n && -d > inAmount) throw fail("Jupiter's swap would take more than the amount you typed; plum refused it");
  }
  // SOL may go down by the amount (when it's what you pay) plus fees and a few accounts' rent, never more
  const solLimit = (inMint === WSOL_MINT ? inAmount : 0n) + 30_000_000n;
  if (-BigInt(preview.sol) > solLimit) throw fail("Jupiter's swap would take more SOL than the swap and its fees need; plum refused it");
  // and you must get what you're buying
  const gets = q.outputMint === WSOL_MINT ? BigInt(preview.sol) > 0n : BigInt(preview.tokens.find((x) => x.mint === q.outputMint)?.delta ?? 0) > 0n;
  if (!gets) throw fail("the simulation doesn't show you receiving what you're buying; plum refused the swap");
  // no drainer pattern of any kind (a delegate, your wallet handed over...), even with nothing taken right now
  const danger = preview.warnings.find((w) => w.level === 'danger');
  if (danger) throw fail(`plum refused Jupiter's swap: ${danger.text}`);
  const id = keep({ chain: 'sol', bytes, network, account: me, kind: 'swap' });
  return { id, chain: 'sol', preview, warnings: [], network };
}

/** A staking step (stake.js plans it), built and previewed like a send: you alone sign it, and you see it simulated. */
async function prepareStaking(params) {
  const { address: me } = await requireActive('sol');
  const { rpc, network } = await net();
  const { instructions, summary, warnings } = await S.plan(rpc, me, params);
  const bytes = await buildOwn(rpc, me, instructions);
  const preview = await previewTx(bytes, { owner: me, rpc, meta: namer(network) });
  const id = keep({ chain: 'sol', bytes, network, account: me, kind: 'stake' });
  return { id, chain: 'sol', preview, warnings, summary, network };
}

/** Your NFTs on one chain (nfts.js reads them): names and ids only. */
async function nftList({ chain = 'sol' } = {}) {
  if (chain === 'eth') {
    const { address } = await requireActive('eth');
    return { chain, items: await N.listEth(address) };
  }
  const { address } = await requireActive('sol');
  const { rpc, network } = await net();
  return { chain: 'sol', network, ...(await N.listSol(rpc, address)) };
}

/** Sending an NFT: on Solana the transfer its standard takes (nfts.js plans it), built and previewed like a send; on
 * Ethereum safeTransferFrom, simulated like a site's transaction, after the contract says it's yours. */
async function prepareNftSend(params) {
  if (params?.chain === 'eth') return prepareEthNftSend(params);
  const { address: me } = await requireActive('sol');
  const { rpc, network } = await net();
  const { instructions, summary, warnings } = await N.planSolSend(rpc, me, params);
  const bytes = await buildOwn(rpc, me, instructions);
  const preview = await previewTx(bytes, { owner: me, rpc, meta: namer(network) });
  const id = keep({ chain: 'sol', bytes, network, account: me, kind: 'nft', recipient: summary.to });
  return { id, chain: 'sol', preview, warnings: [...(await recipientChecks('sol', summary.to, me)), ...warnings], summary, network };
}

async function prepareEthNftSend({ contract, id, standard, amount = '1', to }) {
  const { address: from } = await requireActive('eth');
  const urls = await ethUrls();
  const token = E.checkAddress(String(contract ?? ''));
  const dest = E.checkAddress(String(to ?? ''));
  if (standard !== 'erc721' && standard !== 'erc1155') throw fail('pick an NFT');
  if (E.sameAddress(dest, from)) throw fail("that's the wallet it's in already");
  if (E.sameAddress(dest, token)) throw fail("that's the NFT's own contract: an NFT sent there is lost");
  let tokenId, count;
  try { tokenId = BigInt(id); count = BigInt(amount); } catch { throw fail('pick an NFT'); }
  if (tokenId < 0n || count <= 0n) throw fail('pick an NFT');
  if (!(await N.ethHolds(urls, { contract: token, id: tokenId, standard, owner: from, amount: count }))) throw fail("this NFT isn't in this wallet any more");
  const call = { to: token, value: 0n, data: standard === 'erc721' ? N.erc721TransferData(from, dest, tokenId) : N.erc1155TransferData(from, dest, tokenId, count), gas: null };
  const { signWith, ...preview } = await evmPreview(from, call);
  if (!signWith) throw fail("plum couldn't work out this transfer's gas and fee: try again");
  const nonce = BigInt(await E.ethRpc(urls, 'eth_getTransactionCount', [from, 'pending']));
  const tx = { nonce, maxPriorityFeePerGas: signWith.fees.tip, maxFeePerGas: signWith.fees.maxFee, gas: signWith.gas, to: call.to, value: 0n, data: call.data };
  const prep = keep({ chain: 'eth', tx, from, recipient: dest });
  return { id: prep, chain: 'eth', preview, warnings: await recipientChecks('eth', dest, from), summary: { standard, id: tokenId.toString(), contract: token, amount: count.toString(), to: dest } };
}

async function submitPrepared({ id }) {
  const p = prepared.get(id);
  if (!p) throw fail('that transaction expired: review it again');
  if (Date.now() - p.at > 75_000) { prepared.delete(id); throw fail('that took too long (its fee and blockhash are about to go stale): review it again'); }
  prepared.delete(id);
  let out;
  if (p.chain === 'eth') {
    const hash = await signAndSendEth(p.from, p.tx);
    const net = networkById(p.tx.chainId ?? MAINNET.id) ?? MAINNET;
    out = { signature: hash, chain: 'eth', net: net.key, explorer: E.explorerTx(hash, net), explorerName: net.explorerName };
  } else if (p.chain === 'btc') {
    const { raw, txid } = await B.signSpend(p.plan, p.owner, (address, digests) => W.signBitcoinAs(address, digests));
    await B.broadcast(raw, txid);
    sent.set(txid, { chain: 'btc', status: 'sent', at: Date.now() });
    followOther('btc', txid).catch(() => {});
    out = { signature: txid, chain: 'btc', explorer: B.explorerTx(txid) };
  } else {
    const { rpc, network } = await net(p.network);
    const signed = await signTx(p.bytes, p.account);
    const signature = await sendSigned(signed, { rpc, network });
    out = { signature, chain: 'sol', explorer: explorerUrl(network, 'tx', signature) };
  }
  if (p.recipient) await remember(p.chain, p.recipient);
  return out;
}

const quotes = new Map();

async function getQuote({ inputMint, outputMint, amount, slippageBps }) {
  const { address: me } = await requireActive('sol');
  if (!isAddress(inputMint) || !isAddress(outputMint)) throw fail('pick both tokens');
  if (inputMint === outputMint) throw fail('pick two different tokens');
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 5000) throw fail('slippage must be between 0.01% and 50%');
  const infos = await tokenInfo([inputMint, outputMint], await jupOpts());
  const inDec = inputMint === WSOL_MINT ? 9 : infos.get(inputMint)?.decimals;
  const outDec = outputMint === WSOL_MINT ? 9 : infos.get(outputMint)?.decimals;
  if (inDec == null || outDec == null) throw fail("Jupiter doesn't know one of these tokens");
  const raw = parseUnits(amount, inDec);
  if (raw <= 0n) throw fail('type an amount above zero');
  const q = await jupQuote({ inputMint, outputMint, amount: raw, slippageBps: bps }, await jupOpts());
  for (const [k] of quotes) if (Date.now() - quotes.get(k).at > 120_000) quotes.delete(k);
  const id = newId();
  quotes.set(id, { quote: q, at: Date.now(), account: me, outputMint });
  return {
    id,
    inAmount: formatUnits(q.inAmount, inDec),
    outAmount: formatUnits(q.outAmount, outDec),
    minOut: formatUnits(q.otherAmountThreshold, outDec),
    priceImpact: Number(q.priceImpactPct ?? 0) * 100,
    route: [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean))].slice(0, 4),
    inSymbol: inputMint === WSOL_MINT ? 'SOL' : infos.get(inputMint)?.symbol,
    outSymbol: outputMint === WSOL_MINT ? 'SOL' : infos.get(outputMint)?.symbol,
  };
}

/* ------------------------------------------------------------ balances and history */

/**
 * One chain's holdings for the active wallet, all in one shape: { chain, address, native: { amount, decimals, symbol,
 * name, price, usd, change24h }, tokens: [{ chain, mint, amount, decimals, symbol, name, verified, price, usd,
 * change24h }], ... }.
 */
async function balances({ chain = 'sol' } = {}) {
  const { wallet, address } = await requireActive(chain);
  if (chain === 'eth') return evmBalances(address);
  if (chain === 'btc') {
    // both addresses' coins: bc1q and bc1p
    const [bal, price] = await Promise.all([B.balanceOf(ownerOf(wallet)), priceOf('btc')]);
    return {
      chain, address, pending: bal.pending.toString(),
      native: { amount: bal.total.toString(), decimals: 8, symbol: 'BTC', name: 'bitcoin', price: price.price, usd: price.price == null ? null : (Number(bal.total) / 1e8) * price.price, change24h: price.change24h },
      tokens: [],
    };
  }
  return solBalances(address);
}

/**
 * An address on every Ethereum network: Ethereum's own ETH as `native`, the other networks' coins in `networks` (each
 * { net, title, tag, symbol, amount, price, usd, change24h, error }), and every network's tokens together, each marked
 * with its network (`net`). Ethereum failing fails the read; another network failing is noted in its own entry.
 */
async function evmBalances(address) {
  const s = await getSettings();
  const [prices, ...per] = await Promise.all([
    Promise.all([priceOf('eth'), priceOf('pol')]),
    ...EVM_NETWORKS.map(async (net) => {
      try { return { net, ...(await E.balances(await ethUrls(net), address, { hideZero: s.hideZero, net })) }; } catch (e) {
        if (net === MAINNET) throw e;
        return { net, error: e.message };
      }
    }),
  ]);
  const coin = ({ net, wei = null, error = null, tokensRead = false }) => {
    const p = net.native.price === 'pol' ? prices[1] : prices[0];
    return {
      net: net.key, title: net.title, tag: net.tag, symbol: net.native.symbol, name: net.native.name, decimals: 18, amount: wei == null ? null : wei.toString(),
      price: p.price, usd: p.price == null || wei == null ? null : (Number(wei) / 1e18) * p.price, change24h: p.change24h, error, tokensRead,
    };
  };
  const [main, ...others] = per.map(coin);
  return {
    chain: 'eth', address,
    native: { amount: main.amount, decimals: 18, symbol: 'ETH', name: 'ethereum', price: main.price, usd: main.usd, change24h: main.change24h },
    networks: others,
    tokens: per.flatMap((r) => r.tokens ?? []).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)),
  };
}

async function solBalances(address) {
  const { rpc, network } = await net();
  const s = await getSettings();
  const [[info], legacy, t22] = await Promise.all([
    rpc.accounts([address]),
    rpc.tokenAccounts(address, TOKEN_PROGRAM),
    rpc.tokenAccounts(address, TOKEN_2022_PROGRAM).catch(() => []),
  ]);
  const lamports = BigInt(info?.lamports ?? 0);
  // a wallet handed to a program (a drainer's Assign) can't pay fees or send any more
  const hijacked = !!info && info.owner !== SYSTEM_PROGRAM;
  const byMint = new Map();
  for (const v of [...legacy, ...t22]) {
    const parsed = v.account.data.parsed?.info;
    if (!parsed) continue;
    const cur = byMint.get(parsed.mint) ?? { mint: parsed.mint, raw: 0n, decimals: parsed.tokenAmount.decimals, program: v.account.owner, accounts: 0 };
    cur.raw += BigInt(parsed.tokenAmount.amount);
    cur.accounts++;
    byMint.set(parsed.mint, cur);
  }
  let list = [...byMint.values()];
  if (s.hideZero) list = list.filter((t) => t.raw > 0n);
  let infos = new Map();
  if (network === 'mainnet') infos = await tokenInfo([WSOL_MINT, ...list.map((t) => t.mint)], { ...(await jupOpts()), fresh: true }).catch(() => new Map());
  const solPrice = infos.get(WSOL_MINT)?.price ?? null;
  const value = (raw, decimals, price) => (price == null ? null : (Number(raw) / 10 ** decimals) * price);
  const tokens = list.map((t) => {
    const i = infos.get(t.mint);
    return {
      chain: 'sol', mint: t.mint, amount: t.raw.toString(), decimals: t.decimals, program: t.program,
      symbol: i?.symbol ?? null, name: i?.name ?? null, verified: !!i?.verified,
      price: i?.price ?? null, usd: value(t.raw, t.decimals, i?.price), change24h: i?.change24h ?? null,
    };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  return {
    chain: 'sol', address, network, hijacked: hijacked ? info.owner : null,
    native: { amount: lamports.toString(), decimals: 9, symbol: 'SOL', name: 'solana', price: network === 'mainnet' ? solPrice : null, usd: network === 'mainnet' ? value(lamports, 9, solPrice) : null, change24h: infos.get(WSOL_MINT)?.change24h ?? null },
    tokens,
  };
}

/** Recent transactions on every Ethereum network, each marked with its network. A network that can't be read is noted
 * in `errors`; Ethereum's own failing fails the chain. */
async function evmActivity(address, errors) {
  const per = await Promise.all(EVM_NETWORKS.map(async (net) => {
    try { return (await E.activity(address, 25, net)).map((x) => ({ ...x, chain: 'eth', net: net.key, tag: net.tag })); } catch (e) {
      if (net === MAINNET) throw e;
      return `${net.name}: ${e.message}`;
    }
  }));
  const failed = per.filter((x) => typeof x === 'string');
  if (failed.length) errors.eth = failed.join(' · ');
  return per.filter(Array.isArray).flat();
}

/** The active wallet's recent transactions on every chain it has, newest first: { items, errors }. */
async function activity() {
  const w = await W.activeWallet();
  if (!w) throw fail('plum has no wallet yet');
  const errors = {};
  const per = await Promise.all(Object.entries(w.chains).map(async ([chain, { address }]) => {
    try {
      if (chain === 'eth') return await evmActivity(address, errors);
      if (chain === 'btc') return (await B.activityOf(ownerOf(w))).map((x) => ({ ...x, chain }));
      const { rpc, network } = await net();
      const list = await rpc.signatures(address, 25);
      return list.map((s) => ({ chain, id: s.signature, time: s.blockTime, ok: !s.err, explorer: explorerUrl(network, 'tx', s.signature), pending: sent.get(s.signature)?.status === 'sent' }));
    } catch (e) {
      errors[chain] = e.message;
      return [];
    }
  }));
  // what plum sent that the indexers haven't seen yet
  const items = per.flat();
  for (const [id, s] of sent) {
    const net = s.chain === 'eth' ? networkByKey(s.net) ?? MAINNET : null;
    if (s.chain !== 'sol' && w.chains[s.chain] && s.status === 'sent' && !items.some((x) => x.id === id)) items.push({ chain: s.chain, id, time: Math.floor(s.at / 1000), ok: true, pending: true, explorer: net ? E.explorerTx(id, net) : B.explorerTx(id), ...(net ? { net: net.key, tag: net.tag } : {}) });
  }
  items.sort((a, b) => (b.pending - a.pending) || ((b.time ?? 0) - (a.time ?? 0)));
  return { items: items.slice(0, 40), errors };
}

/* ------------------------------------------------------------ what a recovery phrase holds (the import picker) */

/** Has an address been used? Solana: SOL on it or any history; Ethereum: a coin on it or a sent transaction, on any of
 * plum's Ethereum networks (the amount is Ethereum's own ETH); Bitcoin: any transaction. Each answers { used, amount }
 * (amount in the chain's smallest unit), or { used: null } if it couldn't be checked. */
async function usage(found) {
  const { rpc } = await net('mainnet');
  const sol = found.map((f) => f.chains.sol?.address).filter(Boolean);
  const solInfo = new Map();
  try {
    const infos = await rpc.accounts(sol);
    sol.forEach((a, i) => solInfo.set(a, BigInt(infos[i]?.lamports ?? 0)));
  } catch { /* offline: unknown */ }
  // Ethereum: every balance and nonce in one batched request per network
  const eth = found.map((f) => f.chains.eth?.address).filter(Boolean);
  const ethInfos = eth.length ? await Promise.all(EVM_NETWORKS.map(async (n) => E.usageOf(await ethUrls(n), eth).catch(() => new Map()))) : [];
  // then each wallet's Solana history (only where it holds no SOL) and Bitcoin, its chains side by side
  const out = await pool(found, 6, async (f) => {
    const res = {};
    const e = f.chains.eth?.address;
    if (e) {
      const all = ethInfos.map((m) => m.get(e));
      const used = all.some((x) => x && (x.wei > 0n || x.nonce > 0n));
      // unused only when every network answered; one that didn't leaves it unknown
      res.eth = { used: used || (all.every(Boolean) ? false : null), amount: (all[0]?.wei ?? 0n).toString() };
    }
    await Promise.all([
      (async () => {
        const s = f.chains.sol?.address;
        if (!s) return;
        const lamports = solInfo.get(s);
        let used = lamports == null ? null : lamports > 0n;
        if (used === false) { try { used = (await rpc.signatures(s, 1)).length > 0; } catch { used = null; } }
        res.sol = { used, amount: (lamports ?? 0n).toString() };
      })(),
      (async () => {
        const b = f.chains.btc?.address;
        if (!b) return;
        try { const x = await B.balanceOf({ segwit: b, taproot: f.chains.btc.taproot?.address }); res.btc = { used: x.txs > 0, amount: x.total.toString() }; } catch { res.btc = { used: null, amount: '0' }; }
      })(),
    ]);
    // the same order every time: sol, eth, btc
    return Object.fromEntries(['sol', 'eth', 'btc'].filter((c) => res[c]).map((c) => [c, res[c]]));
  });
  return found.map((f, i) => {
    const u = out[i];
    const used = Object.values(u).some((c) => c.used);
    return { scheme: f.scheme, index: f.index, chains: Object.fromEntries(Object.entries(f.chains).map(([c, v]) => [c, { address: v.address, path: v.path, ...u[c] }])), used, unknown: Object.values(u).some((c) => c.used == null) };
  });
}

/**
 * The wallets a recovery phrase holds, with which ones have been used: wallet 1 to 10 first, then ten more at a time
 * while the last ten had any used, up to 50; plus Phantom's older grouping and the Solana CLI's key when they've
 * been used. Wallet 1 is always offered.
 */
async function scanPhrase({ mnemonic }) {
  if (!isMnemonic(mnemonic)) throw fail("that recovery phrase isn't valid: check the words and their order");
  const phrase = normalizeMnemonic(mnemonic);
  let results = await usage(W.phraseWallets(phrase, { from: 0, count: 10, extras: true }));
  for (let from = 10; from < 50; from += 10) {
    const lastTen = results.filter((r) => r.scheme === 'bip44change' && r.index >= from - 10);
    if (!lastTen.some((r) => r.used)) break;
    results = [...results, ...(await usage(W.phraseWallets(phrase, { from, count: 10, extras: false })))];
  }
  // every used wallet, plus plum's first three so a fresh phrase has some to pick; older paths only when used
  return results
    .filter((r) => (r.scheme === 'bip44change' ? r.used || r.index < 3 : r.used))
    .sort((a, b) => (a.scheme === b.scheme ? a.index - b.index : a.scheme === 'bip44change' ? -1 : b.scheme === 'bip44change' ? 1 : a.scheme.localeCompare(b.scheme)));
}

/* ------------------------------------------------------------ requests from plum's own pages */

async function state() {
  const hasVault = await W.hasVault();
  const unlocked = hasVault && (await W.isUnlocked());
  const s = await getSettings();
  return {
    version: VERSION,
    hasVault,
    unlocked,
    accounts: hasVault ? await W.accounts() : [],
    wallets: hasVault ? await W.wallets() : [],
    active: hasVault ? (await W.activeWallet())?.id ?? null : null,
    settings: { ...s, jupiterKey: s.jupiterKey ? 'set' : '' },
    // a built-in RPC's URL holds its key: the page only learns that it's plum's own
    networks: Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => {
      const url = rpcUrlFor(s, k);
      const custom = url !== v.url;
      return [k, { label: v.label, url: !custom && v.builtIn ? "plum's built in rpc" : url, custom, builtIn: !custom && !!v.builtIn }];
    })),
    // the Ethereum networks, and your own RPC for each if you set one
    evm: EVM_NETWORKS.map((n) => ({ key: n.key, id: n.id, name: n.name, title: n.title, tag: n.tag, symbol: n.native.symbol, explorerName: n.explorerName, rpc: (n === MAINNET ? s.ethRpc : s.evmRpc?.[n.key]) || '' })),
    pending: pending.size,
  };
}

/** A custom RPC for an Ethereum network must answer, and be on that network: an RPC for another chain would show
 * balances and simulations from the wrong place. */
async function checkEvmRpc(url, n) {
  let id;
  try { id = await E.ethRpc([url], 'eth_chainId', [], { timeout: 10_000 }); } catch (e) { throw fail(`plum couldn't ask that RPC which chain it is on (${e.message})`); }
  const got = networkById(id);
  if (got !== n) throw fail(`that RPC is for ${got ? got.title : `chain ${String(id).slice(0, 20)}`}, not ${n.title} (chain ${n.id})`);
}

async function updateSettings(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = {};
  if ('network' in p) { if (!NETWORKS[p.network]) throw fail('unknown network'); next.network = p.network; }
  if ('rpc' in p) {
    const cur = (await getSettings()).rpc;
    const rpc = { ...cur };
    for (const [k, v] of Object.entries(p.rpc ?? {})) {
      if (!NETWORKS[k]) continue;
      rpc[k] = v ? checkRpcUrl(String(v).trim()) : '';
    }
    next.rpc = rpc;
  }
  if ('ethRpc' in p) next.ethRpc = p.ethRpc ? checkRpcUrl(String(p.ethRpc).trim()) : '';
  if ('evmRpc' in p) {
    // one per Ethereum network (Ethereum's own is ethRpc), each checked to be on its network before it's kept
    const cur = { ...((await getSettings()).evmRpc ?? {}) };
    for (const [k, v] of Object.entries(p.evmRpc && typeof p.evmRpc === 'object' ? p.evmRpc : {})) {
      const n = networkByKey(k);
      if (!n) continue;
      const url = v ? checkRpcUrl(String(v).trim()) : '';
      if (url) await checkEvmRpc(url, n);
      if (n === MAINNET) next.ethRpc = url; else cur[k] = url;
    }
    next.evmRpc = cur;
  }
  if ('autolockMin' in p) { if (!AUTOLOCK_CHOICES.includes(p.autolockMin)) throw fail('pick one of the auto-lock times'); next.autolockMin = p.autolockMin; }
  if ('hideZero' in p) next.hideZero = !!p.hideZero;
  if ('jupiterKey' in p) next.jupiterKey = String(p.jupiterKey ?? '').trim().slice(0, 128);
  if ('slippageBps' in p) { const b = Number(p.slippageBps); if (!Number.isInteger(b) || b < 1 || b > 5000) throw fail('slippage must be between 0.01% and 50%'); next.slippageBps = b; }
  const out = await setSettings(next);
  if ('autolockMin' in next) await W.touch();
  if ('network' in next) await broadcast('accountChanged');
  return out;
}

const OPEN = new Set(['ping', 'state', 'unlock', 'lock', 'checkMnemonic', 'checkKey', 'scanPhrase', 'create', 'restore', 'importKey', 'reset', 'approval.get', 'approval.preview', 'approval.reject', 'approval.rejectSite', 'approval.show', 'approval.done']);

const changed = async () => { await broadcast('accountChanged'); return state(); };

const ui = {
  ping: () => true,
  state,
  unlock: async ({ password }) => { await W.unlock(String(password ?? '')); return state(); },
  lock: async () => { await W.lock(); return true; },
  checkMnemonic: ({ mnemonic }) => isMnemonic(mnemonic),
  checkKey: ({ secret }) => W.keyInfo(secret),
  scanPhrase,
  // the first wallet: a fresh phrase made here (its words come back once, to write down), or one you bring
  create: ({ password, words, name, icon }) => serial(async () => {
    const phrase = newMnemonic(words === 24 ? 24 : 12);
    await W.create({ password, mnemonic: phrase, name, icon, backedUp: false });
    return { state: await state(), phrase };
  }),
  restore: ({ password, mnemonic, picks, name, icon }) => serial(async () => { await W.create({ password, mnemonic, picks, name, icon }); return state(); }),
  importKey: ({ password, secret, name, icon }) => serial(async () => {
    if ((await W.hasVault()) && !(await W.isUnlocked())) throw fail('unlock plum first', 'locked');
    await W.importKey({ password, secret, name, icon });
    return changed();
  }),
  reset: ({ confirm }) => serial(async () => {
    if (confirm !== 'reset') throw fail('type reset to confirm');
    for (const r of pending.values()) r.reject(rejected());
    pending.clear();
    // the phishing list isn't yours: it stays, so a reset never leaves plum unguarded until its next refresh
    const phish = await local.get('phish');
    await W.reset();
    if (phish) await local.set({ phish });
    return changed();
  }),
  'account.new': ({ words, name, icon }) => serial(async () => { const made = await W.newAccount({ words, name, icon }); await broadcast('accountChanged'); return { state: await state(), phrase: made.phrase, account: made.account.id }; }),
  'account.import': ({ mnemonic, picks, name, icon }) => serial(async () => { await W.addAccount({ mnemonic, picks, name, icon }); return changed(); }),
  'account.rename': ({ id, name }) => serial(async () => { await W.renameAccount(id, name); return state(); }),
  'account.remove': ({ id }) => serial(async () => { await W.removeAccount(id); return changed(); }),
  'account.phrase': ({ id, password }) => W.exportPhrase(id, String(password ?? '')),
  'account.backedUp': ({ id }) => serial(async () => { await W.markBackedUp(id); return state(); }),
  'wallet.add': ({ account, name, icon }) => serial(async () => { await W.addWallet(account, { name, icon }); return changed(); }),
  'wallet.select': ({ id }) => serial(async () => { await W.select(id); return changed(); }),
  'wallet.rename': ({ id, name }) => serial(async () => { await W.renameWallet(id, name); return state(); }),
  'wallet.icon': ({ id, icon }) => serial(async () => { await W.setIcon(id, icon); return state(); }),
  'wallet.remove': ({ id }) => serial(async () => { await W.removeWallet(id); return changed(); }),
  'wallet.export': ({ id, chain, password }) => W.exportKey(id, chain, String(password ?? '')),
  'password.change': ({ oldPassword, newPassword }) => serial(async () => { await W.changePassword(String(oldPassword ?? ''), String(newPassword ?? '')); return true; }),
  'settings.set': ({ patch }) => serial(() => updateSettings(patch)),
  sites: async () => (await Promise.all(Object.entries(await sites()).map(async ([origin, v]) => ({ origin, ...v, evmNet: v.evm?.length ? (await siteNetwork(origin)).tag : null })))).sort((a, b) => b.lastUsed - a.lastUsed),
  'sites.revoke': async ({ origin }) => { await revoke(String(origin)); return true; },
  balances,
  activity,
  'send.prepare': prepareSend,
  'send.max': maxSend,
  'send.submit': submitPrepared,
  'swap.quote': getQuote,
  'swap.prepare': prepareSwap,
  'swap.submit': submitPrepared,
  'stake.list': async () => { const { address } = await requireActive('sol'); const { rpc, network } = await net(); return S.overview(rpc, address, network); },
  'stake.validators': async () => { const { rpc, network } = await net(); return S.validators(rpc, network); },
  'stake.prepare': prepareStaking,
  'stake.submit': submitPrepared,
  'nfts.list': nftList,
  'nfts.prepare': prepareNftSend,
  'nfts.submit': submitPrepared,
  'tx.status': ({ signature }) => sent.get(signature) ?? null,
  'tokens.search': async ({ query }) => searchTokens(query, await jupOpts()),
  'approval.get': approvalView,
  'approval.preview': ({ id }) => approvalPreview(id),
  'approval.resolve': approvalResolve,
  'approval.reject': ({ id }) => approvalResolve({ id, approve: false }),
  'approval.rejectSite': ({ id }) => {
    const r = pending.get(id);
    if (!r) return 0;
    const site = siteOf(r.origin);
    let n = 0;
    for (const x of [...pending.values()]) if (siteOf(x.origin) === site) { pending.delete(x.id); x.reject(rejected()); n++; }
    return n;
  },
  'approval.show': async () => { if (pending.size) await showApproval({ focus: true }); return pending.size; },
  'approval.done': approvalDone,
};

function fromPlum(sender) {
  const base = ext().runtime.getURL('');
  return sender?.id === ext().runtime.id && typeof sender.url === 'string' && sender.url.startsWith(base);
}

const isUiMessage = (msg, sender) => fromPlum(sender) && msg?.type === 'plum-ui' && typeof msg.method === 'string' && Object.hasOwn(ui, msg.method);

/** A wire-safe answer: no bigints (they can't cross a message), as decimal strings. */
const plain = (v) => JSON.parse(JSON.stringify(v ?? null, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

async function onUiMessage(msg, sender) {
  if (!isUiMessage(msg, sender)) return undefined;
  try {
    if (!OPEN.has(msg.method)) {
      if (!(await W.isUnlocked())) throw fail('plum is locked', 'locked');
      await W.touch();
    }
    return { ok: true, result: plain(await ui[msg.method](msg.params ?? {})) };
  } catch (e) {
    return { ok: false, error: e.message || 'something went wrong', code: e.code ?? null };
  }
}

/* ------------------------------------------------------------ wiring (listeners register at once, so the browser can wake the background for them) */

/**
 * Solana's public mainnet RPC refuses any request that carries a browser Origin (403), so plum's own requests to that
 * one host go without it. Only requests from plum itself (not from any tab) are touched.
 */
export async function allowPublicRpc(b = ext()) {
  if (!b.declarativeNetRequest?.updateSessionRules) return;
  await b.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
      condition: { requestDomains: ['api.mainnet-beta.solana.com'], tabIds: [-1], resourceTypes: ['xmlhttprequest'] },
    }],
  }).catch(() => {});
}

export function start() {
  const b = ext();
  W.ready().catch(() => {});
  allowPublicRpc(b);
  // answered through sendResponse (and `true` to keep the channel open): Chromium ignores a promise returned from
  // onMessage, Firefox takes either
  b.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isUiMessage(msg, sender)) return false;
    onUiMessage(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message || 'something went wrong', code: null }));
    return true;
  });
  b.runtime.onConnect.addListener(onConnect);
  b.windows.onRemoved.addListener(onWindowRemoved);
  b.alarms.onAlarm.addListener((a) => {
    if (a.name === W.LOCK_ALARM) W.lock();
    if (a.name === PHISH_ALARM) refreshPhish();
  });
  b.idle?.onStateChanged.addListener((s) => { if (s === 'locked') W.lock(); });
  b.runtime.onInstalled.addListener(async ({ reason }) => {
    b.alarms.create(PHISH_ALARM, { delayInMinutes: 1, periodInMinutes: 720 });
    if (reason === 'install' && !(await W.hasVault())) openWelcome();
  });
  b.runtime.onStartup?.addListener(() => b.alarms.create(PHISH_ALARM, { delayInMinutes: 1, periodInMinutes: 720 }));
}

export const _test = { pending, approval, dappRequest, approvalResolve, approvalView, approvalPreview, onUiMessage, onConnect, prepared, sent, quotes, messageView, scanPhrase };
