// Attack: a Bitcoin site hands plum a PSBT built to hurt you. Through plum's real background (fake browser, stand-in
// chain and ordinals indexer): PSBTs that lie about what an input holds (its witness UTXO against the chain, against
// its own previous transaction), sighash types that leave the rest of the transaction open, change "back to you" that
// goes to a lookalike, absurd fees, inputs dressed up as the wallet's, taproot script paths, inscriptions sent into the
// fee, a send it wants broadcast before it's whole, and a flood of requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Psbt } from 'bitcoinjs-lib';
import { hex } from '../../src/shared/bytes.js';
import { addressScript } from '../../src/background/btc.js';
import { reviewPsbt } from '../../src/background/btc-psbt.js';
import { fakeNet } from '../fake-net.mjs';
import { buildPsbt, p2wpkhAddress, prevTx, stranger, txidOf, validator } from '../btc-helpers.mjs';
import { boot, sleep } from './helpers.mjs';

const SEGWIT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const SEG_SCRIPT = addressScript(SEGWIT).script, TR_SCRIPT = addressScript(TAPROOT).script;
const SITE = 'https://evil-market.example';
const MERCHANT = p2wpkhAddress('evil merchant');

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, err, fake, _test } = ctx;
const ask = (page, method, params) => page.request('btc', { method, params });
let page;

async function waiting(kind) {
  const until = Date.now() + 2000;
  let r;
  while (!(r = [..._test.pending.values()].find((x) => x.kind === kind)) && Date.now() < until) await sleep(5);
  if (!r) throw new Error(`no ${kind} approval`);
  return r;
}
function onChain(built, override = {}) {
  for (const [op, prev] of built.chain) {
    const real = override[op] === undefined ? prev : override[op];
    if (!real) continue;
    const [txid, vout] = op.split(':');
    const outs = net.btc.txs.get(txid) ?? [];
    outs[Number(vout)] = { scriptpubkey: hex(real.script), value: Number(real.value) };
    for (let i = 0; i < outs.length; i++) outs[i] ??= { scriptpubkey: '6a', value: 0 };
    net.btc.txs.set(txid, outs);
  }
}
/** Send a PSBT, read its preview; returns { r (the request), preview, answer }. */
async function review(params) {
  const answer = ask(page, 'signPsbt', params);
  const r = await waiting('btcPsbt');
  const [preview] = await ok('approval.preview', { id: r.id });
  return { r, preview, answer };
}
const reject = async (r) => { await ok('approval.reject', { id: r.id }); };

test('setup: a connected site', async () => {
  await ctx.setup();
  page = fake.page(`${SITE}/`);
  const answer = ask(page, 'getAddresses', { purposes: ['payment', 'ordinals'] });
  const r = await waiting('btcConnect');
  await ok('approval.resolve', { id: r.id, approve: true });
  assert.ok((await answer).result.addresses.length === 2);
});

test('withstood: a witness UTXO that understates the coin (the fee attack): the chain says otherwise, plum refuses outright', async () => {
  const built = buildPsbt({
    inputs: [{ txid: txidOf('lie amount'), vout: 0, value: 100_000_000n, claimValue: 10_000n, script: SEG_SCRIPT }],
    outputs: [{ address: MERCHANT, value: 9_000n }],
  });
  onChain(built);
  const { r, preview, answer } = await review({ psbt: built.b64 });
  assert.match(preview.error, /lies about input 0: it says the coin holds 0\.0001 BTC, the chain says 1 BTC/);
  // no "i understand" gets past it
  assert.match(await err('approval.resolve', { id: r.id, approve: true, ignoreRisk: true }), /lies about input 0/);
  await reject(r);
  assert.equal((await answer).error.code, 4001);
});

test('withstood: a witness UTXO claiming a coin is the wallet\'s when the chain says it belongs to someone else', async () => {
  const thief = stranger('thief');
  const built = buildPsbt({ inputs: [{ txid: txidOf('pretend'), vout: 2, value: 50_000n, script: SEG_SCRIPT }], outputs: [{ address: MERCHANT, value: 40_000n }] });
  onChain(built, { [`${txidOf('pretend')}:2`]: { value: 50_000n, script: thief.script } });
  const { r, preview } = await review({ psbt: built.b64 });
  assert.match(preview.error, /lies about input 0: it says the coin belongs to bc1q/);
  assert.match(await err('approval.resolve', { id: r.id, approve: true, ignoreRisk: true }), /lies/);
  await reject(r);
});

test('withstood: a witness UTXO and a previous transaction that disagree are refused before any window opens', async () => {
  const prev = await prevTx('disagree', [{ script: SEG_SCRIPT, value: 80_000n }]);
  const built = buildPsbt({ inputs: [{ txid: prev.txid, vout: 0, value: 80_000n, claimValue: 8_000n, script: SEG_SCRIPT, nonWitness: prev.raw }], outputs: [{ address: MERCHANT, value: 7_000n }] });
  const { error } = await ask(page, 'signPsbt', { psbt: built.b64 });
  assert.match(error.message, /contradicts itself about input 0/);
  assert.equal(_test.pending.size, 0);
  // and a previous transaction that isn't the one the input spends
  const other = await prevTx('other', [{ script: SEG_SCRIPT, value: 80_000n }]);
  const wrong = buildPsbt({ inputs: [{ txid: txidOf('wrong prev'), vout: 0, value: 80_000n, script: SEG_SCRIPT, nonWitness: other.raw, nonWitnessOnly: true }], outputs: [{ address: MERCHANT, value: 7_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: wrong.b64 })).error.message, /previous transaction isn't the one it spends/);
});

test('withstood: when the chain can\'t be read, a bc1q input known only by its witness UTXO is a named danger that needs "i understand"', async () => {
  const built = buildPsbt({ inputs: [{ txid: txidOf('offline'), vout: 0, value: 70_000n, script: SEG_SCRIPT }], outputs: [{ address: MERCHANT, value: 60_000n }, { address: SEGWIT, value: 9_000n }] });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (/\/api\/tx\//.test(String(url)) ? Promise.reject(new Error('offline')) : real(url, o));
  try {
    const { r, preview, answer } = await review({ psbt: built.b64 });
    assert.equal(preview.checked, false);
    assert.ok(preview.warnings.some((w) => w.level === 'danger' && /couldn't check what input 0 holds/.test(w.text)), JSON.stringify(preview.warnings));
    assert.match(await err('approval.resolve', { id: r.id, approve: true }), /danger/);
    await ok('approval.resolve', { id: r.id, approve: true, ignoreRisk: true });
    assert.ok((await answer).result.psbt);
  } finally { globalThis.fetch = real; }
});

test('withstood: SIGHASH_NONE, SINGLE and ANYONECANPAY are named dangers, each needing "i understand", and signed only as asked', async () => {
  for (const [type, words] of [[0x02, /SIGHASH_NONE.*send this coin anywhere/], [0x03, /SIGHASH_SINGLE: it only fixes output 0/], [0x81, /ALL\|ANYONECANPAY.*add inputs/], [0x82, /SIGHASH_NONE\|ANYONECANPAY/], [0x83, /SINGLE\|ANYONECANPAY.*sell/]]) {
    const built = buildPsbt({ inputs: [{ txid: txidOf(`sighash ${type}`), vout: 0, value: 30_000n, script: TR_SCRIPT, sighashType: type }], outputs: [{ address: SEGWIT, value: 25_000n }] });
    onChain(built);
    const { r, preview, answer } = await review({ psbt: built.b64 });
    assert.ok(preview.warnings.some((w) => w.level === 'danger' && words.test(w.text)), `${type}: ${JSON.stringify(preview.warnings)}`);
    assert.match(await err('approval.resolve', { id: r.id, approve: true }), /danger/);
    await ok('approval.resolve', { id: r.id, approve: true, ignoreRisk: true });
    const signed = Psbt.fromBase64((await answer).result.psbt);
    assert.equal(signed.data.inputs[0].tapKeySig.at(-1), type);
    assert.ok(signed.validateSignaturesOfInput(0, validator));
  }
  // a sighash type a site asks for beside the PSBT must agree with the PSBT's own
  const built = buildPsbt({ inputs: [{ txid: txidOf('sighash clash'), vout: 0, value: 30_000n, script: TR_SCRIPT, sighashType: 0x01 }], outputs: [{ address: SEGWIT, value: 25_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: built.b64, inputsToSign: [{ address: TAPROOT, signingIndexes: [0], sigHash: 0x83 }] })).error.message, /sighash type 131 on input 0, but the PSBT says 1/);
  for (const bad of [0x04, 0x84, 0x41]) {
    const odd = buildPsbt({ inputs: [{ txid: txidOf(`odd ${bad}`), vout: 0, value: 30_000n, script: SEG_SCRIPT, sighashType: bad }], outputs: [{ address: SEGWIT, value: 25_000n }] });
    assert.match((await ask(page, 'signPsbt', { psbt: odd.b64 })).error.message, /sighash type \d+, which plum doesn't sign/);
  }
});

test('withstood: change "back to you" sent to a lookalike of your address is a named danger', () => {
  // two real addresses sharing their first 8 and last 4 characters (found by a birthday search)
  const MINE = 'bc1qf6c9s4q9yteffpaj88asyadrx56m0u58tc54ey', TWIN = 'bc1qf6c9gav54sujs6hhwmlzn38klr3qcjllrw54ey';
  const owner = { segwit: MINE, taproot: stranger('twin owner').address, taprootKey: hex(stranger('twin owner').internal) };
  const built = buildPsbt({ inputs: [{ txid: txidOf('twin'), vout: 0, value: 500_000n, script: addressScript(MINE).script }], outputs: [{ address: MERCHANT, value: 10_000n }, { address: TWIN, value: 489_000n }] });
  const r = reviewPsbt(built.decoded, { owner, chain: built.chain });
  assert.equal(r.arrives, 0n, 'the lookalike is not counted as coming back');
  assert.equal(r.net, -500_000n);
  assert.ok(r.warnings.some((w) => w.level === 'danger' && w.text.includes(`goes to ${TWIN}, which looks like your address but isn't`)));
});

test('withstood: an absurd fee is a named danger; a high one a warning', async () => {
  const built = buildPsbt({ inputs: [{ txid: txidOf('absurd'), vout: 0, value: 100_000_000n, script: SEG_SCRIPT }], outputs: [{ address: MERCHANT, value: 50_000_000n }] });
  onChain(built);
  const { r, preview } = await review({ psbt: built.b64 });
  assert.equal(preview.fee, '50000000');
  assert.ok(preview.warnings.some((w) => w.level === 'danger' && /the network fee is absurd: 0\.5 BTC/.test(w.text)), JSON.stringify(preview.warnings));
  await reject(r);
  const high = buildPsbt({ inputs: [{ txid: txidOf('high'), vout: 0, value: 1_000_000n, script: SEG_SCRIPT }], outputs: [{ address: MERCHANT, value: 975_000n }] });
  onChain(high);
  const h = await review({ psbt: high.b64 });
  assert.ok(h.preview.warnings.some((w) => w.level === 'warn' && /network fee is high/.test(w.text)), JSON.stringify(h.preview.warnings));
  assert.ok(!h.preview.warnings.some((w) => w.level === 'danger'));
  await reject(h.r);
});

test("withstood: inputs that aren't the wallet's, addresses that aren't, script paths, other taproot keys: refused before any window", async () => {
  const thief = stranger('someone');
  const theirs = buildPsbt({ inputs: [{ txid: txidOf('theirs'), vout: 0, value: 10_000n, script: thief.script }, { txid: txidOf('mine'), vout: 0, value: 10_000n, script: SEG_SCRIPT }], outputs: [{ address: MERCHANT, value: 15_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: theirs.b64, signInputs: { [TAPROOT]: [0] } })).error.message, /input 0 spends bc1p.*which isn't this wallet's/);
  assert.match((await ask(page, 'signPsbt', { psbt: theirs.b64, signInputs: { [thief.address]: [0] } })).error.message, /isn't this wallet's address/);
  assert.match((await ask(page, 'signPsbt', { psbt: theirs.b64, signInputs: { [TAPROOT]: [1] } })).error.message, /belongs to this wallet's other address/);
  assert.match((await ask(page, 'signPsbt', { psbt: theirs.b64, signInputs: { [SEGWIT]: [7] } })).error.message, /no input 7/);
  assert.match((await ask(page, 'signPsbt', { psbt: theirs.b64, signInputs: { [SEGWIT]: [1, 1] } })).error.message, /asked for twice/);
  const nothing = buildPsbt({ inputs: [{ txid: txidOf('none'), vout: 0, value: 10_000n, script: thief.script }], outputs: [{ address: MERCHANT, value: 9_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: nothing.b64 })).error.message, /none of this PSBT's inputs are this wallet's/);
  const leaf = buildPsbt({ inputs: [{ txid: txidOf('leaf'), vout: 0, value: 10_000n, script: TR_SCRIPT, extra: { tapLeafScript: [{ leafVersion: 0xc0, script: Buffer.from([0x51]), controlBlock: Buffer.concat([Buffer.from([0xc0]), Buffer.from(thief.internal)]) }] } }], outputs: [{ address: MERCHANT, value: 9_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: leaf.b64 })).error.message, /script path/);
  const other = buildPsbt({ inputs: [{ txid: txidOf('other key'), vout: 0, value: 10_000n, script: TR_SCRIPT, tapInternalKey: Buffer.from(thief.internal) }], outputs: [{ address: MERCHANT, value: 9_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: other.b64 })).error.message, /taproot key is another one/);
  assert.equal(_test.pending.size, 0);
});

test('withstood: a PSBT it wants sent while someone else\'s input is unsigned is refused; garbage PSBTs too', async () => {
  const thief = stranger('half');
  const half = buildPsbt({ inputs: [{ txid: txidOf('half a'), vout: 0, value: 10_000n, script: SEG_SCRIPT }, { txid: txidOf('half b'), vout: 0, value: 10_000n, script: thief.script }], outputs: [{ address: MERCHANT, value: 19_000n }] });
  assert.match((await ask(page, 'signPsbt', { psbt: half.b64, broadcast: true })).error.message, /input 1 isn't signed by anyone/);
  for (const psbt of [undefined, '', 'not base64!', 'cHNidP8=', 'AAAA', 'x'.repeat(3_000_000), 42]) {
    const { error } = await ask(page, 'signPsbt', { psbt });
    assert.ok(error && error.code === -32602, String(psbt).slice(0, 20));
  }
});

test('withstood: an inscription the PSBT would hand to the miners is named; plum\'s own send never spends an inscribed coin', async () => {
  const insc = `${'ef'.repeat(32)}i0`;
  const built = buildPsbt({ inputs: [{ txid: txidOf('inscribed'), vout: 0, value: 10_000n, script: TR_SCRIPT }], outputs: [{ address: MERCHANT, value: 5_000n }] });
  onChain(built);
  net.ord.utxos.set(`${txidOf('inscribed')}:0`, { inscriptions: [insc] });
  net.ord.satpoints.set(insc, `${txidOf('inscribed')}:0:9000`);
  const { r, preview } = await review({ psbt: built.b64 });
  assert.ok(preview.warnings.some((w) => w.level === 'danger' && /inscription.*ends up in the network fee \(lost to a miner\)/.test(w.text)), JSON.stringify(preview.warnings));
  await reject(r);
  // plum's own send: the inscribed taproot coin is kept out, the plain one spent
  net.btc.utxos.set(SEGWIT, [{ txid: 'c1'.repeat(32), vout: 0, value: 80_000 }]);
  net.btc.utxos.set(TAPROOT, [{ txid: 'c2'.repeat(32), vout: 1, value: 900_000 }]);
  net.ord.utxos.set(`${'c2'.repeat(32)}:1`, { inscriptions: [insc] });
  net.ord.utxos.set(`${'c1'.repeat(32)}:0`, {});
  const prep = await ok('send.prepare', { chain: 'btc', to: MERCHANT, amount: '0.0005' });
  assert.equal(prep.preview.inputs, 1);
  assert.ok(prep.warnings.some((w) => /a coin holding inscriptions or runes \(0\.009 BTC\) is kept out/.test(w.text)), JSON.stringify(prep.warnings));
  assert.match(await err('send.prepare', { chain: 'btc', to: MERCHANT, amount: '0.005' }), /more than this wallet holds/);
  // runes count too
  net.ord.utxos.set(`${'c1'.repeat(32)}:0`, { runes: { 'DOG•GO•TO•THE•MOON': { amount: 100000, divisibility: 5, symbol: 'D' } } });
  _test.prepared.clear();
  const { _test: ordTest } = await import('../../src/background/ordinals.js');
  ordTest.cache.clear();
  assert.match(await err('send.prepare', { chain: 'btc', to: MERCHANT, amount: '0.0001' }), /every coin in this wallet carries inscriptions or runes/);
  // the indexer down: nothing is assumed empty; spending an unchecked coin is a warning in words
  ordTest.cache.clear();
  net.ord.down = true;
  try {
    const p2 = await ok('send.prepare', { chain: 'btc', to: MERCHANT, amount: '0.0001' });
    assert.ok(p2.warnings.some((w) => w.level === 'warn' && /couldn't check/.test(w.text)), JSON.stringify(p2.warnings));
  } finally { net.ord.down = false; ordTest.cache.clear(); }
});

test('withstood: a flood of PSBTs: five wait for you, the rest are turned away at once', async () => {
  const built = buildPsbt({ inputs: [{ txid: txidOf('flood'), vout: 0, value: 10_000n, script: SEG_SCRIPT }], outputs: [{ address: MERCHANT, value: 9_000n }] });
  const answers = Array.from({ length: 30 }, () => ask(page, 'signPsbt', { psbt: built.b64 }));
  await sleep(100);
  assert.equal(_test.pending.size, 5);
  const settled = await Promise.race([Promise.all(answers.slice(5)), sleep(1000).then(() => null)]);
  assert.ok(settled, 'the rest were answered without waiting for you');
  assert.ok(settled.every((a) => a.error?.code === 4100 && /5 requests waiting/.test(a.error.message)));
  const first = [..._test.pending.values()][0];
  assert.equal(await ok('approval.rejectSite', { id: first.id }), 5);
  assert.ok((await Promise.all(answers.slice(0, 5))).every((a) => a.error?.code === 4001));
});
