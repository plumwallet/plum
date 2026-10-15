// Bitcoin sites: requests from plum's Bitcoin provider in the page (sats-connect's request methods, found through
// WBIP-004 and the Wallet Standard), checked here and, whenever they'd show your addresses or sign anything, approved
// by you in plum's own window: connecting (your bc1q payment address and your bc1p ordinals address), signing a
// message (BIP-322, or the legacy format when a site asks for it by name), signing a PSBT (reviewed input by input;
// only the wallet's own inputs are signed), and sending bitcoin (built, priced and signed by plum from both addresses).
// A site's origin comes from the browser (main.js), never from what the page says.
import { sha256 } from '@noble/hashes/sha2.js';
import { b64decode, b64encode, hex, readUtf8, utf8 } from '../shared/bytes.js';
import { hasHidden } from '../shared/text.js';
import { bip322Digest, legacyDigest, signBip322, signLegacy } from './bip322.js';
import * as B from './btc.js';
import { reviewPsbt, signPsbt } from './btc-psbt.js';
import { prepareSpend } from './btc-send.js';
import { contentsOf } from './ordinals.js';
import { MAX_PSBT_BYTES, decodePsbt, extractTx } from './psbt.js';
import * as W from './wallet.js';

/** sats-connect's error codes (RpcErrorCode). */
export const CODES = { USER_REJECTION: -32000, METHOD_NOT_SUPPORTED: -32001, ACCESS_DENIED: -32002, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603 };
const err = (message, code = CODES.INVALID_PARAMS) => Object.assign(new Error(message), { code });

// sats-connect's network shape (apps read every field of it): plum is on Bitcoin mainnet only
export const NETWORK = { bitcoin: { name: 'Mainnet' }, stacks: { name: 'mainnet' }, spark: { name: 'mainnet' } };
/** What plum answers, by sats-connect's names. */
export const METHODS = ['getInfo', 'getAddresses', 'getAccounts', 'getBalance', 'signMessage', 'signPsbt', 'sendTransfer', 'wallet_connect', 'wallet_disconnect',
  'wallet_getAccount', 'wallet_requestPermissions', 'wallet_renouncePermissions', 'wallet_getNetwork', 'wallet_changeNetwork', 'wallet_getWalletType'];
/** The ones that can end in your approval (counted against a site's allowance as they arrive). */
export const BTC_APPROVALS = new Set(['getAddresses', 'getAccounts', 'wallet_connect', 'wallet_requestPermissions', 'signMessage', 'signPsbt', 'sendTransfer']);
const CONNECTS = new Set(['getAddresses', 'getAccounts', 'wallet_connect', 'wallet_requestPermissions']);
const PURPOSES = ['payment', 'ordinals'];
const MAX_MESSAGE = 16 * 1024;

/** A wallet's two addresses, as plum passes them around. */
export const ownerOf = (w) => ({ segwit: w.chains.btc.address, taproot: w.chains.btc.taproot?.address ?? null, taprootKey: w.chains.btc.taproot?.publicKey ?? null });

/** Its addresses as sats-connect describes them, for the purposes asked (payment = bc1q, ordinals = bc1p). */
function addressesOf(w, purposes) {
  const btc = w.chains.btc;
  if (!btc.publicKey || !btc.taproot?.publicKey) throw err('unlock plum once so it can read this wallet\'s Bitcoin keys, then connect again', CODES.ACCESS_DENIED);
  return purposes.map((p) => (p === 'payment'
    ? { address: btc.address, publicKey: btc.publicKey, purpose: 'payment', addressType: 'p2wpkh', walletType: 'software' }
    : { address: btc.taproot.address, publicKey: btc.taproot.publicKey, purpose: 'ordinals', addressType: 'p2tr', walletType: 'software' }));
}

/** The purposes a site asks for: sats-connect's `purposes` (or wallet_connect's `addresses`); ones plum has no
 * address for (stacks, starknet, spark) are left out, and none at all means both. */
function purposesOf(p) {
  const asked = Array.isArray(p.purposes) ? p.purposes : Array.isArray(p.addresses) ? p.addresses : null;
  if (asked && (asked.length > 10 || asked.some((x) => typeof x !== 'string'))) throw err('the purposes asked for are malformed');
  const out = PURPOSES.filter((x) => !asked || asked.includes(x));
  return out.length ? out : PURPOSES;
}

/** A stable, opaque id for a connection (sats-connect's account id): nothing about the wallet can be read from it. */
const accountId = (origin, address) => hex(sha256(utf8(`plum btc account|${origin}|${address}`))).slice(0, 32);

/** A short readable line from a site (its "message" when connecting), or null. */
const siteLine = (s) => (typeof s === 'string' && s.trim() && !hasHidden(s) ? s.trim().slice(0, 300) : null);

/** Sign-In with Bitcoin (CAIP-122's text, EIP-4361's shape): what's wrong with it for the site asking. */
function signInProblems(text, { origin, address }) {
  const m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your Bitcoin account:\n(\S+)\n/.exec(text ?? '');
  if (!m) return [];
  const u = new URL(origin);
  const problems = [];
  if (m[2].toLowerCase() !== u.host.toLowerCase()) problems.push(`it signs you in to ${m[2]}, but the site asking is ${u.host}`);
  if (m[3] !== address) problems.push(`it signs in ${m[3]}, not the address signing it`);
  const uri = /\nURI: (\S+)/.exec(text)?.[1];
  if (uri) { try { if (new URL(uri).host.toLowerCase() !== u.host.toLowerCase()) problems.push(`its link points at ${new URL(uri).host}, not ${u.host}`); } catch { problems.push("its link isn't a URL"); } }
  return problems;
}

/** A PSBT as a site sends it: base64 (sats-connect), or hex. */
function psbtBytes(s) {
  if (typeof s !== 'string' || !s.length || s.length > MAX_PSBT_BYTES * 2) throw err('the PSBT is missing or too large');
  if (/^70736274ff([0-9a-fA-F]{2})*$/.test(s)) return Uint8Array.from(s.match(/../g), (b) => Number.parseInt(b, 16));
  try { return b64decode(s); } catch { throw err("the PSBT isn't base64"); }
}

/** sats-connect's signInputs ({ address: [input indexes] }), or its older inputsToSign ([{ address, signingIndexes,
 * sigHash }], which the Wallet Standard's inputsToSign becomes): [{ index, address, sighash? }], or null for "every
 * input of the wallet's". */
function inputsAsked(p, count) {
  const pairs = [];
  if (p.signInputs != null) {
    if (typeof p.signInputs !== 'object' || Array.isArray(p.signInputs)) throw err('signInputs is malformed');
    for (const [address, list] of Object.entries(p.signInputs)) pairs.push([address, list, undefined]);
  } else if (p.inputsToSign != null) {
    if (!Array.isArray(p.inputsToSign) || p.inputsToSign.length > count) throw err('inputsToSign is malformed');
    for (const x of p.inputsToSign) pairs.push([x?.address, x?.signingIndexes, x?.sigHash]);
  } else return null;
  const out = [];
  for (const [address, list, sighash] of pairs) {
    if (typeof address !== 'string' || !Array.isArray(list) || list.length > count) throw err('the inputs to sign are malformed');
    if (sighash != null && (!Number.isInteger(sighash) || sighash < 0 || sighash > 0xff)) throw err('a sighash type asked for is malformed');
    for (const i of list) {
      if (!Number.isInteger(i) || i < 0 || i >= count) throw err(`there's no input ${String(i).slice(0, 12)} to sign`);
      if (out.some((x) => x.index === i)) throw err(`input ${i} is asked for twice`);
      out.push(sighash == null ? { index: i, address } : { index: i, address, sighash });
    }
  }
  if (!out.length) throw err('no inputs to sign');
  return out;
}

/** sendTransfer's recipients: 1 to 20, each a main-network address and a whole number of sats. */
function recipientsOf(p) {
  if (!Array.isArray(p.recipients) || !p.recipients.length || p.recipients.length > 20) throw err('send to 1 to 20 recipients');
  return p.recipients.map((r) => {
    const address = typeof r?.address === 'string' ? r.address.trim() : '';
    try { B.addressScript(address); } catch (e) { throw err(`${address.slice(0, 90) || 'a recipient'}: ${e.message}`); }
    const n = typeof r.amount === 'string' && /^\d{1,16}$/.test(r.amount) ? BigInt(r.amount) : Number.isSafeInteger(r.amount) && r.amount > 0 ? BigInt(r.amount) : null;
    if (n == null || n < B.DUST) throw err(`each amount is a whole number of sats, ${B.DUST} at least`);
    return { address, amount: n };
  });
}

/** The message a site wants signed: its text (or hex when it isn't readable), the address and the format. */
function messageView(bytes, extra) {
  const text = readUtf8(bytes);
  return { text: text != null && !hasHidden(text) ? text : null, hex: hex(bytes.subarray(0, 512)), bytes: bytes.length, ...extra };
}

/**
 * The Bitcoin side of the background, made with what it needs from main.js: approval (queue a request for the
 * window), trusted / trust / untrust (connected sites, per chain), riskOf (the phishing list), openWelcome, track (follow
 * a sent transaction) and version.
 */
export function bitcoinSites({ approval, trusted, trust, untrust, riskOf, openWelcome, track, version }) {
  async function request(origin, method, params, ctx) {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    if (!METHODS.includes(method)) throw err(`Plum doesn't support ${String(method).slice(0, 40)}`, CODES.METHOD_NOT_FOUND);
    if (method === 'getInfo') return { version, methods: METHODS, supports: [] };
    if (method === 'wallet_getNetwork') return NETWORK;
    if (method === 'wallet_getWalletType') return 'software';
    if (method === 'wallet_changeNetwork') {
      if (String(p.name ?? '').toLowerCase() === 'mainnet') return null;
      throw err('Plum is on Bitcoin mainnet only', CODES.INVALID_PARAMS);
    }
    const w = await W.activeWallet();
    const me = w?.chains.btc?.address ?? null;
    const connected = !!me && (await trusted(origin, me, 'btc'));
    if (method === 'wallet_disconnect' || method === 'wallet_renouncePermissions') { await untrust(origin, 'btc'); return null; }
    if (method === 'wallet_getAccount') {
      if (!connected) throw err('connect to Plum first', CODES.ACCESS_DENIED);
      return { id: accountId(origin, me), addresses: addressesOf(w, PURPOSES), walletType: 'software', network: NETWORK };
    }

    if (CONNECTS.has(method)) {
      if (!w) {
        await openWelcome({ fromSite: true });
        throw err('Plum has no wallet yet: finish setting it up, then connect again', CODES.ACCESS_DENIED);
      }
      // (never the wallet's name: this page isn't connected)
      if (!me) throw err("Plum's active wallet has no Bitcoin address: switch to another wallet in plum, then connect again", CODES.ACCESS_DENIED);
      const purposes = purposesOf(p);
      const risk = await riskOf(origin);
      if (connected && risk.level !== 'blocked') await trust(origin, me, 'btc');
      else {
        const shown = purposes.map((x) => ({ purpose: x, address: x === 'payment' ? me : w.chains.btc.taproot?.address ?? null })).filter((x) => x.address);
        await approval({ chain: 'btc', kind: 'btcConnect', origin, risk, account: me, ctx, network: 'mainnet', btcView: { purposes, shown, note: siteLine(p.message) } });
      }
      const now = await W.walletOf('btc', me);
      const list = addressesOf(now ?? w, purposes);
      if (method === 'getAccounts') return list;
      if (method === 'wallet_requestPermissions') return true;
      if (method === 'wallet_connect') return { id: accountId(origin, me), addresses: list, walletType: 'software', network: NETWORK };
      return { addresses: list, network: NETWORK };
    }

    // everything else: a connected site
    if (!connected) throw err('connect to Plum first', CODES.ACCESS_DENIED);
    const owner = ownerOf(w);
    const risk = await riskOf(origin);
    const base = { chain: 'btc', origin, risk, account: me, ctx, network: 'mainnet' };

    if (method === 'getBalance') {
      const b = await B.balanceOf(owner);
      return { confirmed: b.confirmed.toString(), unconfirmed: b.pending.toString(), total: b.total.toString() };
    }
    if (method === 'signMessage') {
      const address = p.address;
      if (address !== owner.segwit && address !== owner.taproot) throw err("that address isn't the connected wallet's", CODES.ACCESS_DENIED);
      if (typeof p.message !== 'string') throw err('the message must be text');
      const bytes = utf8(p.message);
      if (bytes.length > MAX_MESSAGE) throw err(`a message can be ${MAX_MESSAGE / 1024} KB at most`);
      const protocol = p.protocol == null ? 'BIP322' : String(p.protocol).toUpperCase();
      if (protocol !== 'BIP322' && protocol !== 'ECDSA') throw err(`Plum signs messages with BIP322 or ECDSA, not ${String(p.protocol).slice(0, 20)}`);
      const view = messageView(bytes, { address, purpose: address === owner.taproot ? 'ordinals' : 'payment', protocol });
      view.problems = signInProblems(view.text, { origin, address });
      return approval({ ...base, kind: 'btcMessage', messageBytes: bytes, btcView: view });
    }
    if (method === 'signPsbt') {
      const bytes = psbtBytes(p.psbt);
      let psbt;
      try { psbt = decodePsbt(bytes); } catch (e) { throw err(e.message); }
      const toSign = inputsAsked(p, psbt.tx.inputs.length);
      // what plum would refuse whatever the chain says (an input that isn't the wallet's, a script path...) is
      // refused now, before the window opens
      let first;
      try { first = reviewPsbt(psbt, { owner, toSign }); } catch (e) { throw err(e.message); }
      const broadcast = !!p.broadcast;
      if (broadcast && !first.complete) throw err(`the site asked plum to send this PSBT, but input ${first.inputs.find((x) => !x.sign && !x.signed).index} isn't signed by anyone`);
      return approval({ ...base, kind: 'btcPsbt', psbtBytes: bytes, toSign, broadcast, btcView: { inputs: psbt.tx.inputs.length, outputs: psbt.tx.outputs.length, broadcast } });
    }
    if (method === 'sendTransfer') {
      const recipients = recipientsOf(p);
      return approval({ ...base, kind: 'btcSend', recipients, btcView: { recipients: recipients.map((r) => ({ address: r.address, amount: r.amount.toString() })) } });
    }
    throw err(`Plum doesn't support ${String(method).slice(0, 40)}`, CODES.METHOD_NOT_FOUND);
  }

  /** The wallet a request was made for (whatever wallet is active now). */
  async function ownerFor(r) {
    const w = await W.walletOf('btc', r.account);
    if (!w) throw err('that wallet is no longer in plum');
    return ownerOf(w);
  }

  /** What a PSBT or a send would do, for the approval window (read from the chain). */
  async function preview(r) {
    const owner = await ownerFor(r);
    if (r.kind === 'btcSend') {
      try {
        const prep = await prepareSpend({ owner, recipients: r.recipients.map((x) => ({ to: x.address, amount: x.amount })) });
        r.plan = prep.plan;
        r.review = { warnings: prep.warnings };
        return { ...prep.preview, recipients: r.btcView.recipients, warnings: prep.warnings };
      } catch (e) {
        r.review = { error: e.message };
        return { chain: 'btc', kind: 'send', error: e.message };
      }
    }
    const psbt = decodePsbt(r.psbtBytes);
    const outpoints = psbt.tx.inputs.map((i) => ({ txid: i.txid, vout: i.vout }));
    const [chain, rates] = await Promise.all([B.prevoutsOf(outpoints).catch(() => null), B.feeRates().catch(() => null)]);
    let review;
    try {
      const mineAt = reviewPsbt(psbt, { owner, toSign: r.toSign }).inputs.filter((x) => x.sign);
      const contents = await contentsOf(mineAt.map((x) => ({ txid: x.txid, vout: x.vout }))).catch(() => null);
      review = reviewPsbt(psbt, { owner, toSign: r.toSign, chain, contents, rates });
      if (!contents && mineAt.some((x) => x.mine === 'p2tr')) review.warnings.push({ level: 'warn', text: "plum couldn't check this wallet's coins in it for inscriptions or runes (the indexer didn't answer)" });
    } catch (e) {
      r.review = { error: e.message };
      return { chain: 'btc', kind: 'psbt', error: e.message };
    }
    r.psbt = psbt;
    r.review = review;
    return { chain: 'btc', kind: 'psbt', ...wire(review), broadcast: r.broadcast, checked: !!chain };
  }

  /** Before signing: the review must exist and hold no refusal; a danger needs "i understand". */
  async function check(r, ignoreRisk) {
    if (r.kind !== 'btcPsbt' && r.kind !== 'btcSend') {
      if (r.kind === 'btcMessage' && (r.btcView.text == null || r.btcView.problems?.length) && !ignoreRisk) throw err('this message carries a danger: tick "i understand" to sign it anyway');
      return;
    }
    if (!r.review) await preview(r);
    if (r.review.error) throw err(r.review.error);
    if (r.review.warnings.some((w) => w.level === 'danger') && !ignoreRisk) throw err('this carries a danger: tick "i understand" to sign it anyway');
  }

  const sign = (address, digests, opts) => W.signBitcoinAs(address, digests, opts);

  async function perform(r) {
    if (r.kind === 'btcConnect') { await trust(r.origin, r.account, 'btc'); return [r.account]; }
    const owner = await ownerFor(r);
    if (r.kind === 'btcMessage') {
      const { address, protocol } = r.btcView;
      const signature = protocol === 'ECDSA' ? await signLegacy(address, r.messageBytes, sign) : await signBip322(address, r.messageBytes, sign);
      const messageHash = hex(protocol === 'ECDSA' ? legacyDigest(r.messageBytes) : bip322Digest(address, r.messageBytes).digest);
      return { signature, messageHash, address, protocol };
    }
    if (r.kind === 'btcPsbt') {
      const bytes = await signPsbt(r.psbt, r.review, owner, sign, { finalize: r.broadcast });
      if (!r.broadcast) return { psbt: b64encode(bytes) };
      const { raw, txid } = extractTx(decodePsbt(bytes));
      await B.broadcast(raw, txid);
      track(txid);
      return { psbt: b64encode(bytes), txid };
    }
    if (r.kind === 'btcSend') {
      const { raw, txid } = await B.signSpend(r.plan, owner, sign);
      await B.broadcast(raw, txid);
      track(txid);
      return { txid };
    }
    throw err('unknown request', CODES.INTERNAL_ERROR);
  }

  return { request, preview, check, perform };
}

/** A review as it crosses to the approval window: amounts as strings, scripts left out. */
function wire(review) {
  const s = (v) => (v == null ? null : v.toString());
  return {
    inputs: review.inputs.map((x) => ({ index: x.index, txid: x.txid, vout: x.vout, value: s(x.value), address: x.address, kind: x.kind, mine: x.mine, sign: x.sign, signed: x.signed, verified: x.verified, sighash: x.sighash, holds: x.holds })),
    outputs: review.outputs.map((o) => ({ index: o.index, value: s(o.value), address: o.address, kind: o.kind, mine: o.mine })),
    leaves: s(review.leaves), arrives: s(review.arrives), net: s(review.net), fee: s(review.fee), feeRate: review.feeRate, vsize: review.vsize,
    fixed: review.fixed, toOthers: s(review.toOthers), complete: review.complete, warnings: review.warnings,
  };
}
