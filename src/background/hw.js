// Wallets on a Ledger. plum asks the device to sign only after you approved the request in plum's own window, and it
// takes nothing the device says on trust: before signing, the device must show it is the one this wallet is on (the
// same address at the wallet's path, or for Bitcoin the same master fingerprint), and every signature that comes back
// is checked against what plum built and showed you (its own hash, recovered or verified with the wallet's key). A
// signature that isn't exactly that is never sent or handed to a site.
// Adding a Ledger reads its addresses here, in the background, and keeps what it read: the page that shows them only
// picks which ones, so it can't slip an address of its own in.
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, base58Encode } from '../shared/base58.js';
import { equal, hex } from '../shared/bytes.js';
import { readTx } from '../shared/tx.js';
import * as B from './btc.js';
import * as E from './eth.js';
import { LedgerError } from './ledger/apdu.js';
import * as LB from './ledger/bitcoin.js';
import * as D from './ledger/device.js';
import * as LE from './ledger/ethereum.js';
import * as LS from './ledger/solana.js';
import { NetError, failover, request } from './net.js';
import * as W from './wallet.js';

export const APPS = { sol: LS.APP, eth: LE.APP, btc: LB.APP };
/** The sequence number plum's Bitcoin sends carry (btc.js: opt-in replace-by-fee). */
const BTC_SEQUENCE = 0xfffffffd;
const BTC_ACCOUNT = "m/84'/0'/0'";

export const status = D.status;
export const cancel = D.cancel;

const wrongDevice = () => new LedgerError('mismatch', "this isn't the Ledger this wallet is on (it holds a different recovery phrase, or a passphrase): plug in the right one");
const badSignature = () => new LedgerError('mismatch', "your Ledger's signature doesn't match what plum showed you, so nothing was signed or sent");

/** Is the wallet holding `address` on `chain` one of a Ledger's? */
export async function owns(chain, address) {
  return (await W.walletOf(chain, address))?.scheme === W.LEDGER;
}

/** Does approving this request need a Ledger? */
export const signsFor = (r) => (r.kind === 'connect' || r.kind === 'evmConnect' ? false : owns(r.chain, r.account));

/* ------------------------------------------------------------ Solana */

const verifySol = (sig, msg, address) => {
  try { return ed25519.verify(sig, msg, base58Decode(address), { zip215: false }); } catch { return false; }
};

/** What the device shows instead of the details when it blind signs, for you to compare: "abcdef..uvwxyz". */
const blindHash = (h) => `${h.slice(0, 8)}..${h.slice(-8)}`;

/** A transaction's message signed on the Ledger: the 64-byte signature, checked. */
export async function signSolTx(address, message) {
  const rec = await W.ledgerOf('sol', address);
  return D.use(LS.APP, async (link, info, { confirm }) => {
    if ((await LS.address(link, rec.path)) !== address) throw wrongDevice();
    confirm(`check the transaction on your Ledger, then approve it there. If it can only show a message hash (blind signing), that hash must be ${blindHash(base58Encode(sha256(message)))}`);
    const sig = await LS.signTransaction(link, rec.path, message);
    if (!verifySol(sig, message, address)) throw badSignature();
    return sig;
  });
}

/** A message signed on the Ledger, as a Solana off-chain message: { signature, signed } (the wrapped message). */
export async function signSolMessage(address, bytes) {
  const rec = await W.ledgerOf('sol', address);
  return D.use(LS.APP, async (link, info, { confirm }) => {
    if ((await LS.address(link, rec.path)) !== address) throw wrongDevice();
    const ascii = bytes.every((b) => b >= 0x20 && b <= 0x7e);
    confirm(ascii ? 'check the message on your Ledger, then sign it there' : `your Ledger shows this message as a hash (it isn't plain ASCII): it must be ${blindHash(base58Encode(sha256(bytes)))}. Sign it there if it is.`);
    const out = await LS.signOffchain(link, rec.path, bytes, base58Decode(address), { version: info.version });
    if (!verifySol(out.signature, out.signed, address)) throw badSignature();
    return out;
  });
}

/* ------------------------------------------------------------ Ethereum */

async function ethDevice(address, fn) {
  const rec = await W.ledgerOf('eth', address);
  return D.use(LE.APP, async (link, info, ctx) => {
    if (!E.sameAddress(await LE.address(link, rec.path), address)) throw wrongDevice();
    return fn(link, rec.path, info, ctx);
  });
}

/** An EIP-1559 transaction signed on the Ledger: { r, s, yParity }, checked to recover to the wallet. */
export async function signEthTx(address, tx) {
  return ethDevice(address, async (link, path, info, { confirm }) => {
    confirm(`check the transaction on your Ledger, then approve it there. If it shows a tx hash (blind signing), it must be ${blindHash(`0x${hex(E.txDigest(tx))}`)}`);
    const sig = await LE.signTransaction(link, path, E.unsignedTx(tx));
    if (E.signerOf(E.txDigest(tx), sig) !== address) throw badSignature();
    return sig;
  });
}

/** A personal_sign message signed on the Ledger, as dApps want it (0x r s v). */
export async function signEthMessage(address, bytes) {
  return ethDevice(address, async (link, path, info, { confirm }) => {
    confirm('check the message on your Ledger, then sign it there');
    const sig = await LE.signPersonal(link, path, bytes);
    if (E.signerOf(E.personalDigest(bytes), sig) !== address) throw badSignature();
    return E.sigHex(sig);
  });
}

/** Typed data signed on the Ledger (field by field when its app can, else as the two hashes), as dApps want it. */
export async function signEthTyped(address, typed) {
  return ethDevice(address, async (link, path, info, { confirm }) => {
    confirm('check every field on your Ledger, then sign it there');
    const { sig } = await LE.signTyped(link, path, typed, E.typedHashes(typed), { version: info.version });
    if (E.signerOf(E.typedDigest(typed), sig) !== address) throw badSignature();
    return E.sigHex(sig);
  });
}

/* ------------------------------------------------------------ Bitcoin */

/** The previous transactions a send spends, without their witnesses, each checked against its txid. */
async function previousTransactions(inputs) {
  const out = new Map();
  for (const txid of new Set(inputs.map((i) => i.txid))) {
    const text = await failover(B.ESPLORA, async (base) => {
      const r = await request(`${base}/tx/${txid}/hex`, { timeout: 15_000 });
      if (r.status === 429 || r.status >= 500) throw new NetError(`${new URL(base).host} answered ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`${new URL(base).host} doesn't know a transaction this send spends`), { final: true });
      return r.text;
    });
    out.set(txid, LB.stripWitness(text, txid));
  }
  return out;
}

/** The index n of a Bitcoin wallet's path m/84'/0'/0'/0/n. */
const btcIndex = (path) => Number.parseInt(path.split('/').pop(), 10);

/**
 * A signer for btc.js's signPlan: the Ledger signs `plan` (as a PSBT, every input with its previous transaction, the
 * change marked as the wallet's), and each signature must be this wallet's key's, over plum's own sighash for that
 * input. Returns { publicKey, signatures (DER, low s) }.
 */
export async function signBtc(address, plan, digests) {
  const rec = await W.ledgerOf('btc', address);
  const { publicKey, address: derived } = LB.derive(rec.xpub, btcIndex(rec.path));
  if (derived !== address) throw new LedgerError('mismatch', "this wallet's Bitcoin address doesn't come from its Ledger's key");
  const prev = await previousTransactions(plan.inputs);
  return D.use(LB.APP, async (link, info, { confirm }) => {
    LB.checkApp(info);
    if ((await LB.fingerprint(link)) !== rec.fingerprint) throw wrongDevice();
    const maps = LB.psbtMaps({ inputs: plan.inputs, outputs: plan.outputs, sequence: BTC_SEQUENCE }, { publicKey, path: rec.path, fingerprint: rec.fingerprint }, prev);
    confirm('check every output and the fee on your Ledger, then sign it there');
    const yielded = await LB.signPsbt(link, maps, LB.segwitPolicy(rec.fingerprint, rec.xpub));
    if (yielded.length !== digests.length) throw badSignature();
    const signatures = digests.map((digest, i) => {
      const got = yielded.filter((y) => y.index === i);
      if (got.length !== 1 || !equal(got[0].publicKey, publicKey) || got[0].signature.at(-1) !== 0x01) throw badSignature();
      let der;
      try { der = LB.lowS(got[0].signature.slice(0, -1)); } catch { throw badSignature(); }
      if (!secp256k1.verify(der, digest, publicKey, { prehash: false, format: 'der' })) throw badSignature();
      return der;
    });
    return { publicKey, signatures };
  });
}

/* ------------------------------------------------------------ reading a Ledger's wallets */

/** The paths plum reads on a Ledger: its own (as a recovery phrase's wallets) and Ledger Live's. */
export const LAYOUTS = {
  plum: { sol: (n) => `m/44'/501'/${n}'/0'`, eth: (n) => `m/44'/60'/0'/0/${n}`, btc: (n) => `m/84'/0'/0'/0/${n}` },
  live: { sol: (n) => `m/44'/501'/${n}'`, eth: (n) => `m/44'/60'/${n}'/0/0` },
};

/** One chain's wallets on the device: [{ layout, index, address, path, (btc) xpub, fingerprint }]. */
async function readChain(chain, { from, count }) {
  return D.use(APPS[chain], async (link, info) => {
    const out = [];
    if (chain === 'btc') {
      LB.checkApp(info);
      const fingerprint = await LB.fingerprint(link);
      const xpub = await LB.xpub(link, BTC_ACCOUNT);
      for (let n = from; n < from + count; n++) out.push({ layout: 'plum', index: n, path: LAYOUTS.plum.btc(n), address: LB.derive(xpub, n).address, xpub, fingerprint });
      // the device works the first address out from the account itself: it must be the one plum worked out
      const first = await LB.walletAddress(link, LB.segwitPolicy(fingerprint, xpub), { index: from });
      if (first !== out[0].address) throw new LedgerError('mismatch', "your Ledger's Bitcoin address doesn't match its own account key");
      return out;
    }
    for (const layout of ['plum', 'live']) {
      for (let n = from; n < from + count; n++) {
        const path = LAYOUTS[layout][chain](n);
        // Ledger Live's first Ethereum account is plum's wallet 1
        if (out.some((x) => x.path === path)) continue;
        out.push({ layout, index: n, path, address: chain === 'sol' ? await LS.address(link, path) : await LE.address(link, path) });
      }
    }
    return out;
  });
}

const scans = new Map();
const newId = () => hex(crypto.getRandomValues(new Uint8Array(9)));

/**
 * Read the wallets a Ledger holds on `chains` (each chain's app opened in turn), and which have been used: rows of
 * { key, layout, index, chains: { sol?: { address, path, used, amount }, ... }, used, added }. With `account`, the
 * device must be the one behind that Ledger account (more wallets from it).
 */
async function scan({ chains, account = null, from = 0, count = 5 }, usage) {
  const want = ['sol', 'eth', 'btc'].filter((c) => Array.isArray(chains) && chains.includes(c));
  if (!want.length) throw new LedgerError('refused', 'pick at least one chain');
  if (!Number.isInteger(from) || from < 0 || from > 1000 || !Number.isInteger(count) || count < 1 || count > 10) throw new LedgerError('refused', 'that range of wallets is malformed');
  const read = [];
  for (const c of want) read.push(...(await readChain(c, { from, count })).map((x) => ({ ...x, chain: c })));
  if (account) {
    // the device must give the very addresses this account already holds, where it read the same paths
    const recs = await W.ledgerRecords(account);
    const same = read.filter((x) => recs.some((r) => r.chains[x.chain]?.path === x.path));
    if (!same.length && recs.length) throw new LedgerError('mismatch', "plum can't tell this Ledger is the one behind that account: add it as a new Ledger instead");
    if (same.some((x) => !recs.some((r) => r.chains[x.chain]?.path === x.path && r.chains[x.chain].address === x.address))) throw wrongDevice();
  }
  // wallets: one per (layout, index), with an address on each chain read
  const groups = new Map();
  for (const x of read) {
    const key = `${x.layout}:${x.index}`;
    const g = groups.get(key) ?? { key, layout: x.layout, index: x.index, chains: {} };
    g.chains[x.chain] = x.chain === 'btc' ? { address: x.address, path: x.path, xpub: x.xpub, fingerprint: x.fingerprint } : { address: x.address, path: x.path };
    groups.set(key, g);
  }
  const found = [...groups.values()];
  const known = new Set((await W.wallets()).flatMap((w) => Object.values(w.chains).map((c) => c.address)));
  const used = await usage(found.map((g) => ({ scheme: g.layout, index: g.index, chains: Object.fromEntries(Object.entries(g.chains).map(([c, v]) => [c, { address: v.address, path: v.path }])) })));
  const id = newId();
  for (const [k, v] of scans) if (Date.now() - v.at > 600_000) scans.delete(k);
  scans.set(id, { at: Date.now(), account, found: new Map(found.map((g) => [g.key, g])) });
  const rows = found.map((g, i) => ({
    key: g.key, layout: g.layout, index: g.index, used: used[i].used, unknown: used[i].unknown,
    added: Object.values(g.chains).some((c) => known.has(c.address)),
    chains: Object.fromEntries(Object.entries(used[i].chains).map(([c, v]) => [c, { address: v.address, path: v.path, used: v.used, amount: v.amount }])),
  }));
  return { id, rows: rows.filter((r) => r.layout === 'plum' ? r.used || r.index < from + 3 || r.added : r.used || r.added) };
}

/** Add the picked wallets of a scan (`keys`) to plum. */
async function add({ id, keys, name, icon }) {
  const s = scans.get(id);
  if (!s || Date.now() - s.at > 600_000) throw new LedgerError('refused', 'that reading of your Ledger is old: read it again');
  if (!Array.isArray(keys) || !keys.length) throw new LedgerError('refused', 'pick at least one wallet');
  const found = keys.map((k) => s.found.get(k));
  if (found.some((f) => !f)) throw new LedgerError('refused', 'one of those wallets is malformed');
  const made = await W.addLedger({ account: s.account, found, name, icon });
  scans.delete(id);
  return made;
}

/** Show a wallet's address on the device, to check it there. */
async function show({ chain, address }) {
  if (!APPS[chain]) throw new LedgerError('refused', 'unknown chain');
  const rec = await W.ledgerOf(chain, address);
  return D.use(APPS[chain], async (link, info, { confirm }) => {
    confirm('check that your Ledger shows this same address, then confirm it there');
    let got;
    if (chain === 'sol') got = await LS.address(link, rec.path, { display: true });
    else if (chain === 'eth') got = await LE.address(link, rec.path, { display: true });
    else {
      LB.checkApp(info);
      if ((await LB.fingerprint(link)) !== rec.fingerprint) throw wrongDevice();
      got = await LB.walletAddress(link, LB.segwitPolicy(rec.fingerprint, rec.xpub), { index: btcIndex(rec.path), display: true });
    }
    if (chain === 'eth' ? !E.sameAddress(got, address) : got !== address) throw wrongDevice();
    return true;
  });
}

/** What plum's pages may ask about Ledgers (all behind the unlock). `usage` is main.js's check of used addresses. */
export function uiMethods({ usage, serial, changed }) {
  return {
    'ledger.status': () => status(),
    'ledger.cancel': () => { cancel(); return true; },
    'ledger.scan': (p) => scan(p ?? {}, usage),
    'ledger.add': (p) => serial(async () => { await add(p ?? {}); return changed(); }),
    'ledger.show': (p) => show(p ?? {}),
  };
}

/** What the approval window says about a request a Ledger signs (null for any other wallet). */
export async function approvalNote(r) {
  if (!(await signsFor(r))) return null;
  const app = APPS[r.chain];
  const notes = {
    sign: 'after you approve it here, your Ledger shows the transaction: approve it there too.',
    signAndSend: 'after you approve it here, your Ledger shows the transaction: approve it there too, then plum sends it.',
    message: "your Ledger signs this as a Solana off-chain message: the site gets the message back inside that wrapper, and some sites can't check that kind of signature.",
    evmTx: "after you approve it here, your Ledger shows the transaction. If it calls a contract, the Ethereum app asks for blind signing to be on in its settings.",
    evmMessage: 'after you approve it here, your Ledger shows the message: sign it there too.',
    evmTyped: "your Ledger shows every field when its Ethereum app has raw messages (or blind signing) turned on in its settings; otherwise it shows the two hashes below. Check them against these.",
  };
  const out = { app, note: notes[r.kind] ?? null };
  if (r.kind === 'evmTyped') {
    try { const h = E.typedHashes(r.typed); out.hashes = { domain: `0x${hex(h.domain)}`, message: h.message ? `0x${hex(h.message)}` : null }; } catch { /* shown without */ }
  }
  return out;
}

/** Why a Ledger can't take a site's request at all (refused before it reaches the approval window), or null. */
export async function refusal(chain, account, kind, bytes = null) {
  if (!(await owns(chain, account))) return null;
  if (kind === 'signIn') return "a Ledger can't sign Sign In With Solana: its Solana app signs off-chain messages in a wrapper the site wouldn't accept. Sign in with another wallet, or ask the site for a message to sign.";
  if (kind === 'message') {
    try { LS.offchainMessage(bytes, new Uint8Array(32)); } catch (e) { return e.message; }
  }
  if (kind === 'sign' && bytes.some((b) => readTx(b).version === 1)) {
    return "your Ledger's Solana app signs legacy and v0 transactions only, and this site sent a v1 transaction: use another wallet for it, or ask the site for a v0 one";
  }
  return null;
}
