// Plum in the page, three times over: a Wallet Standard wallet, so it shows up in every Solana site's "connect wallet"
// list (the wallet adapter, anything built on @wallet-standard); an EIP-1193 Ethereum provider,
// announced through EIP-6963, so it shows up in every Ethereum site's list (wagmi, RainbowKit, Web3Modal, ConnectKit);
// and a Bitcoin provider by WBIP-004 and the Wallet Standard's bitcoin:* features (bitcoin.js).
// It holds no secret and decides nothing: each call goes to the background through the content script, and you
// approve it in plum's own window. It never pretends to be another wallet (no window.phantom, no window.solana, and it
// never takes window.ethereum).
import { startBitcoin } from './bitcoin.js';
import { ICON } from './icon.js';

(() => {
  if (window.__plumWallet__) return;
  Object.defineProperty(window, '__plumWallet__', { value: true });

  const CHANNEL = 'plum-wallet:v1';
  const CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'];
  const FEATURES = ['solana:signAndSendTransaction', 'solana:signTransaction', 'solana:signMessage', 'solana:signIn'];
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  const b58decode = (s) => {
    let n = 0n;
    for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad address'); n = n * 58n + BigInt(i); }
    const out = [];
    while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (const c of s) { if (c !== '1') break; out.unshift(0); }
    return Uint8Array.from(out);
  };
  const toB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const asBytes = (v) => {
    if (v instanceof Uint8Array) return v;
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    throw new TypeError('expected bytes (a Uint8Array)');
  };

  /* -------------------------------------------------- talking to the extension */
  let seq = 0;
  const waiting = new Map();
  // what crosses to the extension is plain JSON (Chromium's ports carry nothing else): bigints as 0x hex
  const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `0x${x.toString(16)}` : x))));
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${++seq}`;
      let body;
      try { body = plain(params); } catch { reject(Object.assign(new Error("Plum can't read that request's parameters"), { code: -32602 })); return; }
      waiting.set(id, { resolve, reject });
      window.postMessage({ channel: CHANNEL, dir: 'to-ext', id, method, params: body }, window.location.origin);
    });
  }
  const listeners = { change: new Set() };
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.channel !== CHANNEL || d.dir !== 'to-page') return;
    if (d.event) { refresh(); refreshEvm(); bitcoin.refresh(); return; }
    const w = waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    if (d.error) {
      const err = new Error(d.error.message || 'Plum hit an error');
      err.code = d.error.code;
      w.reject(err);
    } else w.resolve(d.result);
  });

  /* -------------------------------------------------- the wallet */
  class Account {
    #address;
    #publicKey;
    constructor(address) {
      this.#address = address;
      this.#publicKey = b58decode(address);
      Object.freeze(this);
    }
    get address() { return this.#address; }
    get publicKey() { return this.#publicKey.slice(); }
    get chains() { return CHAINS.slice(); }
    get features() { return FEATURES.slice(); }
    get label() { return 'Plum'; }
    get icon() { return ICON; }
  }

  let accounts = [];
  const emit = () => { for (const fn of listeners.change) { try { fn({ accounts: accounts.slice() }); } catch (e) { console.error(e); } } };
  const setAccounts = (addresses) => {
    const list = Array.isArray(addresses) ? addresses.filter((a) => typeof a === 'string') : [];
    const same = list.length === accounts.length && list.every((a, i) => a === accounts[i].address);
    if (same) return;
    accounts = list.map((a) => new Account(a));
    emit();
  };
  // after an account switch, a disconnect in plum, or a network change: ask again what this site may see
  async function refresh() {
    if (!accounts.length) return;
    try { setAccounts(await call('accounts')); } catch { /* keep what we have */ }
  }
  const mine = (account) => {
    const address = account?.address;
    if (!accounts.some((a) => a.address === address)) throw new Error('that account is not connected to Plum');
    return address;
  };

  const connect = async ({ silent } = {}) => {
    setAccounts(await call('connect', { silent: !!silent }));
    return { accounts: accounts.slice() };
  };
  const disconnect = async () => {
    await call('disconnect').catch(() => {});
    setAccounts([]);
  };
  const on = (event, fn) => {
    if (event !== 'change') return () => {};
    listeners.change.add(fn);
    return () => listeners.change.delete(fn);
  };

  const signTransaction = async (...inputs) => {
    if (!inputs.length) return [];
    const account = mine(inputs[0].account);
    if (inputs.some((i) => i.account?.address !== account)) throw new Error('every transaction must be for the same account');
    const chain = inputs[0].chain;
    const signed = await call('signTransaction', { account, chain, transactions: inputs.map((i) => toB64(asBytes(i.transaction))) });
    return signed.map((b) => ({ signedTransaction: fromB64(b) }));
  };

  const signAndSendTransaction = async (...inputs) => {
    if (!inputs.length) return [];
    const account = mine(inputs[0].account);
    if (inputs.some((i) => i.account?.address !== account)) throw new Error('every transaction must be for the same account');
    const o = inputs[0].options ?? {};
    const sigs = await call('signAndSendTransaction', {
      account,
      chain: inputs[0].chain,
      options: { skipPreflight: !!o.skipPreflight, preflightCommitment: o.preflightCommitment },
      transactions: inputs.map((i) => toB64(asBytes(i.transaction))),
    });
    return sigs.map((s) => ({ signature: b58decode(s) }));
  };

  const signMessage = async (...inputs) => {
    const out = [];
    for (const i of inputs) {
      const account = mine(i.account);
      const r = await call('signMessage', { account, message: toB64(asBytes(i.message)) });
      out.push({ signedMessage: fromB64(r.signedMessage), signature: fromB64(r.signature), signatureType: 'ed25519' });
    }
    return out;
  };

  const signIn = async (...inputs) => {
    const out = [];
    for (const input of inputs.length ? inputs : [{}]) {
      if (!accounts.length) await connect();
      const account = accounts[0].address;
      const clean = {};
      for (const k of ['domain', 'address', 'statement', 'uri', 'version', 'chainId', 'nonce', 'issuedAt', 'expirationTime', 'notBefore', 'requestId']) {
        if (input?.[k] != null) clean[k] = String(input[k]);
      }
      if (Array.isArray(input?.resources)) clean.resources = input.resources.map(String);
      const r = await call('signIn', { account, input: clean });
      out.push({ account: accounts.find((a) => a.address === r.address) ?? accounts[0], signedMessage: fromB64(r.signedMessage), signature: fromB64(r.signature), signatureType: 'ed25519' });
    }
    return out;
  };

  const wallet = Object.freeze({
    version: '1.0.0',
    name: 'Plum',
    icon: ICON,
    chains: CHAINS,
    get accounts() { return accounts.slice(); },
    features: Object.freeze({
      'standard:connect': { version: '1.0.0', connect },
      'standard:disconnect': { version: '1.0.0', disconnect },
      'standard:events': { version: '1.0.0', on },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0, 1], signAndSendTransaction },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0, 1], signTransaction },
      'solana:signMessage': { version: '1.0.0', signMessage },
      'solana:signIn': { version: '1.0.0', signIn },
    }),
  });

  /* -------------------------------------------------- registering, as @wallet-standard/wallet does */
  const register = (api) => { try { api.register(wallet); } catch (e) { console.error('Plum: could not register', e); } };
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

  /* -------------------------------------------------- Ethereum: an EIP-1193 provider, announced by EIP-6963 */
  class ProviderRpcError extends Error {
    constructor(message, code, data) {
      super(message);
      this.code = code;
      if (data !== undefined) this.data = data;
    }
  }

  const evmListeners = new Map(); // event -> Set of handlers
  let evmAccounts = [];
  const evmEmit = (event, ...args) => {
    for (const fn of evmListeners.get(event) ?? []) { try { fn(...args); } catch (e) { console.error(e); } }
  };
  const setEvmAccounts = (list) => {
    const next = Array.isArray(list) ? list.filter((a) => typeof a === 'string') : [];
    const same = next.length === evmAccounts.length && next.every((a, i) => a === evmAccounts[i]);
    evmAccounts = next;
    if (!same) evmEmit('accountsChanged', next.slice());
  };
  // after a wallet switch, a disconnect in plum, or a revoke: ask again what this site may see
  async function refreshEvm() {
    if (!evmAccounts.length) return;
    try { setEvmAccounts(await call('evm', { method: 'eth_accounts', params: [] })); } catch { /* keep what we have */ }
  }

  async function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string' || !args.method) throw new ProviderRpcError('a request needs a method', -32600);
    const { method } = args;
    const params = args.params === undefined ? [] : args.params;
    let result;
    try {
      result = await call('evm', { method, params });
    } catch (e) {
      throw new ProviderRpcError(e.message || 'Plum hit an error', typeof e.code === 'number' ? e.code : -32603);
    }
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') setEvmAccounts(result);
    if (method === 'wallet_requestPermissions') setEvmAccounts(result?.[0]?.caveats?.[0]?.value ?? []);
    if (method === 'wallet_revokePermissions') setEvmAccounts([]);
    return result;
  }

  const evmOn = (event, fn) => {
    if (typeof fn !== 'function') return provider;
    if (!evmListeners.has(event)) evmListeners.set(event, new Set());
    evmListeners.get(event).add(fn);
    return provider;
  };
  const evmOff = (event, fn) => { evmListeners.get(event)?.delete(fn); return provider; };
  const provider = Object.freeze({
    isPlum: true,
    request,
    on: evmOn,
    addListener: evmOn,
    removeListener: evmOff,
    off: evmOff,
  });

  const info = Object.freeze({ uuid: crypto.randomUUID(), name: 'Plum', icon: ICON, rdns: 'fun.plum' });
  const announced = Object.freeze({ info, provider });
  const announce = () => { try { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: announced })); } catch (e) { console.error('Plum: announce failed', e); } };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  // plum can always reach Ethereum mainnet
  setTimeout(() => evmEmit('connect', { chainId: '0x1' }), 0);

  /* -------------------------------------------------- Bitcoin (bitcoin.js) */
  const bitcoin = startBitcoin({ call, icon: ICON });
})();
