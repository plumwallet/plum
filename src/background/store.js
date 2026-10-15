// Where plum keeps things. storage.local (on disk): the sealed vault, your accounts and wallets (names, icons, public
// addresses), settings, connected sites. storage.session (memory only, gone when the browser closes): the unlocked
// data key. Content scripts can read neither: the browser keeps both to the extension's own pages (Chromium's
// storage.session is trusted contexts only unless an extension opens it up, and plum never does).
import { ext } from '../shared/ext.js';

function area(name) {
  return {
    async get(key, fallback = null) {
      const r = await ext().storage[name].get(key);
      return r[key] ?? fallback;
    },
    set: (obj) => ext().storage[name].set(obj),
    remove: (keys) => ext().storage[name].remove(keys),
    clear: () => ext().storage[name].clear(),
  };
}

export const local = area('local');
export const session = area('session');

export const AUTOLOCK_CHOICES = [5, 15, 60, 240];

export const DEFAULT_SETTINGS = {
  network: 'mainnet',
  rpc: { mainnet: '', devnet: '', testnet: '', localnet: '' },
  /** your own Ethereum RPC, or '' for plum's public ones */
  ethRpc: '',
  autolockMin: 15,
  hideZero: true,
  jupiterKey: '',
  slippageBps: 100,
};

export async function getSettings() {
  const s = await local.get('settings', {});
  const out = { ...DEFAULT_SETTINGS, ...s, rpc: { ...DEFAULT_SETTINGS.rpc, ...(s.rpc ?? {}) } };
  // read from disk, which anyone with the profile can edit: an auto-lock time plum doesn't offer is its default
  if (!AUTOLOCK_CHOICES.includes(out.autolockMin)) out.autolockMin = DEFAULT_SETTINGS.autolockMin;
  return out;
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await local.set({ settings: next });
  return next;
}
