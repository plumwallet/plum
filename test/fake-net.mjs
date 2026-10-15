// A stand-in for what plum reads about Ethereum and Bitcoin, in place of fetch: a tiny Ethereum JSON-RPC node
// (balances, nonces, code, fees, estimates, eth_call, eth_simulateV1, sends, receipts), Blockscout, mempool.space /
// blockstream.info (addresses, coins, fees, history, broadcasts) and CoinGecko. Anything else fails like no network.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Transaction as BtcTx } from 'bitcoinjs-lib';

const ETH_HOSTS = new Set(['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'rpc.mevblocker.io']);
const ESPLORA_HOSTS = new Set(['mempool.space', 'blockstream.info']);
const hexOf = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const lower = (a) => String(a).toLowerCase();

export function fakeNet() {
  const eth = {
    balances: new Map(), // address (lowercase) -> wei
    nonces: new Map(),
    code: new Map(), // address -> 0x code
    tokens: new Map(), // token (lowercase) -> { decimals, balances: Map(owner -> raw), symbol, name, price }
    sent: [], // raw transactions (0x hex) as they arrived
    calls: [], // [host, method]
    baseFee: 1_000_000_000n,
    tip: 1_500_000_000n,
    /** (call) => eth_simulateV1's first call result, or null to answer "method not found" */
    simulate: null,
  };
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
  const blockscout = { tokens: new Map() }; // owner (lowercase) -> token-balances items
  const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });

  function ethMethod(method, params) {
    switch (method) {
      case 'eth_chainId': return '0x1';
      case 'eth_getBalance': return `0x${(eth.balances.get(lower(params[0])) ?? 0n).toString(16)}`;
      case 'eth_getTransactionCount': return `0x${(eth.nonces.get(lower(params[0])) ?? 0n).toString(16)}`;
      case 'eth_getCode': return eth.code.get(lower(params[0])) ?? '0x';
      case 'eth_getBlockByNumber': return { number: '0x100', baseFeePerGas: `0x${eth.baseFee.toString(16)}` };
      case 'eth_feeHistory': return { baseFeePerGas: [], reward: [[`0x${eth.tip.toString(16)}`], [`0x${eth.tip.toString(16)}`], [`0x${eth.tip.toString(16)}`]] };
      case 'eth_estimateGas': return params[0]?.data && params[0].data !== '0x' ? '0xc350' : '0x5208';
      case 'eth_call': {
        const { to, data } = params[0];
        const t = eth.tokens.get(lower(to));
        if (!t) throw Object.assign(new Error('execution reverted'), { rpc: { code: 3, message: 'execution reverted' } });
        if (data === '0x313ce567') return `0x${t.decimals.toString(16).padStart(64, '0')}`;
        if (data.startsWith('0x70a08231')) return `0x${(t.balances.get(`0x${data.slice(-40)}`) ?? 0n).toString(16).padStart(64, '0')}`;
        return '0x';
      }
      case 'eth_simulateV1': {
        if (!eth.simulate) throw Object.assign(new Error('the method eth_simulateV1 does not exist/is not available'), { rpc: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } });
        return [{ calls: [eth.simulate(params[0].blockStateCalls[0].calls[0])] }];
      }
      case 'eth_sendRawTransaction': {
        eth.sent.push(params[0]);
        return hexOf(keccak_256(Buffer.from(params[0].slice(2), 'hex')));
      }
      case 'eth_getTransactionReceipt': return { status: '0x1' };
      default: throw Object.assign(new Error(`no ${method}`), { rpc: { code: -32601, message: `no ${method}` } });
    }
  }

  async function fetchFake(url, opts = {}) {
    const u = new URL(String(url));
    if (ETH_HOSTS.has(u.host)) {
      const answer = (req) => {
        eth.calls.push([u.host, req.method]);
        try { return { jsonrpc: '2.0', id: req.id, result: ethMethod(req.method, req.params ?? []) }; } catch (e) {
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
    if (u.host === 'eth.blockscout.com') {
      let m;
      if ((m = /^\/api\/v2\/addresses\/([^/]+)\/token-balances$/.exec(u.pathname))) return reply(blockscout.tokens.get(lower(m[1])) ?? []);
      if ((m = /^\/api\/v2\/addresses\/([^/]+)\/(transactions|token-transfers)$/.exec(u.pathname))) return reply({ items: [] });
      if ((m = /^\/api\/v2\/tokens\/([^/]+)$/.exec(u.pathname))) {
        const t = eth.tokens.get(lower(m[1]));
        return t ? reply({ symbol: t.symbol, name: t.name, exchange_rate: t.price ?? null, decimals: String(t.decimals) }) : reply({ message: 'not found' }, 404);
      }
      if (u.pathname === '/api/v2/stats') return reply({ coin_price: '2500', coin_price_change_percentage: 1.5 });
      return reply({ message: 'not found' }, 404);
    }
    if (u.host === 'api.coingecko.com') return reply({ bitcoin: { usd: 80000, usd_24h_change: -1 }, ethereum: { usd: 2500, usd_24h_change: 2 } });
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

  return { eth, btc, ord, blockscout, fetch: fetchFake };
}
