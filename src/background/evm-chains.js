// The Ethereum networks plum works on: Ethereum itself, and Base, Arbitrum One and Polygon PoS. A wallet has one
// address on all four, but each network keeps its own coins, tokens and history, and a transaction signed for one is
// valid only there (its chain id is part of what's signed). Everything plum reads about a network comes from that
// network's own RPCs and Blockscout; nothing a site says about a network is used.

/** Ethereum's own network first; the order plum shows them in. */
export const EVM_NETWORKS = [
  {
    key: 'ethereum', id: 1, name: 'ethereum', title: 'Ethereum', tag: 'eth',
    native: { symbol: 'ETH', name: 'ether', price: 'eth' },
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
    // MEV Blocker first: a private route to block builders, so nobody sees a transaction early and trades in front of it
    private: ['https://rpc.mevblocker.io'],
    blockscout: 'https://eth.blockscout.com/api/v2',
    explorer: 'https://etherscan.io', explorerName: 'etherscan',
    // the tip: what recent blocks paid, kept within these bounds (wei per gas)
    tip: { min: 10_000_000n, max: 3_000_000_000n, fallback: 1_000_000_000n },
    l1Fee: false,
    wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  {
    key: 'base', id: 8453, name: 'base', title: 'Base', tag: 'base',
    native: { symbol: 'ETH', name: 'ether on base', price: 'eth' },
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org', 'https://1rpc.io/base'],
    private: [],
    blockscout: 'https://base.blockscout.com/api/v2',
    explorer: 'https://basescan.org', explorerName: 'basescan',
    tip: { min: 1_000_000n, max: 1_000_000_000n, fallback: 1_000_000n },
    // an OP Stack network: besides gas, each transaction pays for the room it takes on Ethereum (GasPriceOracle)
    l1Fee: true,
    wrapped: '0x4200000000000000000000000000000000000006',
  },
  {
    key: 'arbitrum', id: 42161, name: 'arbitrum', title: 'Arbitrum', tag: 'arb',
    native: { symbol: 'ETH', name: 'ether on arbitrum', price: 'eth' },
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org', 'https://1rpc.io/arb'],
    private: [],
    blockscout: 'https://arbitrum.blockscout.com/api/v2',
    explorer: 'https://arbiscan.io', explorerName: 'arbiscan',
    // Arbitrum orders transactions as they come and ignores tips; its gas estimates include the Ethereum data cost
    tip: { min: 0n, max: 0n, fallback: 0n },
    l1Fee: false,
    wrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  {
    key: 'polygon', id: 137, name: 'polygon', title: 'Polygon', tag: 'pol',
    native: { symbol: 'POL', name: 'polygon', price: 'pol' },
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
    private: [],
    blockscout: 'https://polygon.blockscout.com/api/v2',
    explorer: 'https://polygonscan.com', explorerName: 'polygonscan',
    // Polygon's validators take nothing under a 25 gwei tip
    tip: { min: 30_000_000_000n, max: 2_000_000_000_000n, fallback: 30_000_000_000n },
    l1Fee: false,
    wrapped: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    // POL's own balance also shows as an ERC-20 at this address (a system contract): never a token of its own
    nativeToken: '0x0000000000000000000000000000000000001010',
  },
];

export const MAINNET = EVM_NETWORKS[0];
const BY_KEY = new Map(EVM_NETWORKS.map((n) => [n.key, n]));
const BY_ID = new Map(EVM_NETWORKS.map((n) => [n.id, n]));

/** A network by its key ('base'), or null. */
export const networkByKey = (key) => (typeof key === 'string' && BY_KEY.get(key)) || null;

/** A chain id as a site or a transaction gives it (0x hex, a decimal string, a number or a bigint), or null if it
 * isn't one. */
export function chainIdOf(v) {
  try {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null;
    if (typeof v === 'bigint') return v > 0n ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(s)) return null;
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch { return null; }
}

/** The network with this chain id (any form chainIdOf takes), or null when plum doesn't work there. */
export function networkById(v) {
  const n = chainIdOf(v);
  return n != null && n <= BigInt(Number.MAX_SAFE_INTEGER) ? BY_ID.get(Number(n)) ?? null : null;
}

/** A chain id as JSON-RPC writes it: 0x hex. */
export const chainHex = (net) => `0x${net.id.toString(16)}`;

/** Networks plum doesn't work on, named for a site's error message (the site's own name for one is never used). */
const OTHERS = {
  10: 'Optimism', 56: 'BNB Chain', 100: 'Gnosis', 250: 'Fantom', 324: 'zkSync', 1101: 'Polygon zkEVM', 5000: 'Mantle',
  8217: 'Kaia', 34443: 'Mode', 42220: 'Celo', 43114: 'Avalanche', 59144: 'Linea', 81457: 'Blast', 534352: 'Scroll',
  7777777: 'Zora', 11155111: 'Sepolia', 17000: 'Holesky', 84532: 'Base Sepolia', 421614: 'Arbitrum Sepolia', 80002: 'Polygon Amoy',
};
const LIST = 'Ethereum, Base, Arbitrum and Polygon';

/** Why plum won't go to a chain a site asked for, in plain words. */
export function unsupportedChain(v) {
  const n = chainIdOf(v);
  if (n == null) return `that isn't a chain id plum can read: plum works on ${LIST}`;
  const name = n <= 100_000_000n ? OTHERS[Number(n)] : null;
  return `Plum doesn't work on ${name ? `${name} (chain ${n})` : `chain ${n}`}: it works on ${LIST} only`;
}
