// A stand-in for Firefox's `browser` APIs and a tiny Solana RPC, enough to run plum's background page in Node:
// storage, alarms, windows, tabs, the popup's messages and a web page's port.
import { base58Encode } from '../src/shared/base58.js';
import { b64decode, readU32, readU64 } from '../src/shared/bytes.js';
import { SYSTEM_PROGRAM, readTx } from '../src/shared/tx.js';

const EXT_ID = 'plum@test';
const BASE = 'moz-extension://plum-test/';

function area() {
  const m = new Map();
  return {
    async get(k) {
      const keys = typeof k === 'string' ? [k] : Array.isArray(k) ? k : [...m.keys()];
      return Object.fromEntries(keys.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))]));
    },
    async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async clear() { m.clear(); },
    _m: m,
  };
}

export function fakeBrowser() {
  const L = { message: [], connect: [], removed: [], alarm: [], idle: [], installed: [], startup: [] };
  const on = (list) => ({ addListener: (f) => list.push(f) });
  const windows = new Map();
  let wid = 1;
  const alarms = new Map();
  const tabMessages = [];
  const created = [];
  const b = {
    runtime: { id: EXT_ID, getURL: (p) => BASE + p, onMessage: on(L.message), onConnect: on(L.connect), onInstalled: on(L.installed), onStartup: on(L.startup) },
    storage: { local: area(), session: area() },
    alarms: { create: async (name, info) => { alarms.set(name, info); }, clear: async (name) => alarms.delete(name), onAlarm: on(L.alarm) },
    windows: {
      create: async (o) => { const id = wid++; windows.set(id, o); created.push(o); return { id }; },
      update: async (id) => { if (!windows.has(id)) throw new Error('no such window'); },
      getLastFocused: async () => ({ left: 100, top: 50, width: 1280 }),
      onRemoved: on(L.removed),
    },
    tabs: { query: async () => [{ id: 1 }, { id: 2 }], sendMessage: async (id, m) => { tabMessages.push([id, m]); }, create: async (o) => { created.push(o); return {}; } },
    idle: { onStateChanged: on(L.idle) },
  };
  return {
    browser: b,
    alarms,
    windows,
    created,
    tabMessages,
    closeWindow(id) { windows.delete(id); for (const f of L.removed) f(id); },
    fireAlarm(name) { for (const f of L.alarm) f({ name }); },
    fireIdle(state) { for (const f of L.idle) f(state); },
    /** A call from one of plum's pages (or, with `from`, from somewhere else), answered as Chromium does it: through
     * sendResponse, with the listener returning true to keep the channel open (undefined when it doesn't answer). */
    async ui(method, params = {}, from = `${BASE}popup.html`) {
      return new Promise((resolve) => {
        const keep = L.message[0]({ type: 'plum-ui', method, params }, { id: EXT_ID, url: from }, resolve);
        if (keep !== true) resolve(undefined);
      });
    },
    /** A web page's content script connecting. */
    page(url, { frameId = 0, tab = { id: 7 }, id = EXT_ID } = {}) {
      const msgL = [], discL = [];
      const replies = new Map();
      let n = 0;
      const port = {
        name: 'plum-page',
        sender: { id, url, tab, frameId },
        disconnected: false,
        onMessage: on(msgL),
        onDisconnect: on(discL),
        postMessage: (m) => { const r = replies.get(m.id); if (r) { replies.delete(m.id); r(m); } },
        disconnect: () => { port.disconnected = true; },
      };
      for (const f of L.connect) f(port);
      return {
        port,
        request(method, params) {
          const rid = `r${++n}`;
          return new Promise((resolve) => { replies.set(rid, resolve); for (const f of msgL) f({ id: rid, method, params }); });
        },
        close() { for (const f of discL) f(); },
      };
    },
  };
}

/**
 * A tiny chain: balances by address, System transfers simulated and applied, everything else answered plainly.
 * `log` records each call's method.
 */
export function fakeChain(balances = {}) {
  const bal = new Map(Object.entries(balances).map(([k, v]) => [k, BigInt(v)]));
  const log = [];
  const sentTxs = [];
  const run = (b64) => {
    const t = readTx(b64decode(b64));
    const after = new Map(bal);
    const get = (a) => after.get(a) ?? BigInt(accounts.get(a)?.lamports ?? 0);
    after.set(t.keys[0], get(t.keys[0]) - 5000n * BigInt(t.required));
    let err = null;
    for (const ix of t.instructions) {
      const program = t.keys[ix.programIndex];
      // Transfer (2), CreateAccount (0) and CreateAccountWithSeed (3) move lamports from the first account to the second,
      // and so does the stake program's Withdraw (4)
      const kind = program === SYSTEM_PROGRAM && ix.data.length >= 12 ? readU32(ix.data, 0) : null;
      const withdraw = program === 'Stake11111111111111111111111111111111111111' && ix.data.length >= 12 && readU32(ix.data, 0) === 4;
      const at = kind === 2 || kind === 0 || withdraw ? 4 : kind === 3 ? 36 + 8 + Number(readU64(ix.data, 36)) : null;
      if (at != null && ix.data.length >= at + 8) {
        const [from, to] = ix.accounts.map((i) => t.keys[i]);
        const lamports = readU64(ix.data, at);
        if (get(from) < lamports) err = { InstructionError: [0, { Custom: 1 }] };
        after.set(from, get(from) - lamports);
        after.set(to, get(to) + lamports);
      }
    }
    return { t, after, err };
  };
  // accounts with data (vote and stake accounts, NFTs), by address, as the RPC returns them; `after` holds what a
  // simulation returns for an account instead (a transaction that changes it)
  const accounts = new Map();
  const afterSim = new Map();
  const account = (a, map = bal) => accounts.get(a) ?? (map.has(a) ? { lamports: Number(map.get(a)), owner: SYSTEM_PROGRAM, data: ['', 'base64'], executable: false } : null);
  const handlers = {
    getEpochInfo: () => ({ absoluteSlot: 4_320_100, blockHeight: 4_000_000, epoch: 10, slotIndex: 100, slotsInEpoch: 432_000, transactionCount: 1 }),
    getStakeMinimumDelegation: () => ({ context: { slot: 1 }, value: 1_000_000_000 }),
    getMinimumBalanceForRentExemption: ([size]) => (128 + size) * 5080,
    getProgramAccounts: () => [],
    getInflationReward: ([addrs]) => addrs.map(() => null),
    getVoteAccounts: () => ({ current: [], delinquent: [] }),
    getBlockProduction: () => ({ context: { slot: 1 }, value: { byIdentity: {}, range: { firstSlot: 0, lastSlot: 1 } } }),
    getBalance: ([a]) => ({ value: Number(bal.get(a) ?? 0n) }),
    getMultipleAccounts: ([addrs]) => ({ value: addrs.map((a) => account(a)) }),
    getAccountInfo: ([a]) => ({ value: account(a) }),
    getLatestBlockhash: () => ({ value: { blockhash: base58Encode(crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: 100 } }),
    getRecentPrioritizationFees: () => [],
    getTokenAccountsByOwner: () => ({ value: [] }),
    getSignaturesForAddress: () => [],
    getSignatureStatuses: ([sigs]) => ({ value: sigs.map(() => ({ confirmationStatus: 'confirmed', err: null })) }),
    simulateTransaction: ([b64, cfg]) => {
      const { t, after, err } = run(b64);
      return {
        value: {
          err, logs: err ? ['Transfer: insufficient lamports'] : [], unitsConsumed: 450, fee: 5000 * t.required,
          accounts: (cfg.accounts?.addresses ?? []).map((a) => (afterSim.has(a) ? afterSim.get(a) : account(a, after))),
          preBalances: t.keys.map((k) => Number(bal.get(k) ?? BigInt(accounts.get(k)?.lamports ?? 0))),
          postBalances: t.keys.map((k) => Number(after.get(k) ?? BigInt(accounts.get(k)?.lamports ?? 0))),
          preTokenBalances: [], postTokenBalances: [],
        },
      };
    },
    sendTransaction: ([b64]) => {
      const { t } = run(b64);
      sentTxs.push(b64);
      return base58Encode(t.signatures[0]);
    },
  };
  const out = {
    log,
    sentTxs,
    accounts,
    afterSim,
    handlers,
    /** a hook to change simulation results (value -> value), or null */
    simExtra: null,
    async post(_url, body) {
      log.push(body.method);
      const h = handlers[body.method];
      if (!h) return { status: 200, json: { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `no ${body.method}` } } };
      let result = h(body.params);
      if (body.method === 'simulateTransaction' && out.simExtra) result = { value: out.simExtra(result.value) };
      return { status: 200, json: { jsonrpc: '2.0', id: body.id, result } };
    },
  };
  return out;
}
