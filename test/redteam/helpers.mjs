// Red-team helpers: boot plum's real background page in Node on the fake browser (test/fake-browser.mjs), set a wallet
// up, connect a site, and build hostile transactions / accounts with @solana/web3.js as the oracle.
// Every test file gets its own process (node --test), so `boot()` is called once per file.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { base58Decode, base58Encode } from '../../src/shared/base58.js';
import { b64encode, u64le } from '../../src/shared/bytes.js';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../src/shared/tx.js';
import { fakeBrowser, fakeChain } from '../fake-browser.mjs';

export const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'; // m/44'/501'/0'/0' of the "abandon" phrase
export const PASSWORD = 'plum red team password';
export const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pk = () => Keypair.generate().publicKey;

/**
 * Start the background page on a fake browser and a fake chain. Returns everything a test needs.
 * `fetch` is stubbed to fail (no network); tests that need Jupiter replace globalThis.fetch themselves.
 */
export async function boot({ balance = 10_000_000_000n, phish = { block: ['evil-drainer.com'], allow: [], at: Date.now() } } = {}) {
  const fake = fakeBrowser();
  globalThis.browser = fake.browser;
  const chain = fakeChain({ [ME]: balance });
  const rpcMod = await import('../../src/background/rpc.js');
  rpcMod.transport.post = (url, body) => chain.post(url, body);
  globalThis.fetch = async () => { throw new Error('no network in tests'); };
  if (phish) await fake.browser.storage.local.set({ phish });
  const main = await import('../../src/background/main.js');
  main.start();
  const ui = async (method, params = {}, from) => fake.ui(method, params, from);
  const ok = async (method, params) => {
    const r = await ui(method, params);
    if (!r?.ok) throw new Error(`${method} failed: ${r?.error}`);
    return r.result;
  };
  const err = async (method, params) => {
    const r = await ui(method, params);
    if (!r || r.ok) throw new Error(`${method} should have failed`);
    return r.error;
  };
  const nextApproval = async (timeoutMs = 500) => {
    const until = Date.now() + timeoutMs;
    while (!main._test.pending.size && Date.now() < until) await sleep(5);
    return ok('approval.get');
  };
  /** Approve whatever is first in the queue. */
  const approveNext = async () => { const v = await nextApproval(); await ok('approval.resolve', { id: v.id, approve: true }); return v; };
  const rejectAll = async () => {
    for (const r of [...main._test.pending.values()]) { main._test.pending.delete(r.id); r.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 })); }
  };
  /** A page connected to `origin`: its connect request (and only that one) is approved here, whatever else is queued. */
  const connectSite = async (url) => {
    const origin = new URL(url).origin;
    const page = fake.page(url);
    const answer = page.request('connect');
    const until = Date.now() + 1000;
    let entry = null;
    while (!(entry = [...main._test.pending.values()].find((r) => r.origin === origin && r.kind === 'connect')) && Date.now() < until) await sleep(5);
    if (!entry) throw new Error(`no connect approval appeared for ${origin}`);
    await ok('approval.resolve', { id: entry.id, approve: true });
    const r = await answer;
    if (!r.result) throw new Error(`connect failed: ${r.error?.message}`);
    return page;
  };
  const setup = async () => ok('restore', { password: PASSWORD, mnemonic: ABANDON });
  return { fake, chain, main, _test: main._test, ui, ok, err, nextApproval, approveNext, rejectAll, connectSite, setup, rpcMod };
}

/* ------------------------------------------------------------ transactions */

/** A legacy transaction's wire bytes (unsigned unless `signers`), base64. */
export function legacyB64(payer, ixs, { signers = [], blockhash = BLOCKHASH } = {}) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...ixs);
  if (signers.length) tx.partialSign(...signers);
  return b64encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
export function legacyBytes(payer, ixs, opts) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: opts?.blockhash ?? BLOCKHASH }).add(...ixs);
  if (opts?.signers?.length) tx.partialSign(...opts.signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
export const transferIx = (from, to, lamports = 1000) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
export const PK = (s) => new PublicKey(s);

/** An instruction for an arbitrary ("unknown") program that takes the user's signer privilege. */
export function unknownProgramIx(program, user, extra = [], data = [1]) {
  return new TransactionInstruction({ programId: program, keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...extra], data: Buffer.from(data) });
}

/* ------------------------------------------------------------ accounts, as the RPC returns them (base64) */

export const walletAccount = (lamports, owner = SYSTEM_PROGRAM, data = new Uint8Array(0)) => ({ lamports, owner, data: [b64encode(data), 'base64'], executable: false });

/** An SPL token account's bytes (165), optionally with Token-2022 extensions appended (account type 2 + TLV). */
export function tokenAccount({ mint, owner, amount, delegate = null, delegated = 0n, close = null, program = TOKEN_PROGRAM, extensions = null, lamports = 2_039_280 }) {
  let d = new Uint8Array(165);
  d.set(base58Decode(mint), 0);
  d.set(base58Decode(owner), 32);
  d.set(u64le(amount), 64);
  if (delegate) { d.set([1, 0, 0, 0], 72); d.set(base58Decode(delegate), 76); }
  d[108] = 1;
  d.set(u64le(delegated), 121);
  if (close) { d.set([1, 0, 0, 0], 129); d.set(base58Decode(close), 133); }
  if (extensions) d = Uint8Array.from([...d, 2, ...extensions]);
  return { lamports, owner: program, data: [b64encode(d), 'base64'], executable: false };
}

/** A Token-2022 mint with extensions: 82-byte mint, padding to 165, account type 1, then TLV entries. */
export function mint2022({ authority = null, decimals = 6, supply = 0n, extensions = [] }) {
  const d = new Uint8Array(165);
  if (authority) { d.set([1, 0, 0, 0], 0); d.set(base58Decode(authority), 4); }
  d.set(u64le(supply), 36);
  d[44] = decimals;
  d[45] = 1; // initialized
  const tlv = [];
  for (const { type, data } of extensions) tlv.push(type & 0xff, type >> 8, data.length & 0xff, data.length >> 8, ...data);
  const all = Uint8Array.from([...d, 1, ...tlv]);
  return { lamports: 5_000_000, owner: TOKEN_2022_PROGRAM, data: [b64encode(all), 'base64'], executable: false };
}
export const EXT = { TransferFeeConfig: 1, PermanentDelegate: 12, TransferHook: 14, NonTransferable: 6 };

/** A stand-in RPC for previewTx: `pre` / `post` are address -> account; `sim` is merged into the simulation result. */
export function fakeRpc({ pre = {}, post = {}, sim = {}, lookups = {} } = {}) {
  return {
    async accounts(addrs) { return addrs.map((a) => pre[a] ?? lookups[a] ?? null); },
    async simulate(_b64, addrs) { return { err: null, logs: ['Program log: ok'], unitsConsumed: 1234, fee: 5000, accounts: addrs.map((a) => (a in post ? post[a] : pre[a] ?? null)), ...sim }; },
  };
}
