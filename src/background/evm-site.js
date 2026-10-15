// Which Ethereum network each site is on. A site starts on Ethereum and moves with wallet_switchEthereumChain (or
// wallet_addEthereumChain for a network plum already knows); each site's choice is its own, so one site moving to Base
// never moves another. What a site asks for is tied to the network it was on when it asked: switching while a request
// waits doesn't change that request.
import { MAINNET, networkById, networkByKey } from './evm-chains.js';
import { local } from './store.js';

const KEY = 'evmChains';
/** Sites remembered at most (the ones used longest ago are forgotten first, back on Ethereum). */
const KEEP = 200;

async function all() {
  const v = await local.get(KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** The network a site is on (Ethereum unless it moved). Read from disk, which anyone with the profile can edit: a key
 * plum doesn't know is Ethereum. */
export async function siteNetwork(origin) {
  const entry = (await all())[origin];
  return networkByKey(entry?.net) ?? MAINNET;
}

/** Move a site to a network (by chain id); returns the network, or null when plum doesn't work on that chain. */
export async function moveSite(origin, chainId) {
  const net = networkById(chainId);
  if (!net) return null;
  const map = await all();
  if (net === MAINNET) delete map[origin];
  else map[origin] = { net: net.key, at: Date.now() };
  const kept = Object.entries(map).sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, KEEP);
  await local.set({ [KEY]: Object.fromEntries(kept) });
  return net;
}

/** A site forgotten (disconnected, or revoked in plum): back on Ethereum next time. */
export async function forgetSite(origin) {
  const map = await all();
  if (!(origin in map)) return;
  delete map[origin];
  await local.set({ [KEY]: map });
}
