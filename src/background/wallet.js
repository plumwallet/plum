// The wallet itself: the vault, locked or open; the accounts in it and the wallets each account holds. An account is a
// recovery phrase (12 or 24 words) and its wallets are that phrase's wallet 1, 2, 3...: each one an address on Solana,
// Ethereum and Bitcoin. Private keys you import sit in an account of their own ("imported keys"), one wallet each, on
// the chain the key is for. Secrets never leave this file except as signatures, or as an export you asked for with
// your password.
import { b64decode, b64encode, hex, wipe } from '../shared/bytes.js';
import { ext } from '../shared/ext.js';
import { ICON_IDS, cleanIcon } from '../shared/icons.js';
import { cleanLine } from '../shared/text.js';
import {
  CHAINS, addressOf, btcPublicKey, exportPrivateKey, isMnemonic, isScheme, newMnemonic, normalizeMnemonic, parsePrivateKey,
  schemePaths, secretAt, seedOf, signBtcCompact, signBtcDigest, signEthDigest, signSol, taprootPath, validPath,
} from './keys.js';
import { getSettings, local, session } from './store.js';
import { internalKey, signKeyPath, taprootAddressOf } from './taproot.js';
import { changePassword as rewrap, createVault, passwordOpens, readVault, unlockVault, writeVault } from './vault.js';

export const LOCK_ALARM = 'plum-autolock';
/** The account private keys go into. */
export const KEYS = 'keys';
/** The account a wallet from before accounts held phrases (plum 0.1.5 and older) moves into. */
const FIRST = 'a1';
const SCHEMA = 2;
const MAX_WALLETS = 200;

const newId = () => b64encode(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, 'x');
const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});

/* ------------------------------------------------------------ what's on disk, in the clear
 *
 *  accounts  [{ id, kind: 'phrase' | 'keys', name, words: 12 | 24 | null, backedUp, created }]
 *  wallets   [{ id, account, name, icon, scheme: 'bip44change' | 'bip44' | 'cli' | null, index,
 *               chains: { sol?: { address, path }, eth?: {...}, btc?: { address, path, publicKey,
 *               taproot: { address, path, publicKey } } } }]
 *  active    the wallet you're in
 *  vault     sealed: { v: 2, phrases: { accountId: mnemonic }, keys: { walletId: { chain, secret } } }
 *
 * Addresses are kept in the clear so sites can see the ones you connected while plum is locked; every one is checked
 * against the vault at each unlock.
 */

/** Plum 0.1.5 and older kept one phrase and its "accounts" (what are wallets now): move them across once. The old
 * accounts become wallets of the first account, an imported key's into "imported keys", names like "account 3" become
 * "wallet 3"; their Ethereum and Bitcoin addresses are filled in at the next unlock (that needs the phrase). */
async function migrate() {
  if ((await local.get('schema', 1)) >= SCHEMA) return;
  const old = await local.get('accounts', []);
  if (!Array.isArray(old) || !old.length || !old.every((a) => a && typeof a.address === 'string')) {
    await local.set({ schema: SCHEMA });
    return;
  }
  const rename = (name) => (/^account \d+$/.test(name ?? '') ? name.replace('account', 'wallet') : name);
  const wallets = old.map((a) => {
    if (a.kind === 'key') return { id: a.id, account: KEYS, name: rename(a.name), icon: a.icon ?? null, scheme: null, index: null, chains: { sol: { address: a.address, path: null } } };
    const p = Array.isArray(a.path) ? a.path : null;
    const scheme = !p ? 'cli' : p.length === 4 ? 'bip44change' : 'bip44';
    const index = p ? p[2] : 0;
    return { id: a.id, account: FIRST, name: rename(a.name), icon: a.icon ?? null, scheme, index, chains: { sol: { address: a.address, path: p ? `m/${p.map((n) => `${n}'`).join('/')}` : null } } };
  });
  const accounts = [];
  if (wallets.some((w) => w.account === FIRST)) accounts.push({ id: FIRST, kind: 'phrase', name: 'account 1', words: null, backedUp: true, created: Date.now() });
  if (wallets.some((w) => w.account === KEYS)) accounts.push({ id: KEYS, kind: 'keys', name: 'imported keys', words: null, backedUp: true, created: Date.now() });
  await local.set({ accounts, wallets, schema: SCHEMA });
}

let migrating = null;
/** Every entry point waits for this: the move from the old layout, if it's still to do. */
export const ready = () => (migrating ??= migrate().catch((e) => { migrating = null; throw e; }));

/* ------------------------------------------------------------ open or locked */

/** The open vault, in memory only: { dataKey, data } or null. */
let open = null;
/** Seeds of the phrases (per account) and the secrets derived from them (per wallet and chain), once per unlock. */
const seeds = new Map();
const derived = new Map();

export async function hasVault() {
  await ready();
  return !!(await local.get('vault'));
}

/** The vault's data in the current layout, whatever version wrote it. */
function upgradeData(data) {
  if (data?.v === 2) return { data, changed: false };
  const phrases = data?.mnemonic ? { [FIRST]: data.mnemonic } : {};
  const keys = Object.fromEntries(Object.entries(data?.keys ?? {}).map(([id, secret]) => [id, { chain: 'sol', secret }]));
  return { data: { v: 2, phrases, keys }, changed: true };
}

async function openWith(dataKey, data) {
  const up = upgradeData(data);
  open = { dataKey, data: up.data };
  if (up.changed) await local.set({ vault: await writeVault(await local.get('vault'), dataKey, up.data) });
}

/** Is the vault open? Picks the data key back up from storage.session after the browser suspends the background
 * (Firefox's event page, Chromium's service worker). */
export async function isUnlocked() {
  await ready();
  if (open) return true;
  const dk = await session.get('dataKey');
  if (!dk) return false;
  const vault = await local.get('vault');
  if (!vault) return false;
  try {
    const dataKey = b64decode(dk);
    await openWith(dataKey, await readVault(vault, dataKey));
    return true;
  } catch {
    await session.remove('dataKey');
    return false;
  }
}

async function requireOpen() {
  if (!(await isUnlocked())) throw fail('plum is locked', 'locked');
  return open;
}

/** Keep the auto-lock timer running from now. */
export async function touch() {
  if (!open) return;
  const { autolockMin } = await getSettings();
  await ext().alarms.create(LOCK_ALARM, { delayInMinutes: autolockMin });
}

async function remember(dataKey, data) {
  await openWith(dataKey, data);
  await session.set({ dataKey: b64encode(dataKey) });
  await touch();
}

function forgetSecrets() {
  for (const s of derived.values()) wipe(s);
  derived.clear();
  for (const s of seeds.values()) wipe(s);
  seeds.clear();
}

export async function lock() {
  if (open) wipe(open.dataKey);
  forgetSecrets();
  open = null;
  await session.remove(['dataKey']);
  await ext().alarms.clear(LOCK_ALARM);
}

/* ------------------------------------------------------------ password tries: slower after the third miss */
// kept on disk, so restarting the browser doesn't reset the count

async function throttle() {
  const t = await local.get('tries', { fails: 0, next: 0 });
  const wait = Math.ceil((t.next - Date.now()) / 1000);
  if (wait > 0) throw fail(`too many wrong passwords: try again in ${wait}s`, 'throttled');
  return t;
}
async function missed(t) {
  const fails = t.fails + 1;
  const next = fails >= 3 ? Date.now() + Math.min(300, 2 ** (fails - 3)) * 1000 : 0;
  await local.set({ tries: { fails, next } });
}

export async function unlock(password) {
  await ready();
  const vault = await local.get('vault');
  if (!vault) throw fail('there is no wallet yet');
  const t = await throttle();
  let res;
  try {
    res = await unlockVault(vault, password);
  } catch (e) {
    if (e.message === 'wrong password') await missed(t);
    throw e;
  }
  await local.remove('tries');
  await remember(res.dataKey, res.data);
  await verifyWallets();
}

/** Ask for the password again (before showing a secret). */
export async function checkPassword(password) {
  const t = await throttle();
  if (!(await passwordOpens(await local.get('vault'), password))) {
    await missed(t);
    throw fail('wrong password');
  }
  await local.remove('tries');
}

async function save(data) {
  const o = await requireOpen();
  const vault = await writeVault(await local.get('vault'), o.dataKey, data);
  await local.set({ vault });
  o.data = data;
}

/* ------------------------------------------------------------ accounts and wallets (public) */

export async function accounts() {
  await ready();
  return local.get('accounts', []);
}

export async function wallets() {
  await ready();
  const list = await local.get('wallets', []);
  return Array.isArray(list) ? list.filter((w) => w && typeof w === 'object' && w.chains && typeof w.chains === 'object') : [];
}

export async function activeWallet() {
  const list = await wallets();
  const id = await local.get('active');
  return list.find((w) => w.id === id) ?? list[0] ?? null;
}

export async function select(id) {
  const list = await wallets();
  if (!list.some((w) => w.id === id)) throw fail('no such wallet');
  await local.set({ active: id });
}

/** The wallet holding an address on a chain. */
export async function walletOf(chain, address) {
  return (await wallets()).find((w) => w.chains[chain]?.address === address) ?? null;
}

const nextName = (taken, base) => {
  let n = 1;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
};
// one line of text, hidden characters (bidi marks, zero-widths...) taken out: names are drawn in the approval window
const cleanName = (name, max = 24) => cleanLine(String(name ?? '').replace(/\s+/g, ' '), max);

/** Which wallets of a phrase to add: [{ scheme, index }], checked (only plum's own derivations, sane numbers). */
function checkPicks(picks) {
  if (!Array.isArray(picks) || !picks.length) throw fail('pick at least one wallet');
  if (picks.length > 50) throw fail('pick at most 50 wallets at a time');
  const seen = new Set();
  return picks.filter((p) => {
    if (!p || !isScheme(p.scheme) || !Number.isInteger(p.index) || p.index < 0 || p.index >= 10_000) throw fail('one of those wallets is malformed');
    if (p.scheme === 'cli' && p.index !== 0) throw fail('one of those wallets is malformed');
    const key = `${p.scheme}:${p.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A wallet's Bitcoin side: its native segwit address and, beside it, its taproot one (the phrase's BIP-86 key, or an
 * imported key itself), each with the public key sites build transactions for (taproot's is the x-only internal key). */
function btcChain(secret, path, trSecret, trPath) {
  return {
    address: addressOf('btc', secret), path, publicKey: hex(btcPublicKey(secret)),
    taproot: { address: taprootAddressOf(trSecret), path: trPath, publicKey: hex(internalKey(trSecret)) },
  };
}

/** The wallet records for picks of a phrase (addresses from its seed). */
function walletsFor(seed, accountId, picks, { names = [], icons = [] } = {}) {
  return picks.map((p, i) => {
    const paths = schemePaths(p.scheme, p.index);
    const chains = {};
    for (const [chain, path] of Object.entries(paths)) {
      const secret = secretAt(seed, chain, path);
      if (chain === 'btc') {
        const tr = secretAt(seed, 'btc', taprootPath(p.scheme, p.index));
        chains.btc = btcChain(secret, path, tr, taprootPath(p.scheme, p.index));
        wipe(tr);
      } else chains[chain] = { address: addressOf(chain, secret), path };
      wipe(secret);
    }
    return { id: newId(), account: accountId, name: names[i], icon: icons[i] ?? null, scheme: p.scheme, index: p.index, chains };
  });
}

/** A wallet's own name for its place in the phrase: "wallet 3", or "old wallet 3" on Phantom's older grouping, or
 * "cli wallet" for the Solana CLI's key. */
const defaultName = (p) => (p.scheme === 'bip44change' ? `wallet ${p.index + 1}` : p.scheme === 'cli' ? 'cli wallet' : `old wallet ${p.index + 1}`);

/** Names for new wallets of an account: the one you typed for the first ("main", then "main 2", "main 3"), else each
 * one's own (defaultName). */
function nameWallets(picks, taken, typed) {
  const out = [];
  const used = [...taken];
  picks.forEach((p, i) => {
    let name = typed ? (i === 0 ? typed : `${typed.slice(0, 20)} ${i + 1}`) : defaultName(p);
    if (used.includes(name)) name = nextName(used, typed || 'wallet');
    used.push(name);
    out.push(name);
  });
  return out;
}

/** Icons for new wallets: the one you picked on them all, else each its own (the first ones in the picker that no
 * wallet wears yet), so wallets are easy to tell apart at a glance. */
function iconsFor(count, picked, worn) {
  const face = cleanIcon(picked);
  if (face) return Array(count).fill(face);
  const free = ICON_IDS.filter((id) => !worn.includes(id));
  const pool = free.length >= count ? free : [...free, ...ICON_IDS];
  return pool.slice(0, count);
}

/** Is this phrase already one of plum's accounts? (Compared by the phrase itself, inside the open vault.) */
function phraseOwner(o, phrase) {
  return Object.entries(o.data.phrases).find(([, m]) => m === phrase)?.[0] ?? null;
}

/**
 * The first wallet on this computer: a new vault holding one recovery phrase (fresh or brought along) and the wallets
 * picked from it (wallet 1 by default). The name you type names the first wallet (the rest are numbered after it), and
 * the icon goes on them all.
 */
export async function create({ password, mnemonic, picks = [{ scheme: 'bip44change', index: 0 }], name, icon, backedUp = true }) {
  if (await hasVault()) throw fail('plum already has a wallet: reset it in settings first');
  if (!isMnemonic(mnemonic)) throw fail("that recovery phrase isn't valid: check the words and their order");
  const phrase = normalizeMnemonic(mnemonic);
  const chosen = checkPicks(picks);
  const seed = seedOf(phrase);
  const accountId = newId();
  const list = walletsFor(seed, accountId, chosen, { names: nameWallets(chosen, [], cleanName(name, 20)), icons: iconsFor(chosen.length, icon, []) });
  wipe(seed);
  const account = { id: accountId, kind: 'phrase', name: 'account 1', words: phrase.split(' ').length, backedUp: !!backedUp, created: Date.now() };
  const data = { v: 2, phrases: { [accountId]: phrase }, keys: {} };
  const { vault, dataKey } = await createVault(password, data);
  await local.set({ vault, accounts: [account], wallets: list, active: list[0].id, schema: SCHEMA });
  await remember(dataKey, data);
  return { account, wallets: list };
}

/** Another recovery phrase, into the open vault: a new account holding the wallets picked from it. */
export async function addAccount({ mnemonic, picks = [{ scheme: 'bip44change', index: 0 }], name, icon, backedUp = true }) {
  const o = await requireOpen();
  if (!isMnemonic(mnemonic)) throw fail("that recovery phrase isn't valid: check the words and their order");
  const phrase = normalizeMnemonic(mnemonic);
  const all = await accounts();
  const owner = phraseOwner(o, phrase);
  if (owner) throw fail(`that recovery phrase is already in plum, as ${all.find((a) => a.id === owner)?.name ?? 'one of your accounts'}`);
  const chosen = checkPicks(picks);
  const existing = await wallets();
  const seed = seedOf(phrase);
  const accountId = newId();
  const list = walletsFor(seed, accountId, chosen, { names: nameWallets(chosen, [], ''), icons: iconsFor(chosen.length, icon, existing.map((w) => w.icon)) });
  wipe(seed);
  const known = new Set(existing.flatMap((w) => Object.values(w.chains).map((c) => c.address)));
  if (list.some((w) => Object.values(w.chains).some((c) => known.has(c.address)))) throw fail('one of those wallets is already in plum (as an imported key): remove it there first');
  const phrases = all.filter((a) => a.kind === 'phrase');
  const account = { id: accountId, kind: 'phrase', name: cleanName(name, 20) || nextName(phrases.map((a) => a.name), 'account'), words: phrase.split(' ').length, backedUp: !!backedUp, created: Date.now() };
  await save({ ...o.data, phrases: { ...o.data.phrases, [accountId]: phrase } });
  // the new account goes after the other phrases, ahead of imported keys
  const at = all.findIndex((a) => a.kind === 'keys');
  const nextAccounts = at < 0 ? [...all, account] : [...all.slice(0, at), account, ...all.slice(at)];
  await local.set({ accounts: nextAccounts, wallets: [...existing, ...list], active: list[0].id });
  return { account, wallets: list };
}

/** A brand-new phrase as a new account (its words go back to you once, to write down). */
export async function newAccount({ words = 12, name, icon }) {
  const phrase = newMnemonic(words === 24 ? 24 : 12);
  const made = await addAccount({ mnemonic: phrase, name, icon, backedUp: false });
  return { ...made, phrase };
}

/** The next wallet of an account's phrase: the lowest number it doesn't show yet. */
export async function addWallet(accountId, { name, icon } = {}) {
  const o = await requireOpen();
  const account = (await accounts()).find((a) => a.id === accountId);
  if (!account || account.kind !== 'phrase') throw fail('new wallets come from a recovery phrase: pick one of your accounts');
  const list = await wallets();
  const mine = list.filter((w) => w.account === accountId);
  if (mine.length >= MAX_WALLETS) throw fail(`an account holds ${MAX_WALLETS} wallets at most`);
  const taken = new Set(mine.filter((w) => w.scheme === 'bip44change').map((w) => w.index));
  let index = 0;
  while (taken.has(index)) index++;
  const [w] = walletsFor(seedFor(o, accountId), accountId, [{ scheme: 'bip44change', index }], {
    names: [cleanName(name) || (mine.some((x) => x.name === `wallet ${index + 1}`) ? nextName(mine.map((x) => x.name), 'wallet') : `wallet ${index + 1}`)],
    icons: iconsFor(1, icon, list.map((x) => x.icon)),
  });
  await local.set({ wallets: [...list, w], active: w.id });
  return w;
}

/** Which chain a private key is for and the address it opens, to check it before importing: nothing is kept. */
export async function keyInfo(secret) {
  const { chain, secret: key } = parsePrivateKey(secret);
  const address = addressOf(chain, key);
  const taproot = chain === 'btc' ? taprootAddressOf(key) : undefined;
  wipe(key);
  if ((await wallets()).some((w) => w.chains[chain]?.address === address)) throw fail('that wallet is already in plum');
  return { chain, address, taproot };
}

/** A private key as a wallet of its own (in "imported keys"): a new vault holding it, or added to the open one. */
export async function importKey({ password, secret, name, icon }) {
  const { chain, secret: key } = parsePrivateKey(secret);
  const address = addressOf(chain, key);
  const list = await wallets();
  if (list.some((w) => w.chains[chain]?.address === address)) { wipe(key); throw fail('that wallet is already in plum'); }
  const wallet = { id: newId(), account: KEYS, name: cleanName(name) || nextName(list.filter((w) => w.account === KEYS).map((w) => w.name), 'imported'), icon: iconsFor(1, icon, list.map((w) => w.icon))[0], scheme: null, index: null, chains: { [chain]: chain === 'btc' ? btcChain(key, null, key, null) : { address, path: null } } };
  const entry = { chain, secret: b64encode(key) };
  wipe(key);
  const keysAccount = { id: KEYS, kind: 'keys', name: 'imported keys', words: null, backedUp: true, created: Date.now() };
  if (!(await hasVault())) {
    const data = { v: 2, phrases: {}, keys: { [wallet.id]: entry } };
    const { vault, dataKey } = await createVault(password, data);
    await local.set({ vault, accounts: [keysAccount], wallets: [wallet], active: wallet.id, schema: SCHEMA });
    await remember(dataKey, data);
  } else {
    const o = await requireOpen();
    await save({ ...o.data, keys: { ...o.data.keys, [wallet.id]: entry } });
    const all = await accounts();
    await local.set({ accounts: all.some((a) => a.id === KEYS) ? all : [...all, keysAccount], wallets: [...list, wallet], active: wallet.id });
  }
  return wallet;
}

export async function renameWallet(id, name) {
  const n = cleanName(name);
  if (!n) throw fail('give it a name');
  const list = await wallets();
  if (!list.some((w) => w.id === id)) throw fail('no such wallet');
  await local.set({ wallets: list.map((w) => (w.id === id ? { ...w, name: n } : w)) });
}

export async function renameAccount(id, name) {
  const n = cleanName(name, 20);
  if (!n) throw fail('give it a name');
  const list = await accounts();
  if (!list.some((a) => a.id === id)) throw fail('no such account');
  await local.set({ accounts: list.map((a) => (a.id === id ? { ...a, name: n } : a)) });
}

/** Give a wallet one of plum's icons. */
export async function setIcon(id, icon) {
  const face = cleanIcon(icon);
  if (!face) throw fail('pick one of the icons');
  const list = await wallets();
  if (!list.some((w) => w.id === id)) throw fail('no such wallet');
  await local.set({ wallets: list.map((w) => (w.id === id ? { ...w, icon: face } : w)) });
}

/** You wrote the phrase down: stop reminding you. */
export async function markBackedUp(id) {
  const list = await accounts();
  await local.set({ accounts: list.map((a) => (a.id === id ? { ...a, backedUp: true } : a)) });
}

async function afterRemoval(rest) {
  const active = await local.get('active');
  if (!rest.some((w) => w.id === active)) await local.set({ active: rest[0].id });
}

/** Take a wallet out of plum. A phrase's wallet is only hidden ("+ new wallet" brings it back); an imported key is
 * erased from the vault (export it first). */
export async function removeWallet(id) {
  const list = await wallets();
  const w = list.find((x) => x.id === id);
  if (!w) throw fail('no such wallet');
  if (list.length <= 1) throw fail("that's your only wallet");
  if (w.account !== KEYS && list.filter((x) => x.account === w.account).length <= 1) throw fail("that's this account's only wallet: remove the account instead");
  if (w.account === KEYS) {
    const o = await requireOpen();
    const keys = { ...o.data.keys };
    delete keys[id];
    await save({ ...o.data, keys });
  }
  for (const chain of CHAINS) { const s = derived.get(`${id}:${chain}`); if (s) { wipe(s); derived.delete(`${id}:${chain}`); } }
  const rest = list.filter((x) => x.id !== id);
  const all = await accounts();
  await local.set({ wallets: rest, accounts: rest.some((x) => x.account === KEYS) ? all : all.filter((a) => a.id !== KEYS) });
  await afterRemoval(rest);
}

/** Take an account out of plum: its recovery phrase is erased from the vault and its wallets go with it. */
export async function removeAccount(id) {
  const all = await accounts();
  const account = all.find((a) => a.id === id);
  if (!account) throw fail('no such account');
  const list = await wallets();
  const rest = list.filter((w) => w.account !== id);
  if (!rest.length) throw fail("that's your only account: reset plum (in settings) to start over");
  const o = await requireOpen();
  const phrases = { ...o.data.phrases };
  delete phrases[id];
  const keys = Object.fromEntries(Object.entries(o.data.keys).filter(([wid]) => rest.some((w) => w.id === wid)));
  await save({ ...o.data, phrases, keys });
  const s = seeds.get(id);
  if (s) { wipe(s); seeds.delete(id); }
  for (const w of list.filter((x) => x.account === id)) for (const chain of CHAINS) { const k = derived.get(`${w.id}:${chain}`); if (k) { wipe(k); derived.delete(`${w.id}:${chain}`); } }
  await local.set({ accounts: all.filter((a) => a.id !== id), wallets: rest });
  await afterRemoval(rest);
}

/* ------------------------------------------------------------ secrets in use */

function seedFor(o, accountId) {
  const phrase = Object.hasOwn(o.data.phrases, accountId) ? o.data.phrases[accountId] : undefined;
  if (!phrase) throw fail("this account's recovery phrase is missing from the vault");
  let s = seeds.get(accountId);
  if (!s) { s = seedOf(phrase); seeds.set(accountId, s); }
  return s;
}

/** A phrase wallet's path on a chain, worked out from its derivation and number (never read from disk, where it's
 * kept only to show): null for the Solana CLI's key, undefined when that derivation has no such chain. */
function pathOf(w, chain) {
  if (!isScheme(w.scheme) || !Number.isInteger(w.index) || w.index < 0 || w.index >= 10_000) return undefined;
  const p = schemePaths(w.scheme, w.index)[chain];
  return p === undefined || !validPath(chain, p) ? undefined : p;
}

/** A phrase wallet's taproot path (BIP-86, beside its m/84' one), worked out like pathOf. */
const taprootPathOf = (w) => (pathOf(w, 'btc') === undefined ? undefined : taprootPath(w.scheme, w.index));

/** A wallet's Bitcoin side from its segwit secret: the taproot key is the phrase's BIP-86 one, or an imported key
 * itself. */
function btcFor(o, w, secret, path) {
  if (w.account === KEYS) return btcChain(secret, null, secret, null);
  const trPath = taprootPathOf(w);
  if (!trPath) return { address: addressOf('btc', secret), path, publicKey: hex(btcPublicKey(secret)) };
  const tr = secretAt(seedFor(o, w.account), 'btc', trPath);
  try { return btcChain(secret, path, tr, trPath); } finally { wipe(tr); }
}
const sameBtc = (a, b) => !!b && a.address === b.address && a.path === b.path && a.publicKey === b.publicKey
  && a.taproot?.address === b.taproot?.address && a.taproot?.path === b.taproot?.path && a.taproot?.publicKey === b.taproot?.publicKey;

/** The secret behind a wallet's address on a chain. With `trust`, it's rebuilt from the vault without checking the
 * address on disk (the unlock check uses that to put a tampered address right). */
async function secretOf(w, chain, { trust = false } = {}) {
  const o = await requireOpen();
  const c = w.chains[chain];
  if (!c) throw fail(`this wallet has no ${chain} address`);
  if (w.account === KEYS) {
    const k = Object.hasOwn(o.data.keys, w.id) ? o.data.keys[w.id] : undefined;
    if (!k || k.chain !== chain) throw fail("this wallet's key is missing from the vault");
    return b64decode(k.secret);
  }
  const memo = `${w.id}:${chain}`;
  let s = trust ? null : derived.get(memo);
  // a cached key is used only for the address it opens (ids come from disk, and nothing on disk is trusted)
  if (s && addressOf(chain, s) !== c.address) s = null;
  if (!s) {
    const path = pathOf(w, chain);
    if (path === undefined) throw fail('this wallet asks for a derivation plum does not use');
    s = secretAt(seedFor(o, w.account), chain, path);
    if (trust) return s;
    if (addressOf(chain, s) !== c.address) { wipe(s); throw fail("this wallet doesn't match its recovery phrase"); }
    const old = derived.get(memo);
    if (old) wipe(old);
    derived.set(memo, s);
  }
  return s.slice();
}

/**
 * The wallet list is checked against the vault at every unlock, so nobody who could edit the browser profile's storage
 * can swap in their own address to receive into: an address that doesn't come from its key is put right, a chain that
 * can't be rebuilt from the vault is dropped (and a wallet left with none goes), and wallets moved over from before
 * accounts held phrases get their Ethereum and Bitcoin addresses.
 */
async function verifyWallets() {
  const raw = await local.get('wallets', []);
  const list = await wallets(); // well-formed entries only
  const o = open;
  let changed = !Array.isArray(raw) || list.length !== raw.length;
  const fixed = [];
  const ids = new Set();
  for (let w of list) {
    // each id once (the derived-key cache is keyed by it); names one clean line, icons plum's own
    if (typeof w.id !== 'string' || ids.has(w.id)) { w = { ...w, id: newId() }; changed = true; }
    ids.add(w.id);
    const name = cleanName(w.name) || 'wallet';
    const icon = cleanIcon(w.icon);
    if (name !== w.name || icon !== (w.icon ?? null)) { w = { ...w, name, icon }; changed = true; }
    const chains = {};
    const want = new Set(Object.keys(w.chains ?? {}));
    // a wallet from before: the chains its derivation has that it doesn't show yet
    if (w.account !== KEYS && Object.hasOwn(o.data.phrases, w.account)) for (const chain of CHAINS) if (pathOf(w, chain) !== undefined) want.add(chain);
    for (const chain of want) {
      let secret;
      try { secret = CHAINS.includes(chain) ? await secretOf({ ...w, chains: { [chain]: w.chains?.[chain] ?? {} } }, chain, { trust: true }) : null; } catch { secret = null; }
      if (!secret) { changed = true; continue; }
      const path = w.account === KEYS ? null : pathOf(w, chain);
      const rec = chain === 'btc' ? btcFor(o, w, secret, path) : { address: addressOf(chain, secret), path };
      wipe(secret);
      if (chain === 'btc' ? !sameBtc(rec, w.chains?.btc) : rec.address !== w.chains?.[chain]?.address || path !== w.chains?.[chain]?.path) changed = true;
      chains[chain] = rec;
    }
    if (Object.keys(chains).length) fixed.push({ ...w, chains });
    else changed = true;
  }
  // the vault is the truth: every phrase in it is an account you can see, with at least its wallet 1, so a list edited
  // on disk can't hide one (importing it again would be refused: it's already in the vault)
  const stored = await local.get('accounts', []);
  let accts = Array.isArray(stored) ? stored.filter((a) => a && typeof a.id === 'string' && (a.kind !== 'phrase' || Object.hasOwn(o.data.phrases, a.id))) : [];
  let accountsChanged = accts.length !== (Array.isArray(stored) ? stored.length : -1);
  for (const [id, phrase] of Object.entries(o.data.phrases)) {
    if (!accts.some((a) => a.id === id)) {
      const account = { id, kind: 'phrase', name: nextName(accts.map((a) => a.name), 'account'), words: phrase.split(' ').length, backedUp: true, created: Date.now() };
      const at = accts.findIndex((a) => a.kind === 'keys');
      accts = at < 0 ? [...accts, account] : [...accts.slice(0, at), account, ...accts.slice(at)];
      accountsChanged = true;
    }
    if (!fixed.some((w) => w.account === id)) {
      fixed.push(...walletsFor(seedFor(o, id), id, [{ scheme: 'bip44change', index: 0 }], { names: ['wallet 1'], icons: iconsFor(1, null, fixed.map((w) => w.icon)) }));
      changed = true;
    }
  }
  if (Object.keys(o.data.keys).length && !accts.some((a) => a.id === KEYS)) {
    accts = [...accts, { id: KEYS, kind: 'keys', name: 'imported keys', words: null, backedUp: true, created: Date.now() }];
    accountsChanged = true;
  }
  if (accountsChanged) await local.set({ accounts: accts });
  if (changed) {
    for (const s of derived.values()) wipe(s);
    derived.clear();
    await local.set({ wallets: fixed });
    const active = await local.get('active');
    if (fixed.length && !fixed.some((w) => w.id === active)) await local.set({ active: fixed[0].id });
  }
}

async function walletFor(chain, address) {
  const w = await walletOf(chain, address);
  if (!w) throw fail(`that address isn't one of your wallets`);
  return w;
}

/** Sign bytes with a wallet's Solana key. */
export async function signSolAs(address, message) {
  const secret = await secretOf(await walletFor('sol', address), 'sol');
  try { return signSol(message, secret); } finally { wipe(secret); await touch(); }
}

/** Sign a 32-byte digest with a wallet's Ethereum key: { r, s, yParity }. */
export async function signEthAs(address, digest) {
  const secret = await secretOf(await walletFor('eth', address), 'eth');
  try { return signEthDigest(digest, secret); } finally { wipe(secret); await touch(); }
}

/** Sign Bitcoin sighashes with a wallet's key: DER signatures, and the public key that goes beside them. */
export async function signBtcAs(address, digests) {
  const secret = await secretOf(await walletFor('btc', address), 'btc');
  try { return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcDigest(d, secret)) }; } finally { wipe(secret); await touch(); }
}

/** The key behind one of your Bitcoin addresses (bc1q or bc1p), checked against the address on disk. */
async function btcKeyFor(address) {
  const w = (await wallets()).find((x) => x.chains.btc?.address === address || x.chains.btc?.taproot?.address === address);
  if (!w || typeof address !== 'string') throw fail("that address isn't one of your wallets");
  if (w.chains.btc.address === address) return { taproot: false, secret: await secretOf(w, 'btc') };
  const o = await requireOpen();
  const trPath = taprootPathOf(w);
  const secret = w.account === KEYS ? await secretOf(w, 'btc') : trPath ? secretAt(seedFor(o, w.account), 'btc', trPath) : null;
  if (!secret) throw fail('this wallet asks for a derivation plum does not use');
  if (taprootAddressOf(secret) !== address) { wipe(secret); throw fail("this wallet doesn't match its recovery phrase"); }
  return { taproot: true, secret };
}

/**
 * Sign Bitcoin signature hashes with the key behind one of your addresses: ECDSA (DER, low s) and the public key for a
 * bc1q address; BIP-340 with the BIP-86 tweaked key for a bc1p one ({ outputKey, signatures }). With `compact`, 65-byte
 * recoverable ECDSA signatures by that address's own key instead (Bitcoin's legacy signed messages).
 */
export async function signBitcoinAs(address, digests, { compact = false } = {}) {
  const { taproot, secret } = await btcKeyFor(address);
  try {
    if (compact) return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcCompact(d, secret)) };
    if (taproot) return signKeyPath(digests, secret);
    return { publicKey: btcPublicKey(secret), signatures: digests.map((d) => signBtcDigest(d, secret)) };
  } finally { wipe(secret); await touch(); }
}

/** A wallet's private key on one chain, after your password. */
export async function exportKey(id, chain, password) {
  await checkPassword(password);
  const w = (await wallets()).find((x) => x.id === id);
  if (!w) throw fail('no such wallet');
  const secret = await secretOf(w, chain);
  try { return exportPrivateKey(chain, secret); } finally { wipe(secret); }
}

/** An account's recovery phrase, after your password. */
export async function exportPhrase(accountId, password) {
  await checkPassword(password);
  const o = await requireOpen();
  const phrase = Object.hasOwn(o.data.phrases, accountId) ? o.data.phrases[accountId] : undefined;
  if (!phrase) throw fail('this account has no recovery phrase (it holds imported keys)');
  return phrase;
}

export async function changePassword(oldPassword, newPassword) {
  const t = await throttle();
  let res;
  try {
    res = await rewrap(await local.get('vault'), oldPassword, newPassword);
  } catch (e) {
    if (e.message === 'wrong password') await missed(t);
    throw e;
  }
  await local.remove('tries');
  await local.set({ vault: res.vault });
  if (open) wipe(open.dataKey);
  await remember(res.dataKey, res.data);
}

/** Forget everything: the vault, accounts, wallets, sites, settings. */
export async function reset() {
  await lock();
  await local.clear();
  await session.clear();
}

/* ------------------------------------------------------------ what a phrase holds, for the import picker */

/**
 * The wallets a phrase could hold: plum's own (wallet 1, 2, 3... on every chain), plus Phantom's older grouping and
 * the Solana CLI's key. Addresses only; main.js asks the chains which have been used.
 */
export function phraseWallets(mnemonic, { from = 0, count = 10, extras = true } = {}) {
  const seed = seedOf(mnemonic);
  const picks = [];
  for (let i = from; i < from + count; i++) picks.push({ scheme: 'bip44change', index: i });
  if (extras) {
    for (let i = 0; i < 3; i++) picks.push({ scheme: 'bip44', index: i });
    picks.push({ scheme: 'cli', index: 0 });
  }
  const out = walletsFor(seed, null, picks).map((w) => ({ scheme: w.scheme, index: w.index, chains: w.chains }));
  wipe(seed);
  return out;
}

export const _test = { migrate, upgradeData, seeds, derived };
