// What rides on a coin (src/background/ordinals.js), with fetch stubbed: ordinals.com's answer in both of its shapes
// for runes, Xverse's when ordinals.com doesn't answer, inscription offsets, and failing closed: an indexer that
// doesn't answer, answers 406, or answers in a shape plum doesn't know leaves the coin unknown, never empty; a slow
// one doesn't hold the review up past the deadline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { _test, carries, contentsOf } from '../src/background/ordinals.js';

const A = { txid: 'aa'.repeat(32), vout: 0 }, Bc = { txid: 'bb'.repeat(32), vout: 1 }, C = { txid: 'cc'.repeat(32), vout: 2 };
const ID = `${'dd'.repeat(32)}i0`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  _test.cache.clear();
  try { return await fn(calls); } finally { globalThis.fetch = real; _test.cache.clear(); }
}

test("ordinals.com's answer: inscriptions, runes (a map, or the older list of pairs), offsets from the satpoint", async () => {
  const got = await withFetch((url) => {
    if (url.endsWith(`/r/utxo/${A.txid}:0`)) return json({ inscriptions: [ID], runes: { 'DOG•GO•TO•THE•MOON': { amount: 250000, divisibility: 5, symbol: 'D' } }, value: 546 });
    if (url.endsWith(`/r/utxo/${Bc.txid}:1`)) return json({ inscriptions: [], runes: [['UNCOMMON•GOODS', { amount: 3, divisibility: 0 }]], value: 10_000 });
    if (url.endsWith(`/r/utxo/${C.txid}:2`)) return json({ inscriptions: [], runes: {}, value: 99_000 });
    if (url.endsWith(`/r/inscription/${ID}`)) return json({ id: ID, satpoint: `${A.txid}:0:120` });
    return json('not found', 404);
  }, () => contentsOf([A, Bc, C]));
  assert.deepEqual(got.get(`${A.txid}:0`), { inscriptions: [{ id: ID, offset: 120 }], runes: [{ name: 'DOG•GO•TO•THE•MOON', amount: '2.5' }] });
  assert.deepEqual(got.get(`${Bc.txid}:1`), { inscriptions: [], runes: [{ name: 'UNCOMMON•GOODS', amount: '3' }] });
  assert.deepEqual(got.get(`${C.txid}:2`), { inscriptions: [], runes: [] });
  assert.equal(carries(got.get(`${A.txid}:0`)), true);
  assert.equal(carries(got.get(`${Bc.txid}:1`)), true);
  assert.equal(carries(got.get(`${C.txid}:2`)), false);
});

test("Xverse's answer when ordinals.com is down; an outpoint Xverse doesn't know (no txid) is unknown", async () => {
  const got = await withFetch((url) => {
    if (url.startsWith('https://ordinals.com/')) return json({ error: 'JSON API disabled' }, 406);
    if (url.endsWith(`/v2/ordinal-utxo/${A.txid}:0`)) return json({ txid: A.txid, vout: 0, value: 546, sat_ranges: [{ offset: 0, inscriptions: [{ id: ID }] }], runes: [['X•Y', { amount: 7, divisibility: 1 }]] });
    if (url.endsWith(`/v2/ordinal-utxo/${Bc.txid}:1`)) return json({ sat_ranges: [], xVersion: 3 });
    return json('nope', 500);
  }, () => contentsOf([A, Bc]));
  assert.deepEqual(got.get(`${A.txid}:0`), { inscriptions: [{ id: ID, offset: 0 }], runes: [{ name: 'X•Y', amount: '0.7' }] });
  assert.equal(got.has(`${Bc.txid}:1`), false, 'unknown, not empty');
});

test('fails closed: a shape plum does not know, garbage ids, both indexers down: unknown, never empty', async () => {
  const got = await withFetch((url) => {
    if (url.endsWith(`/r/utxo/${A.txid}:0`)) return json({ inscriptions: 'all of them' });
    if (url.endsWith(`/r/utxo/${Bc.txid}:1`)) return json({ inscriptions: ['<img src=x>', ID] });
    throw new TypeError('network down');
  }, () => contentsOf([A, Bc, C], { offsets: false }));
  assert.equal(got.has(`${A.txid}:0`), false);
  assert.deepEqual(got.get(`${Bc.txid}:1`).inscriptions, [{ id: ID, offset: null }], 'only real inscription ids are kept');
  assert.equal(got.has(`${C.txid}:2`), false);
});

test('a slow indexer: what answered by the deadline is used, the rest is unknown (and kept for next time)', async () => {
  await withFetch(async (url, init) => {
    if (url.endsWith(`/r/utxo/${A.txid}:0`)) return json({ inscriptions: [], runes: {} });
    // hangs until fetch's own timeout aborts it
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }, async () => {
    const t0 = Date.now();
    const got = await contentsOf([A, Bc, C], { offsets: false, deadline: 300 });
    assert.ok(Date.now() - t0 < 2000, 'answered by the deadline');
    assert.deepEqual([...got.keys()], [`${A.txid}:0`]);
  });
});
