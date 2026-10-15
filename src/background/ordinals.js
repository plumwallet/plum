// What rides on a coin: inscriptions and runes, read from keyless public indexers (ordinals.com's recursive endpoint,
// then Xverse's API when it doesn't answer), so plum can keep such coins out of a plain send and name them before a
// site's PSBT spends them. An indexer that doesn't answer, or answers in a shape plum doesn't know, leaves a coin
// unknown: never "empty".
import { formatUnits } from '../shared/format.js';
import { cleanLine } from '../shared/text.js';
import { getJson, pool } from './net.js';

export const ORD = 'https://ordinals.com';
export const XVERSE = 'https://api-3.xverse.app';
const TTL = 10 * 60_000;
const cache = new Map(); // 'txid:vout' -> { at, value }

const ID_RE = /^[0-9a-f]{64}i\d{1,6}$/;

/** A rune balance in words: "1,000 DOG•GO•TO•THE•MOON". */
function rune(name, r) {
  const amount = typeof r?.amount === 'number' || typeof r?.amount === 'string' ? BigInt(r.amount) : null;
  const div = Number.isInteger(r?.divisibility) && r.divisibility >= 0 && r.divisibility <= 38 ? r.divisibility : 0;
  return { name: cleanLine(name, 60), amount: amount == null ? '?' : formatUnits(amount, div) };
}

/** ordinals.com: /r/utxo/<outpoint> -> { inscriptions: [id], runes: { NAME: { amount, divisibility } } }. */
async function fromOrd(op) {
  const j = await getJson(`${ORD}/r/utxo/${op}`, { timeout: 8000 });
  if (!j || typeof j !== 'object' || !Array.isArray(j.inscriptions) || (j.runes != null && typeof j.runes !== 'object')) throw new Error('an answer plum does not know');
  const runes = Array.isArray(j.runes) ? j.runes.map(([n, r]) => rune(n, r)) : Object.entries(j.runes ?? {}).map(([n, r]) => rune(n, r));
  return { inscriptions: j.inscriptions.filter((id) => ID_RE.test(id)).map((id) => ({ id, offset: null })), runes };
}

/** Xverse: /v2/ordinal-utxo/<outpoint> -> { txid, sat_ranges: [{ offset, inscriptions: [{ id }] }], runes: [[name, r]] }.
 * An outpoint it doesn't know comes back without a txid: that's unknown, not empty. */
async function fromXverse(op) {
  const j = await getJson(`${XVERSE}/v2/ordinal-utxo/${op}`, { timeout: 8000 });
  if (!j || typeof j.txid !== 'string' || !Array.isArray(j.sat_ranges)) throw new Error('an answer plum does not know');
  const inscriptions = j.sat_ranges.flatMap((r) => (Array.isArray(r?.inscriptions) ? r.inscriptions : [])
    .filter((x) => ID_RE.test(x?.id ?? '')).map((x) => ({ id: x.id, offset: Number.isSafeInteger(r.offset) ? r.offset : null })));
  const runes = Array.isArray(j.runes) ? j.runes.filter((x) => Array.isArray(x) && typeof x[0] === 'string').map(([n, r]) => rune(n, r)) : [];
  return { inscriptions, runes };
}

/** Where an inscription sits in its coin (ordinals.com's /r/inscription/<id> satpoint), or null. */
async function offsetOf(id) {
  try {
    const j = await getJson(`${ORD}/r/inscription/${id}`, { timeout: 8000 });
    const m = /^[0-9a-f]{64}:\d+:(\d+)$/.exec(j?.satpoint ?? '');
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/**
 * What rides on each coin: Map 'txid:vout' -> { inscriptions: [{ id, offset }], runes: [{ name, amount }] }, for the
 * coins an indexer answered for (a coin it couldn't is missing from the map). At most `max` coins are looked up, four
 * at a time. With `offsets`, where each inscription sits in its coin is looked up too (a PSBT's review follows them).
 */
export async function contentsOf(coins, { max = 60, offsets = true } = {}) {
  const ops = [...new Set(coins.map((c) => `${c.txid}:${c.vout}`))].slice(0, max);
  const out = new Map();
  await pool(ops, 4, async (op) => {
    const hit = cache.get(op);
    if (hit && Date.now() - hit.at < TTL) { out.set(op, hit.value); return; }
    let value = null;
    try { value = await fromOrd(op); } catch { try { value = await fromXverse(op); } catch { value = null; } }
    if (!value) return;
    if (offsets) {
      for (const n of value.inscriptions.slice(0, 8)) if (n.offset == null) n.offset = await offsetOf(n.id);
    }
    cache.set(op, { at: Date.now(), value });
    out.set(op, value);
  });
  return out;
}

export const carries = (v) => !!v && (v.inscriptions.length > 0 || v.runes.length > 0);

export const _test = { cache, fromOrd, fromXverse };
