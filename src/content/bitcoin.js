// Plum for Bitcoin sites, in the page, by open standards only:
//   - a provider registered by WBIP-004 (in window.btc_providers, the list sats-connect and Reown AppKit read, and in
//     window.wbip_providers, the name the spec uses now), answering sats-connect's request methods with JSON-RPC
//     envelopes (it never rejects: sats-connect counts on that), with accountChange / networkChange / disconnect events;
//   - a Wallet Standard wallet with the bitcoin:* features (bitcoin:connect, signTransaction, signAndSendTransaction,
//     signMessage, disconnect, events), which Reown AppKit and other wallet-standard apps look for.
// It holds nothing and decides nothing: every call goes to the background, which asks you. It never takes another
// wallet's name (no window.unisat, XverseProviders, LeatherProvider, phantom.bitcoin or magicEden).

const ID = 'PlumProviders.BitcoinProvider';
const CHAIN = 'bitcoin:mainnet';
const METHODS = ['getInfo', 'getAddresses', 'getAccounts', 'getBalance', 'signMessage', 'signPsbt', 'sendTransfer', 'wallet_connect', 'wallet_disconnect',
  'wallet_getAccount', 'wallet_requestPermissions', 'wallet_renouncePermissions', 'wallet_getNetwork', 'wallet_changeNetwork', 'wallet_getWalletType'];
const SIGHASH_NAMES = { ALL: 0x01, NONE: 0x02, SINGLE: 0x03, 'ALL|ANYONECANPAY': 0x81, 'NONE|ANYONECANPAY': 0x82, 'SINGLE|ANYONECANPAY': 0x83 };

const toB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const asBytes = (v) => {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('expected bytes (a Uint8Array)');
};
const strictText = new TextDecoder('utf-8', { fatal: true });

/** A background error as sats-connect's codes: no -> USER_REJECTION, not connected -> ACCESS_DENIED. */
function codeOf(e) {
  const c = e?.code;
  if (c === 4001) return -32000;
  if (c === 4100) return -32002;
  return typeof c === 'number' && c <= -32000 && c >= -32700 ? c : -32603;
}

/** Start Plum's Bitcoin side: `call(method, params)` reaches the background, `icon` is the wallet's icon. Returns
 * { refresh } (after an account switch, a disconnect in plum or a revoke: ask again what this site may see). */
export function startBitcoin({ call, icon }) {
  let seq = 0;
  let addresses = []; // what this site was last given (sats-connect address objects)
  const listeners = { accountChange: new Set(), networkChange: new Set(), disconnect: new Set() };
  const wsListeners = new Set();

  const emit = (event, data) => { for (const fn of listeners[event] ?? []) { try { fn(data); } catch (e) { console.error(e); } } };
  const wsEmit = () => { for (const fn of wsListeners) { try { fn({ accounts: accounts() }); } catch (e) { console.error(e); } } };
  const setAddresses = (list) => {
    const next = Array.isArray(list) ? list.filter((a) => a && typeof a.address === 'string') : [];
    const same = next.length === addresses.length && next.every((a, i) => a.address === addresses[i].address);
    addresses = next;
    if (same) return;
    wsEmit();
    if (next.length) emit('accountChange', { type: 'accountChange', addresses: next.slice() });
  };

  const ask = (method, params) => call('btc', { method, params: params ?? null });

  /** sats-connect's request: always a JSON-RPC envelope, { jsonrpc, id, result } or { jsonrpc, id, error }. */
  async function request(method, params) {
    const id = `plum-${Date.now().toString(36)}-${++seq}`;
    if (typeof method !== 'string' || !method || method.length > 64) return { jsonrpc: '2.0', id, error: { code: -32600, message: 'a request needs a method' } };
    let result;
    try {
      result = await ask(method, params);
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: codeOf(e), message: e?.message || 'Plum hit an error' } };
    }
    if (method === 'getAddresses') setAddresses(result?.addresses);
    if (method === 'getAccounts') setAddresses(result);
    if (method === 'wallet_connect' || method === 'wallet_getAccount') setAddresses(result?.addresses);
    if (method === 'wallet_disconnect' || method === 'wallet_renouncePermissions') { const had = addresses.length; addresses = []; wsEmit(); if (had) emit('disconnect', { type: 'disconnect' }); }
    return { jsonrpc: '2.0', id, result: result === undefined ? null : result };
  }

  /** Both shapes apps use: addListener({ eventName, cb }) (sats-connect) and addListener(name, cb). Returns the way
   * to stop listening. */
  function addListener(a, b) {
    const name = typeof a === 'object' && a ? a.eventName : a;
    const fn = typeof a === 'object' && a ? a.cb : b;
    if (!listeners[name] || typeof fn !== 'function') return () => {};
    listeners[name].add(fn);
    return () => listeners[name].delete(fn);
  }
  const removeListener = (a, b) => {
    const name = typeof a === 'object' && a ? a.eventName : a;
    const fn = typeof a === 'object' && a ? a.cb : b;
    listeners[name]?.delete(fn);
  };

  const provider = Object.freeze({ isPlum: true, request, addListener, removeListener, on: addListener, off: removeListener });

  /* -------------------------------------------------- WBIP-004: window.PlumProviders.BitcoinProvider */
  try {
    Object.defineProperty(window, 'PlumProviders', { value: Object.freeze({ BitcoinProvider: provider }), enumerable: false, configurable: false, writable: false });
  } catch (e) { console.error('Plum: could not expose its Bitcoin provider', e); }
  const entry = Object.freeze({ id: ID, name: 'Plum', icon, webUrl: 'https://plum.fun', methods: METHODS.slice() });
  for (const list of ['btc_providers', 'wbip_providers']) {
    try {
      if (!Array.isArray(window[list])) window[list] = [];
      window[list].push(entry);
    } catch (e) { console.error(`Plum: could not register in ${list}`, e); }
  }

  /* -------------------------------------------------- the Wallet Standard: bitcoin:* features */
  class BitcoinAccount {
    #a;
    constructor(a) { this.#a = a; Object.freeze(this); }
    get address() { return this.#a.address; }
    get publicKey() { return fromHex(this.#a.publicKey); }
    get chains() { return [CHAIN]; }
    get features() { return ['bitcoin:signTransaction', 'bitcoin:signAndSendTransaction', 'bitcoin:signMessage']; }
    get label() { return this.#a.purpose === 'ordinals' ? 'Plum (ordinals)' : 'Plum'; }
    get icon() { return icon; }
  }
  let wsAccounts = [];
  function accounts() {
    const same = wsAccounts.length === addresses.length && wsAccounts.every((x, i) => x.address === addresses[i].address);
    if (!same) wsAccounts = addresses.map((a) => new BitcoinAccount(a));
    return wsAccounts.slice();
  }
  const mine = (account) => {
    const address = account?.address;
    if (!addresses.some((a) => a.address === address)) throw new Error('that account is not connected to Plum');
    return address;
  };
  /** Each Wallet Standard call goes through the same request; an error envelope becomes a thrown error. */
  const send = async (method, params) => {
    const r = await request(method, params);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.result;
  };

  const connect = async ({ purposes } = {}) => {
    const r = await send('getAddresses', { purposes: Array.isArray(purposes) && purposes.length ? purposes : ['payment', 'ordinals'] });
    return { accounts: accounts().filter((a) => r.addresses.some((x) => x.address === a.address)) };
  };
  const disconnect = async () => { await send('wallet_disconnect'); };
  const on = (event, fn) => {
    if (event !== 'change' || typeof fn !== 'function') return () => {};
    wsListeners.add(fn);
    return () => wsListeners.delete(fn);
  };
  /** inputsToSign as sats-connect's older inputsToSign: [{ address, signingIndexes, sigHash }]. */
  const signInputs = (list) => (Array.isArray(list) ? list : []).map((x) => ({
    address: mine(x?.account),
    signingIndexes: Array.isArray(x?.signingIndexes) ? x.signingIndexes : [],
    sigHash: x?.sigHash == null ? undefined : typeof x.sigHash === 'number' ? x.sigHash : SIGHASH_NAMES[x.sigHash] ?? -1,
  }));
  const signTransaction = async (...inputs) => {
    const out = [];
    for (const i of inputs) {
      if (i.chain != null && i.chain !== CHAIN) throw new Error(`Plum is on ${CHAIN} only`);
      const r = await send('signPsbt', { psbt: toB64(asBytes(i.psbt)), inputsToSign: signInputs(i.inputsToSign) });
      out.push({ signedPsbt: fromB64(r.psbt) });
    }
    return out;
  };
  const signAndSendTransaction = async (...inputs) => {
    const out = [];
    for (const i of inputs) {
      if (i.chain !== CHAIN) throw new Error(`Plum is on ${CHAIN} only`);
      const r = await send('signPsbt', { psbt: toB64(asBytes(i.psbt)), inputsToSign: signInputs(i.inputsToSign), broadcast: true });
      out.push({ txId: r.txid });
    }
    return out;
  };
  const signMessage = async (...inputs) => {
    const out = [];
    for (const i of inputs) {
      const message = asBytes(i.message);
      let text;
      try { text = strictText.decode(message); } catch { throw new Error('Plum signs messages that are text (UTF-8)'); }
      const r = await send('signMessage', { address: mine(i.account), message: text, protocol: 'BIP322' });
      out.push({ signedMessage: message.slice(), signature: fromB64(r.signature) });
    }
    return out;
  };

  const wallet = Object.freeze({
    version: '1.0.0',
    name: 'Plum',
    icon,
    chains: [CHAIN],
    get accounts() { return accounts(); },
    features: Object.freeze({
      'bitcoin:connect': { version: '1.0.0', connect },
      'bitcoin:disconnect': { version: '1.0.0', disconnect },
      'standard:disconnect': { version: '1.0.0', disconnect },
      'bitcoin:events': { version: '1.0.0', on },
      'standard:events': { version: '1.0.0', on },
      'bitcoin:signTransaction': { version: '1.0.0', signTransaction },
      'bitcoin:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction },
      'bitcoin:signMessage': { version: '1.0.0', signMessage },
    }),
  });

  // registering, as @wallet-standard/wallet does
  const register = (api) => { try { api.register(wallet); } catch (e) { console.error('Plum: could not register its Bitcoin wallet', e); } };
  class RegisterWalletEvent extends Event {
    #detail;
    get detail() { return this.#detail; }
    get type() { return 'wallet-standard:register-wallet'; }
    constructor(callback) {
      super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false });
      this.#detail = callback;
    }
    preventDefault() { throw new Error('preventDefault cannot be called'); }
    stopImmediatePropagation() { throw new Error('stopImmediatePropagation cannot be called'); }
    stopPropagation() { throw new Error('stopPropagation cannot be called'); }
  }
  try { window.dispatchEvent(new RegisterWalletEvent(register)); } catch (e) { console.error('Plum: register-wallet failed', e); }
  try { window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail)); } catch (e) { console.error('Plum: app-ready failed', e); }

  /** After a wallet switch, a disconnect or a revoke in plum: ask again what this site may see. */
  async function refresh() {
    if (!addresses.length) return;
    let r;
    try { r = await ask('wallet_getAccount'); } catch (e) {
      if (e?.code === 4100 || e?.code === -32002) { addresses = []; wsEmit(); emit('disconnect', { type: 'disconnect' }); }
      return;
    }
    setAddresses(r?.addresses);
  }

  return { refresh, provider, wallet };
}
