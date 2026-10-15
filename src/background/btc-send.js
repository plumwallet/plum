// Bitcoin sends plum builds itself (from the send screen, and for a site's sendTransfer): coins from both of the
// wallet's addresses, the ones carrying inscriptions or runes kept out (a plain send would lose them), the fee from
// today's rates, change back to bc1q, every warning in words.
import { formatUnits } from '../shared/format.js';
import * as B from './btc.js';
import { carries, contentsOf } from './ordinals.js';

const sats = (coins) => coins.reduce((n, c) => n + c.value, 0n);

/** The wallet's coins, sorted out: { free (spendable; `unchecked` when no indexer could tell what they carry), held
 * (carrying inscriptions or runes) }. */
export async function spendable(owner) {
  const coins = await B.coinsOf(owner);
  const found = await contentsOf(coins, { offsets: false }).catch(() => new Map());
  const free = [], held = [];
  for (const c of coins) {
    const v = found.get(`${c.txid}:${c.vout}`);
    if (carries(v)) held.push({ ...c, holds: v });
    else free.push(v ? c : { ...c, unchecked: true });
  }
  return { free, held };
}

/**
 * A send to `recipients` ([{ to, amount (sats) }]) at today's `speed`, or everything (`max`) to one address:
 * { plan, preview (for the review screen), warnings, held, feeRate }.
 */
export async function prepareSpend({ owner, recipients, speed = 'normal', max = false }) {
  const [{ free, held }, rates] = await Promise.all([spendable(owner), B.feeRates()]);
  const feeRate = rates[['fast', 'normal', 'slow'].includes(speed) ? speed : 'normal'];
  if (!free.length && held.length) throw new Error("every coin in this wallet carries inscriptions or runes, and plum's send never spends those (it would lose them)");
  const p = B.plan({ utxos: free, recipients, feeRate, change: owner.segwit, max });
  const warnings = [];
  if (p.fee * 10n > p.amount) warnings.push({ level: p.fee * 2n > p.amount ? 'danger' : 'warn', text: `the network fee (${formatUnits(p.fee, 8)} BTC) is a big part of what you're sending` });
  if (p.inputs.some((c) => !c.confirmed)) warnings.push({ level: 'info', text: 'this spends coins that are still waiting for their first confirmation' });
  const unchecked = p.inputs.filter((c) => c.unchecked);
  if (unchecked.length) warnings.push({ level: 'warn', text: `plum couldn't check ${unchecked.length === 1 ? 'one of the coins' : `${unchecked.length} of the coins`} this spends for inscriptions or runes (the indexers didn't answer): spending one that carries them sends them away with the bitcoin` });
  if (held.length) warnings.push({ level: 'info', text: `${held.length === 1 ? 'a coin' : `${held.length} coins`} holding inscriptions or runes (${formatUnits(sats(held), 8)} BTC) ${held.length === 1 ? 'is' : 'are'} kept out of this send` });
  const change = p.outputs.find((o) => o.mine)?.value ?? 0n;
  const preview = {
    chain: 'btc', amount: p.amount.toString(), fee: p.fee.toString(), feeRate, vsize: p.vsize, inputs: p.inputs.length, change: change.toString(),
    kind: p.outputs[0].kind, taproot: p.inputs.filter((c) => c.kind === 'p2tr').length,
    changes: [{ symbol: 'BTC', decimals: 8, delta: (-(p.amount + p.fee)).toString(), verified: true }],
    warnings: [],
  };
  return { plan: p, preview, warnings, held, feeRate };
}
