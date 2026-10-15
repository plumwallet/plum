// A stand-in for what plum reads about Ethereum and Bitcoin, in place of fetch: a tiny Ethereum JSON-RPC node per
// network (balances, nonces, code, fees, estimates, eth_call, eth_simulateV1, sends, receipts), Blockscout per network,
// KyberSwap's aggregator API, mempool.space / blockstream.info (addresses, coins, fees, history, broadcasts),
// ordinals.com and CoinGecko. Anything else fails like no network.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Transaction as BtcTx } from 'bitcoinjs-lib';

const ESPLORA_HOSTS = new Set(['mempool.space', 'blockstream.info']);
const hexOf = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const lower = (a) => String(a).toLowerCase();
const CHAIN_IDS = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137 };
const BLOCKSCOUT = { 'eth.blockscout.com': 'ethereum', 'base.blockscout.com': 'base', 'arbitrum.blockscout.com': 'arbitrum', 'polygon.blockscout.com': 'polygon' };
const L1_ORACLE = '0x420000000000000000000000000000000000000f';

/** The network an RPC URL is for (the public RPCs plum knows, by host and path), or null. */
function rpcNetwork(u) {
  const byHost = {
    'ethereum-rpc.publicnode.com': 'ethereum', 'eth.drpc.org': 'ethereum', 'rpc.mevblocker.io': 'ethereum',
    'base-rpc.publicnode.com': 'base', 'mainnet.base.org': 'base', 'base.drpc.org': 'base',
    'arbitrum-one-rpc.publicnode.com': 'arbitrum', 'arb1.arbitrum.io': 'arbitrum', 'arbitrum.drpc.org': 'arbitrum',
    'polygon-bor-rpc.publicnode.com': 'polygon', 'polygon.drpc.org': 'polygon',
  };
  if (byHost[u.host]) return byHost[u.host];
  if (u.host === '1rpc.io') return { '/eth': 'ethereum', '/base': 'base', '/arb': 'arbitrum', '/matic': 'polygon' }[u.pathname] ?? null;
  return null;
}

function chainState(key) {
  return {
    key,
    id: CHAIN_IDS[key],
    balances: new Map(), // address (lowercase) -> wei
    nonces: new Map(),
    code: new Map(), // address -> 0x code
    tokens: new Map(), // token (lowercase) -> { decimals, balances: Map(owner -> raw), allowances: Map(`${owner}:${spender}` -> raw), symbol, name, price }
    sent: [], // raw transactions (0x hex) as they arrived
    calls: [], // [host, method]
    baseFee: 1_000_000_000n,
    tip: 1_500_000_000n,
    /** the gas eth_estimateGas answers: (call) => bigint, or null for 21,000 (50,000 with data) */
    estimate: null,
    /** Base's fee for a transaction's room on Ethereum (GasPriceOracle.getL1Fee) */
    l1Fee: 7_000_000_000n,
    /** (call, index, calls) => eth_simulateV1's result for that call, or null to answer "method not found" */
    simulate: null,
    /** ({ to, data }) => an eth_call's answer (0x hex) for contracts that aren't tokens, or undefined */
    ethCall: null,
    /** a hash -> receipt status ('0x1', '0x0', or null for not yet) */
    receipts: new Map(),
    blockscout: { tokens: new Map(), txs: new Map() }, // owner (lowercase) -> token-balances items / transaction items
  };
}

export function fakeNet() {
  const evm = Object.fromEntries(Object.keys(CHAIN_IDS).map((k) => [k, chainState(k)]));
  const eth = evm.ethereum;
  const btc = {
    stats: new Map(), // address -> { funded, spent, txs }
    utxos: new Map(), // address -> [{ txid, vout, value, confirmed }]
    fees: { fastestFee: 20, halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1 },
    broadcast: [], // raw hex
    txs: new Map(), // txid -> [{ scriptpubkey (hex), value }]: the outputs /tx/<txid> answers with
  };
  // ordinals.com's recursive endpoints: 'txid:vout' -> { inscriptions: [id], runes: { NAME: { amount, divisibility } } },
  // inscription id -> satpoint; `down` makes it answer 503
  const ord = { utxos: new Map(), satpoints: new Map(), down: false, calls: [] };
  const blockscout = eth.blockscout; // Ethereum's (as before)
  /** KyberSwap: `routes(query)` and `build(body)` answer as the API would (an object, or { status, body }); `asked`
   * lists [path, query or body]. */
  const kyber = { routes: null, build: null, asked: [] };
  const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });

  function ethMethod(c, method, params) {
    switch (method) {
      case 'eth_chainId': return `0x${c.id.toString(16)}`;
      case 'eth_getBalance': return `0x${(c.balances.get(lower(params[0])) ?? 0n).toString(16)}`;
      case 'eth_getTransactionCount': return `0x${(c.nonces.get(lower(params[0])) ?? 0n).toString(16)}`;
      case 'eth_getCode': return c.code.get(lower(params[0])) ?? '0x';
      case 'eth_getBlockByNumber': return { number: '0x100', baseFeePerGas: `0x${c.baseFee.toString(16)}` };
      case 'eth_feeHistory': return { baseFeePerGas: [], reward: [[`0x${c.tip.toString(16)}`], [`0x${c.tip.toString(16)}`], [`0x${c.tip.toString(16)}`]] };
      case 'eth_estimateGas': {
        if (c.estimate) return `0x${c.estimate(params[0]).toString(16)}`;
        return params[0]?.data && params[0].data !== '0x' ? '0xc350' : '0x5208';
      }
      case 'eth_call': {
        const { to, data } = params[0];
        if (lower(to) === L1_ORACLE && data.startsWith('0x49948e0e')) return `0x${c.l1Fee.toString(16).padStart(64, '0')}`;
        const own = c.ethCall?.(params[0]);
        if (own !== undefined) return own;
        const t = c.tokens.get(lower(to));
        if (!t) throw Object.assign(new Error('execution reverted'), { rpc: { code: 3, message: 'execution reverted' } });
        if (data === '0x313ce567') return `0x${t.decimals.toString(16).padStart(64, '0')}`;
        if (data.startsWith('0x70a08231')) return `0x${(t.balances.get(`0x${data.slice(-40)}`) ?? 0n).toString(16).padStart(64, '0')}`;
        if (data.startsWith('0xdd62ed3e')) return `0x${(t.allowances?.get(`0x${data.slice(34, 74)}:0x${data.slice(-40)}`) ?? 0n).toString(16).padStart(64, '0')}`;
        return '0x';
      }
      case 'eth_simulateV1': {
        if (!c.simulate) throw Object.assign(new Error('the method eth_simulateV1 does not exist/is not available'), { rpc: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } });
        const calls = params[0].blockStateCalls[0].calls;
        return [{ calls: calls.map((x, i) => c.simulate(x, i, calls)) }];
      }
      case 'eth_sendRawTransaction': {
        c.sent.push(params[0]);
        return hexOf(keccak_256(Buffer.from(params[0].slice(2), 'hex')));
      }
      case 'eth_getTransactionReceipt': {
        const st = c.receipts.has(lower(params[0])) ? c.receipts.get(lower(params[0])) : '0x1';
        return st == null ? null : { status: st };
      }
      default: throw Object.assign(new Error(`no ${method}`), { rpc: { code: -32601, message: `no ${method}` } });
    }
  }

  async function fetchFake(url, opts = {}) {
    const u = new URL(String(url));
    const key = rpcNetwork(u);
    if (key) {
      const c = evm[key];
      const answer = (req) => {
        c.calls.push([u.host, req.method]);
        try { return { jsonrpc: '2.0', id: req.id, result: ethMethod(c, req.method, req.params ?? []) }; } catch (e) {
          return { jsonrpc: '2.0', id: req.id, error: e.rpc ?? { code: -32000, message: e.message } };
        }
      };
      // a batch (an array of calls) is answered call by call, as real nodes do
      const req = JSON.parse(opts.body);
      return reply(Array.isArray(req) ? req.map(answer) : answer(req));
    }
    if (ESPLORA_HOSTS.has(u.host)) {
      const path = u.pathname.replace(/^\/api/, '');
      let m;
      if (path === '/v1/fees/recommended') return reply(btc.fees);
      if (path === '/v1/prices') return reply({ USD: 80000 });
      if (path === '/tx' && opts.method === 'POST') {
        btc.broadcast.push(opts.body);
        return reply(BtcTx.fromHex(opts.body).getId());
      }
      if ((m = /^\/address\/([^/]+)$/.exec(path))) {
        const s = btc.stats.get(m[1]) ?? { funded: 0, spent: 0, txs: 0 };
        return reply({ address: m[1], chain_stats: { funded_txo_sum: s.funded, spent_txo_sum: s.spent, tx_count: s.txs }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
      }
      if ((m = /^\/address\/([^/]+)\/utxo$/.exec(path))) {
        return reply((btc.utxos.get(m[1]) ?? []).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, status: { confirmed: x.confirmed !== false } })));
      }
      if ((m = /^\/address\/([^/]+)\/txs$/.exec(path))) return reply([]);
      if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path))) return reply({ confirmed: true });
      if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) return btc.txs.has(m[1]) ? reply({ txid: m[1], vout: btc.txs.get(m[1]) }) : reply('Transaction not found', 404);
      return reply({ message: 'not found' }, 404);
    }
    if (BLOCKSCOUT[u.host]) {
      const c = evm[BLOCKSCOUT[u.host]];
      let m;
      if ((m = /^\/api\/v2\/addresses\/([^/]+)\/token-balances$/.exec(u.pathname))) return reply(c.blockscout.tokens.get(lower(m[1])) ?? []);
      if ((m = /^\/api\/v2\/addresses\/([^/]+)\/transactions$/.exec(u.pathname))) return reply({ items: c.blockscout.txs.get(lower(m[1])) ?? [] });
      if ((m = /^\/api\/v2\/addresses\/([^/]+)\/token-transfers$/.exec(u.pathname))) return reply({ items: [] });
      if ((m = /^\/api\/v2\/tokens\/([^/]+)$/.exec(u.pathname))) {
        const t = c.tokens.get(lower(m[1]));
        return t ? reply({ symbol: t.symbol, name: t.name, exchange_rate: t.price ?? null, decimals: String(t.decimals) }) : reply({ message: 'not found' }, 404);
      }
      if (u.pathname === '/api/v2/stats') return reply({ coin_price: c.key === 'polygon' ? '0.25' : '2500', coin_price_change_percentage: 1.5 });
      return reply({ message: 'not found' }, 404);
    }
    if (u.host === 'aggregator-api.kyberswap.com') {
      const m = /^\/([a-z]+)\/api\/v1\/(routes|route\/build)$/.exec(u.pathname);
      if (!m) return reply({ code: 404, message: 'not found' }, 404);
      const asked = m[2] === 'routes' ? Object.fromEntries(u.searchParams) : JSON.parse(opts.body);
      kyber.asked.push([`${m[1]}/${m[2]}`, asked]);
      const fn = m[2] === 'routes' ? kyber.routes : kyber.build;
      if (!fn) return reply({ code: 4000, message: 'no route' }, 400);
      const out = fn(asked, m[1]);
      return out?.status ? reply(out.body, out.status) : reply({ code: 0, message: 'successfully', data: out });
    }
    if (u.host === 'api.coingecko.com') return reply({ bitcoin: { usd: 80000, usd_24h_change: -1 }, ethereum: { usd: 2500, usd_24h_change: 2 }, 'polygon-ecosystem-token': { usd: 0.25, usd_24h_change: -3 } });
    if (u.host === 'ordinals.com') {
      ord.calls.push(u.pathname);
      if (ord.down) return reply('down', 503);
      let m;
      if ((m = /^\/r\/utxo\/([0-9a-f]{64}:\d+)$/.exec(u.pathname))) return ord.utxos.has(m[1]) ? reply({ inscriptions: [], runes: {}, sat_ranges: null, value: 0, ...ord.utxos.get(m[1]) }) : reply('not found', 404);
      if ((m = /^\/r\/inscription\/([0-9a-f]{64}i\d+)$/.exec(u.pathname))) return ord.satpoints.has(m[1]) ? reply({ id: m[1], satpoint: ord.satpoints.get(m[1]) }) : reply('not found', 404);
      return reply('not found', 404);
    }
    throw new Error('no network in tests');
  }

  return { eth, evm, btc, ord, blockscout, kyber, fetch: fetchFake };
}
