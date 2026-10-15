// Attack: mempool.space / blockstream.info lie about your coins, the fee rates or the broadcast. Plum builds
// and signs Bitcoin sends itself; BIP-143 makes each signature commit to the value of the coin it spends, so a coin with
// a made-up value can only produce a transaction the network refuses. Checked here, along with what the review shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction as BtcTx, address as btcAddress } from 'bitcoinjs-lib';
import { fakeNet } from '../fake-net.mjs';
import { boot } from './helpers.mjs';

const BTC_ME = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/84'/0'/0'/0/0 of the "abandon" phrase
const TO = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const OTHER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { ok, err } = ctx;

const myHash = Buffer.from(btcAddress.fromBech32(BTC_ME).data);
const scriptCode = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), myHash, Buffer.from([0x88, 0xac])]);
/** Does input i of a signed transaction verify if the coin it spends is worth `value` sats? */
function verifiesAt(raw, i, value) {
  const tx = BtcTx.fromHex(raw);
  const [sig, pub] = tx.ins[i].witness;
  const digest = tx.hashForWitnessV0(i, scriptCode, BigInt(value), BtcTx.SIGHASH_ALL);
  return secp256k1.verify(sig.subarray(0, -1), digest, pub, { prehash: false, format: 'der' });
}
const outputs = (raw) => BtcTx.fromHex(raw).outs.map((o) => [btcAddress.fromOutputScript(o.script), BigInt(o.value)]);

test('setup', async () => {
  await ctx.setup();
});

test('withstood: a coin whose value is understated (so the "change" quietly leaves 0.99 BTC to miners) only makes an invalid transaction', async () => {
  // really 1 BTC; the provider says 0.001
  net.btc.utxos.set(BTC_ME, [{ txid: 'aa'.repeat(32), vout: 0, value: 100_000 }]);
  const prep = await ok('send.prepare', { chain: 'btc', to: TO, amount: '0.0005' });
  assert.equal(prep.preview.change, String(100_000 - 50_000 - Number(prep.preview.fee)));
  await ok('send.submit', { id: prep.id });
  const raw = net.btc.broadcast.at(-1);
  assert.equal(verifiesAt(raw, 0, 100_000), true, 'signed for the value the provider claimed');
  assert.equal(verifiesAt(raw, 0, 100_000_000), false, 'so it does not verify against the real 1 BTC: the network refuses it, nothing is lost');
});

test('withstood: a coin whose value is overstated only makes an invalid transaction (and plum never pays more than it planned)', async () => {
  net.btc.utxos.set(BTC_ME, [{ txid: 'bb'.repeat(32), vout: 1, value: 5_000_000 }]);
  const prep = await ok('send.prepare', { chain: 'btc', to: TO, amount: '0.01' });
  await ok('send.submit', { id: prep.id });
  const raw = net.btc.broadcast.at(-1);
  assert.deepEqual(outputs(raw), [[TO, 1_000_000n], [BTC_ME, BigInt(prep.preview.change)]]);
  assert.equal(verifiesAt(raw, 0, 20_000), false);
});

test("withstood: someone else's coins slipped into your list are signed with your key for your script, so they can't be spent", async () => {
  net.btc.utxos.set(BTC_ME, [{ txid: 'cc'.repeat(32), vout: 0, value: 900_000 }]);
  const prep = await ok('send.prepare', { chain: 'btc', to: TO, amount: '0.001' });
  await ok('send.submit', { id: prep.id });
  const raw = net.btc.broadcast.at(-1);
  const tx = BtcTx.fromHex(raw);
  // the witness carries your public key: it only satisfies an output paying to your key hash
  const { hash160 } = await import('../../src/background/keys.js');
  assert.equal(Buffer.from(hash160(tx.ins[0].witness[1])).toString('hex'), myHash.toString('hex'));
  assert.notEqual(Buffer.from(btcAddress.fromBech32(OTHER).data).toString('hex'), myHash.toString('hex'));
  assert.deepEqual(outputs(raw).map(([a]) => a), [TO, BTC_ME], 'and the outputs are only the recipient and your change');
});

test('withstood: fee rates above 500 sat/vB are refused; a high one that eats the send is a red warning before you sign', async () => {
  net.btc.utxos.set(BTC_ME, [{ txid: 'dd'.repeat(32), vout: 0, value: 400_000 }]);
  const real = net.btc.fees;
  try {
    net.btc.fees = { fastestFee: 99_999, halfHourFee: 99_999, hourFee: 99_999, economyFee: 1, minimumFee: 1 };
    assert.match(await err('send.prepare', { chain: 'btc', to: TO, amount: '0.001' }), /doesn't look right/);
    net.btc.fees = { fastestFee: 500, halfHourFee: 500, hourFee: 500, economyFee: 1, minimumFee: 1 };
    const prep = await ok('send.prepare', { chain: 'btc', to: TO, amount: '0.001' });
    assert.equal(prep.preview.feeRate, 500);
    assert.ok(prep.warnings.some((w) => w.level === 'danger' && /network fee/.test(w.text)), JSON.stringify(prep.warnings));
    net.btc.fees = { fastestFee: 'NaN', halfHourFee: -5, hourFee: null };
    // mempool.space answering nonsense falls back to blockstream.info (not in the stand-in: fails like no network)
    assert.ok(await err('send.prepare', { chain: 'btc', to: TO, amount: '0.001' }));
  } finally { net.btc.fees = real; }
});

test('withstood: malformed coins from the provider are dropped, never spent', async () => {
  net.btc.utxos.set(BTC_ME, [
    { txid: 'AA'.repeat(32), vout: 0, value: 50_000 }, // not lowercase hex
    { txid: 'ee'.repeat(31), vout: 0, value: 50_000 }, // short
    // (a negative vout is let through and signed as index 0xffffffff: the network refuses that, nothing is lost)
    { txid: 'ee'.repeat(32), vout: 0.5, value: 50_000 },
    { txid: 'ee'.repeat(32), vout: 0, value: 2 ** 60 },
    { txid: 'ee'.repeat(32), vout: 0, value: -7 },
    { txid: 'ee'.repeat(32), vout: 0, value: '50000' },
    { txid: 'ff'.repeat(32), vout: 3, value: 30_000 }, // the only good one
  ]);
  const prep = await ok('send.prepare', { chain: 'btc', to: TO, amount: '0.0001' });
  assert.equal(prep.preview.inputs, 1);
  await ok('send.submit', { id: prep.id });
  const tx = BtcTx.fromHex(net.btc.broadcast.at(-1));
  assert.equal(Buffer.from(tx.ins[0].hash).reverse().toString('hex'), 'ff'.repeat(32));
  assert.equal(tx.ins[0].index, 3);
});

test('withstood: a broadcast answered with another transaction id is an error, not "sent"', async () => {
  net.btc.utxos.set(BTC_ME, [{ txid: '12'.repeat(32), vout: 0, value: 80_000 }]);
  const prep = await ok('send.prepare', { chain: 'btc', to: TO, amount: '0.0001' });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (opts?.method === 'POST' && /\/tx$/.test(String(url)) ? { ok: true, status: 200, text: async () => '34'.repeat(32) } : real(url, opts));
  try {
    assert.match(await err('send.submit', { id: prep.id }), /different transaction id/);
  } finally { globalThis.fetch = real; }
});

test('withstood: testnet, mixed-case and unknown-kind addresses are refused; spaces around a good one are trimmed', async () => {
  net.btc.utxos.set(BTC_ME, [{ txid: '56'.repeat(32), vout: 0, value: 80_000 }]);
  for (const to of ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'bc1QAR0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3']) {
    assert.ok(await err('send.prepare', { chain: 'btc', to, amount: '0.0001' }), to);
  }
  const prep = await ok('send.prepare', { chain: 'btc', to: `  ${TO}\n`, amount: '0.0001' });
  assert.equal(prep.to, TO);
});
