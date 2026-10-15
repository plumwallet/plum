// Bitcoin, checked against bitcoinjs-lib (its address decoder, transaction parser and BIP-143 sighash), BIP-143 written
// again here from the spec's text, the BIPs' own vectors (BIP-143's native P2WPKH example, BIP-173/350 addresses), and
// signatures verified by noble and OpenSSL: addresses, coin selection and fees, sighashes, and signed transactions,
// every input signed by the wallet's one key. No network: fetch is stubbed where plum reads the chain.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction, address as baddress, initEccLib, networks, payments } from 'bitcoinjs-lib';
import { hex } from '../src/shared/bytes.js';
import { btcAddressOfPublicKey, btcPublicKey, hash160, signBtcDigest } from '../src/background/keys.js';
import * as B from '../src/background/btc.js';

const sha256 = (b) => createHash('sha256').update(b).digest();
const dsha = (b) => sha256(sha256(b));
const h2b = (h) => Buffer.from(h, 'hex');
const N = secp256k1.Point.CURVE().n;

// bitcoinjs needs an ECC library for taproot addresses: two functions, on noble (bitcoinjs checks them with its own vectors)
initEccLib({
  isXOnlyPoint(x) {
    if (x.length !== 32) return false;
    try { secp256k1.Point.fromBytes(Uint8Array.from([2, ...x])); return true; } catch { return false; }
  },
  xOnlyPointAddTweak(x, tweak) {
    let P;
    try { P = secp256k1.Point.fromBytes(Uint8Array.from([2, ...x])); } catch { return null; }
    const t = BigInt(`0x${hex(tweak)}`);
    if (t >= N) return null;
    const Q = t === 0n ? P : P.add(secp256k1.Point.BASE.multiply(t));
    if (Q.is0()) return null;
    const q = Q.toBytes(true);
    return { parity: q[0] === 3 ? 1 : 0, xOnlyPubkey: q.subarray(1) };
  },
});

/** Deterministic test bytes. */
const bytesOf = (label, n = 32) => {
  const out = [];
  for (let i = 0; out.length < n; i++) out.push(...sha256(`${label}/${i}`));
  return Buffer.from(out.slice(0, n));
};

/* ------------------------------------------------------------ bech32 and bech32m, from BIP-173's reference code */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function bech32Encode(hrp, data, m) {
  const mod = (polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ (m ? 0x2bc830a3 : 1)) >>> 0;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}
function toWords(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}
/** A segwit address of any version, hrp and checksum kind (right or wrong). */
const segwit = (hrp, version, program, m) => bech32Encode(hrp, [version, ...toWords(program)], m);

/** Base58check of any payload. */
function b58check(body) {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const buf = Buffer.concat([body, dsha(body).subarray(0, 4)]);
  let n = BigInt(`0x${hex(buf)}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b) break; out = `1${out}`; }
  return out;
}

/* ------------------------------------------------------------ BIP-143, from the spec's text */

const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const varSlice = (b) => Buffer.concat([Buffer.from([b.length]), b]);
/** { preimage, sighash } for input `index` (SIGHASH_ALL). Inputs carry their outpoint as serialized (txid reversed). */
function bip143({ version, inputs, outputs, locktime }, index, scriptCode, value) {
  const hashPrevouts = dsha(Buffer.concat(inputs.map((i) => i.outpoint)));
  const hashSequence = dsha(Buffer.concat(inputs.map((i) => le32(i.sequence))));
  const hashOutputs = dsha(Buffer.concat(outputs.map((o) => Buffer.concat([le64(o.value), varSlice(Buffer.from(o.script))]))));
  const i = inputs[index];
  const preimage = Buffer.concat([le32(version), hashPrevouts, hashSequence, i.outpoint, varSlice(scriptCode), le64(value), le32(i.sequence), hashOutputs, le32(locktime), le32(1)]);
  return { preimage, sighash: dsha(preimage) };
}
const p2pkhScript = (keyHash) => Buffer.concat([h2b('76a914'), Buffer.from(keyHash), h2b('88ac')]);
const outpointOf = (txid, vout) => Buffer.concat([h2b(txid).reverse(), le32(vout)]);

/** BIP-66 strict DER: { r, s }. */
function parseDer(sig) {
  assert.equal(sig[0], 0x30);
  assert.equal(sig[1], sig.length - 2);
  assert.equal(sig[2], 0x02);
  const rlen = sig[3];
  const r = sig.subarray(4, 4 + rlen);
  assert.equal(sig[4 + rlen], 0x02);
  const slen = sig[5 + rlen];
  const s = sig.subarray(6 + rlen, 6 + rlen + slen);
  assert.equal(6 + rlen + slen, sig.length);
  for (const x of [r, s]) {
    assert.ok(x.length > 0 && x[0] < 0x80);
    if (x.length > 1) assert.ok(!(x[0] === 0 && x[1] < 0x80));
  }
  return { r: BigInt(`0x${hex(r)}`), s: BigInt(`0x${hex(s)}`) };
}

/* ------------------------------------------------------------ the wallet in these tests */

// BIP-143's own P2WPKH key, so its example and plum's transactions use the same coins' owner
const KEY = h2b('619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9');
const PUB = btcPublicKey(KEY);
const ME = btcAddressOfPublicKey(PUB);
const KEY_HASH = hash160(PUB);
const ME_SCRIPT = Buffer.concat([h2b('0014'), Buffer.from(KEY_HASH)]);

const coin = (label, value, { confirmed = true, vout = 0 } = {}) => ({ txid: hex(bytesOf(`coin ${label}`)), vout, value: BigInt(value), confirmed });
const DEST = {
  p2wpkh: payments.p2wpkh({ hash: bytesOf('dest wpkh', 20) }).address,
  p2wsh: payments.p2wsh({ hash: bytesOf('dest wsh') }).address,
  p2tr: baddress.toBech32(bytesOf('dest tr x'), 1, 'bc'),
  p2pkh: payments.p2pkh({ hash: bytesOf('dest pkh', 20) }).address,
  p2sh: payments.p2sh({ hash: bytesOf('dest sh', 20) }).address,
};
// an x-only key that is on the curve, so bitcoinjs accepts the taproot address
DEST.p2tr = baddress.toBech32(btcPublicKey(bytesOf('dest tr key')).subarray(1), 1, 'bc');

/** Virtual size from first principles: weight = 4 x the bytes without witnesses + the witness bytes (72-byte signatures). */
const OUT_BYTES = { p2wpkh: 31, p2wsh: 43, p2tr: 43, p2pkh: 34, p2sh: 32 };
const vbytes = (inputs, kinds) => Math.ceil((4 * (10 + 41 * inputs + kinds.reduce((t, k) => t + OUT_BYTES[k], 0)) + 2 + 108 * inputs) / 4);

/* ------------------------------------------------------------ addresses */

test('addressScript: the BIPs\' own addresses, and the script bitcoinjs makes for every kind', () => {
  const vectors = [
    ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'p2wpkh', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
    ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'p2wsh', '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'p2tr', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
    ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'p2wpkh', null],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'p2pkh', '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'p2sh', null],
  ];
  for (const [a, kind, script] of vectors) {
    const got = B.addressScript(a);
    assert.equal(got.kind, kind, a);
    assert.equal(hex(got.script), hex(baddress.toOutputScript(a, networks.bitcoin)), a);
    if (script) assert.equal(hex(got.script), script, a);
    assert.ok(B.isBtcAddress(a));
  }
  // the reference encoder above writes the BIPs' strings
  assert.equal(segwit('bc', 0, h2b('751e76e8199196d454941c45d1b3a323f1433bd6'), false), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(segwit('bc', 1, h2b('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'), true), 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');
  // many of each kind, made by bitcoinjs
  for (let i = 0; i < 25; i++) {
    const h20 = bytesOf(`h20 ${i}`, 20), h32 = bytesOf(`h32 ${i}`);
    const made = {
      p2wpkh: payments.p2wpkh({ hash: h20 }).address,
      p2wsh: payments.p2wsh({ hash: h32 }).address,
      p2tr: baddress.toBech32(btcPublicKey(bytesOf(`tr ${i}`)).subarray(1), 1, 'bc'),
      p2pkh: payments.p2pkh({ hash: h20 }).address,
      p2sh: payments.p2sh({ hash: h20 }).address,
    };
    for (const [kind, a] of Object.entries(made)) {
      for (const form of kind.startsWith('p2w') || kind === 'p2tr' ? [a, a.toUpperCase(), ` ${a}\n`] : [a, ` ${a} `]) {
        const got = B.addressScript(form);
        assert.equal(got.kind, kind, form);
        assert.equal(hex(got.script), hex(baddress.toOutputScript(a, networks.bitcoin)), form);
      }
    }
  }
});

test('addressScript refuses testnet, the wrong checksum kind, other prefixes, mixed case, unknown kinds and garbage', () => {
  const h20 = bytesOf('refuse 20', 20), h32 = bytesOf('refuse 32');
  const testnet = [
    payments.p2wpkh({ hash: h20, network: networks.testnet }).address, payments.p2wsh({ hash: h32, network: networks.testnet }).address,
    payments.p2pkh({ hash: h20, network: networks.testnet }).address, payments.p2sh({ hash: h20, network: networks.testnet }).address,
    baddress.toBech32(h32, 1, 'tb'), baddress.toBech32(h20, 0, 'bcrt'), 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
    'TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX',
  ];
  for (const a of testnet) assert.throws(() => B.addressScript(a), /testnet/, a);
  const checksum = [
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', // BIP-350: v1 written with bech32
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', // BIP-350: v0 written with bech32m
    segwit('bc', 1, h32, false), segwit('bc', 0, h20, true), segwit('bc', 0, h32, true),
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', // BIP-173: one character off
  ];
  for (const a of checksum) assert.throws(() => B.addressScript(a), /checksum/, a);
  // a valid bech32 string whose prefix isn't "bc", though it starts with bc1
  const prefixes = [segwit('bc1q', 0, h20, false), segwit('bc1x', 0, h32, false), segwit('bc1p', 1, h32, true), segwit('bc1', 0, h20, false)];
  for (const a of prefixes) {
    assert.throws(() => baddress.toOutputScript(a, networks.bitcoin), a);
    assert.throws(() => B.addressScript(a), /Bitcoin/, a);
  }
  const good = payments.p2wpkh({ hash: h20 }).address;
  assert.throws(() => B.addressScript(good.slice(0, 10) + good.slice(10).toUpperCase()), /mixes capitals/);
  assert.throws(() => B.addressScript('BC1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), /mixes capitals/);
  // well-formed, but nothing plum sends to: other witness versions and lengths (BIP-350's valid list), a 16-byte v0
  for (const a of ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'BC1SW50QGDZ25J', 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', segwit('bc', 1, h20, true), segwit('bc', 2, h32, true)]) {
    assert.throws(() => B.addressScript(a), /plum doesn't send to that kind of Bitcoin address/, a);
  }
  // BIP-350's invalid list (main network ones), each refused in plum's own words
  for (const a of ['bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', 'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', 'bc1pw5dgrnzv',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf', 'bc1gmk9yu',
    'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut', 'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL']) {
    assert.throws(() => B.addressScript(a), /Bitcoin address/, a);
  }
  assert.throws(() => B.addressScript('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf'), /^Error: that isn't a Bitcoin address$/, 'bad padding');
  // base58 that isn't a main-network address (another coin's version byte, a 21-byte hash), and garbage
  const garbage = ['', '   ', 'hello', 'bc1', 'bc1qqqqqq', baddress.toBase58Check(h20, 0x30), b58check(Buffer.concat([Buffer.from([0]), bytesOf('21', 21)])),
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', null, undefined, 42];
  for (const a of garbage) {
    assert.throws(() => B.addressScript(a), (e) => e instanceof Error && !/is not a function|Cannot read/.test(e.message), String(a));
    assert.equal(B.isBtcAddress(a), false);
  }
});

/* ------------------------------------------------------------ sizes, fees and picking coins */

test('vsizeOf is the weight of the transaction plum builds, in virtual bytes', () => {
  for (let n = 1; n < 12; n++) {
    for (const kinds of [['p2wpkh'], ['p2wpkh', 'p2wpkh'], ['p2tr', 'p2wpkh'], ['p2pkh'], ['p2sh', 'p2wpkh'], ['p2wsh']]) {
      assert.equal(B.vsizeOf(n, kinds), vbytes(n, kinds), `${n} ${kinds}`);
    }
  }
  assert.equal(B.vsizeOf(1, ['p2wpkh', 'p2wpkh']), 141, 'the classic one in, two out');
});

const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
/** What every plan must be: balanced, its fee covering its size, change only when worth it, the amount exact. */
function checkPlan(p, { utxos, to, amount, feeRate, max }) {
  const kind = B.addressScript(to).kind;
  assert.equal(sum(p.inputs.map((c) => c.value)), sum(p.outputs.map((o) => o.value)) + p.fee, 'inputs = outputs + fee');
  assert.equal(p.outputs[0].kind, kind);
  assert.equal(hex(p.outputs[0].script), hex(baddress.toOutputScript(to, networks.bitcoin)));
  assert.equal(p.outputs[0].mine, false);
  assert.equal(p.outputs[0].value, p.amount);
  const kinds = p.outputs.map((o) => o.kind);
  assert.equal(p.vsize, vbytes(p.inputs.length, kinds));
  const needed = BigInt(Math.ceil(p.vsize * feeRate));
  assert.ok(p.fee >= needed, 'the fee covers the size');
  // coins go confirmed first, biggest first, and no more of them than needed
  const order = [...utxos].sort((a, b) => (a.confirmed === b.confirmed ? Number(b.value - a.value) : a.confirmed ? -1 : 1));
  assert.deepEqual(p.inputs, order.slice(0, p.inputs.length));
  if (max) {
    assert.equal(p.inputs.length, utxos.length);
    assert.equal(p.outputs.length, 1);
    assert.equal(p.fee, needed);
    return;
  }
  assert.equal(p.amount, BigInt(amount));
  if (p.outputs.length === 2) {
    assert.equal(p.outputs[1].mine, true);
    assert.equal(hex(p.outputs[1].script), hex(ME_SCRIPT));
    assert.ok(p.outputs[1].value >= B.DUST, 'no dust change');
    assert.equal(p.fee, needed, 'with change, the fee is exactly the rate');
  } else {
    assert.equal(p.outputs.length, 1);
    // without change, what's left over is less than a change output would cost plus dust
    const withChange = BigInt(Math.ceil(vbytes(p.inputs.length, [kind, 'p2wpkh']) * feeRate));
    assert.ok(p.fee - needed < withChange - needed + B.DUST, 'the change left to the miners was too small to keep');
  }
  if (p.inputs.length > 1) {
    const fewer = sum(order.slice(0, p.inputs.length - 1).map((c) => c.value));
    assert.ok(fewer < BigInt(amount) + BigInt(Math.ceil(vbytes(p.inputs.length - 1, [kind]) * feeRate)), 'one coin fewer would not have been enough');
  }
}

test('plan: one coin, change back, the fee exactly vsize x rate', () => {
  const utxos = [coin('a', 100_000)];
  const p = B.plan({ utxos, to: DEST.p2wpkh, amount: 50_000n, feeRate: 2, change: ME });
  checkPlan(p, { utxos, to: DEST.p2wpkh, amount: 50_000n, feeRate: 2 });
  assert.equal(p.vsize, 141);
  assert.equal(p.fee, 282n);
  assert.deepEqual(p.outputs.map((o) => o.value), [50_000n, 49_718n]);
});

test('plan: change exactly at the dust line is kept, a sat less goes to the fee; an exact no-change spend; one sat short', () => {
  const rate = 3;
  for (const [kind, to] of Object.entries(DEST)) {
    const want = 40_000n;
    const withChange = BigInt(Math.ceil(vbytes(1, [kind, 'p2wpkh']) * rate));
    const noChange = BigInt(Math.ceil(vbytes(1, [kind]) * rate));
    const at = B.plan({ utxos: [coin('d', want + withChange + B.DUST)], to, amount: want, feeRate: rate, change: ME });
    assert.equal(at.outputs.length, 2, kind);
    assert.equal(at.outputs[1].value, B.DUST);
    assert.equal(at.fee, withChange);
    const below = B.plan({ utxos: [coin('d', want + withChange + B.DUST - 1n)], to, amount: want, feeRate: rate, change: ME });
    assert.equal(below.outputs.length, 1, kind);
    assert.equal(below.fee, withChange + B.DUST - 1n);
    const exact = B.plan({ utxos: [coin('e', want + noChange)], to, amount: want, feeRate: rate, change: ME });
    assert.equal(exact.outputs.length, 1);
    assert.equal(exact.fee, noChange);
    assert.equal(exact.vsize, vbytes(1, [kind]));
    assert.throws(() => B.plan({ utxos: [coin('f', want + noChange - 1n)], to, amount: want, feeRate: rate, change: ME }), /about 1 sats short/);
  }
});

test('plan: confirmed coins first, biggest first, only as many as needed', () => {
  const utxos = [coin('u', 1_000_000, { confirmed: false }), coin('c1', 60_000), coin('c2', 70_000), coin('c3', 5_000)];
  const one = B.plan({ utxos, to: DEST.p2tr, amount: 50_000n, feeRate: 5, change: ME });
  assert.deepEqual(one.inputs.map((c) => c.value), [70_000n]);
  checkPlan(one, { utxos, to: DEST.p2tr, amount: 50_000n, feeRate: 5 });
  const two = B.plan({ utxos, to: DEST.p2tr, amount: 100_000n, feeRate: 5, change: ME });
  assert.deepEqual(two.inputs.map((c) => c.value), [70_000n, 60_000n]);
  checkPlan(two, { utxos, to: DEST.p2tr, amount: 100_000n, feeRate: 5 });
  // more than the confirmed coins hold: the unconfirmed one comes in last
  const all = B.plan({ utxos, to: DEST.p2tr, amount: 200_000n, feeRate: 5, change: ME });
  assert.deepEqual(all.inputs.map((c) => c.confirmed), [true, true, true, false]);
  checkPlan(all, { utxos, to: DEST.p2tr, amount: 200_000n, feeRate: 5 });
});

test('plan: max sends every coin, less exactly the fee', () => {
  const utxos = [coin('m1', 30_000), coin('m2', 20_000, { confirmed: false }), coin('m3', 1_000)];
  for (const [kind, to] of Object.entries(DEST)) {
    const p = B.plan({ utxos, to, amount: 0n, feeRate: 7, change: ME, max: true });
    checkPlan(p, { utxos, to, amount: 0n, feeRate: 7, max: true });
    assert.equal(p.fee, BigInt(Math.ceil(vbytes(3, [kind]) * 7)));
    assert.equal(p.amount, 51_000n - p.fee);
  }
  assert.throws(() => B.plan({ utxos: [coin('tiny', 700)], to: DEST.p2wpkh, amount: 0n, feeRate: 2, change: ME, max: true }), /too little left/);
});

test('plan refuses: dust amounts, odd fee rates, no coins, too little, change to an address plum cannot spend from', () => {
  const utxos = [coin('r', 100_000)];
  const base = { utxos, to: DEST.p2wpkh, amount: 10_000n, feeRate: 2, change: ME };
  assert.throws(() => B.plan({ ...base, amount: 545n }), /at least 546/);
  assert.doesNotThrow(() => B.plan({ ...base, amount: 546n }));
  for (const feeRate of [0, 0.5, 501, -1, Number.NaN, Number.POSITIVE_INFINITY, '2']) assert.throws(() => B.plan({ ...base, feeRate }), /fee rate/, String(feeRate));
  for (const feeRate of [1, 1.5, 500]) checkPlan(B.plan({ ...base, feeRate }), { ...base, feeRate });
  assert.throws(() => B.plan({ ...base, utxos: [] }), /no bitcoin/);
  assert.throws(() => B.plan({ ...base, amount: 100_000n }), /more than this wallet holds/);
  for (const change of [DEST.p2tr, DEST.p2pkh, DEST.p2sh, DEST.p2wsh]) assert.throws(() => B.plan({ ...base, change }), /native segwit/);
  assert.throws(() => B.plan({ ...base, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }), /testnet/);
});

test('plan: hundreds of random cases keep every rule', () => {
  let seed = 7;
  const r = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const kinds = Object.keys(DEST);
  let planned = 0, refused = 0;
  for (let i = 0; i < 600; i++) {
    const utxos = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, j) => coin(`rand ${i} ${j}`, 600 + Math.floor(r() ** 3 * 3_000_000), { confirmed: r() < 0.8, vout: j }));
    const to = DEST[kinds[Math.floor(r() * kinds.length)]];
    const feeRate = r() < 0.2 ? 1 + Math.floor(r() * 40) + 0.5 : 1 + Math.floor(r() * 120);
    const max = r() < 0.15;
    const amount = BigInt(546 + Math.floor(r() ** 2 * 4_000_000));
    let p;
    try { p = B.plan({ utxos, to, amount, feeRate, change: ME, max }); } catch (e) {
      refused++;
      const total = sum(utxos.map((c) => c.value));
      if (max) assert.ok(total - BigInt(Math.ceil(vbytes(utxos.length, [B.addressScript(to).kind]) * feeRate)) < B.DUST, e.message);
      else assert.ok(total < amount + BigInt(Math.ceil(vbytes(utxos.length, [B.addressScript(to).kind]) * feeRate)), e.message);
      continue;
    }
    planned++;
    checkPlan(p, { utxos, to, amount, feeRate, max });
  }
  assert.ok(planned > 200 && refused > 50, `${planned} planned, ${refused} refused`);
});

/* ------------------------------------------------------------ BIP-143 sighashes */

test("BIP-143's native P2WPKH example: the references reproduce it, and plum signs its sighash the same", () => {
  const unsigned = '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000';
  const want = 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670';
  const scriptCode = h2b('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
  assert.equal(hex(scriptCode), hex(p2pkhScript(KEY_HASH)), "the example's key is this file's key");
  // bitcoinjs, on the example's own transaction
  const tx = Transaction.fromHex(unsigned);
  assert.equal(hex(tx.hashForWitnessV0(1, scriptCode, 600_000_000n, Transaction.SIGHASH_ALL)), want);
  // the spec's text, written again here
  const spec = {
    version: 1, locktime: 0x11,
    inputs: [{ outpoint: h2b('fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000'), sequence: 0xffffffee },
      { outpoint: h2b('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a01000000'), sequence: 0xffffffff }],
    outputs: [{ value: 112_340_000n, script: h2b('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac') }, { value: 223_450_000n, script: h2b('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac') }],
  };
  const { preimage, sighash } = bip143(spec, 1, scriptCode, 600_000_000n);
  assert.equal(hex(preimage), '0100000096b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd3752b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3bef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a010000001976a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac0046c32300000000ffffffff863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e51100000001000000');
  assert.equal(hex(sighash), want);
  // plum's signature over it is the one in the spec (RFC 6979)
  assert.equal(hex(signBtcDigest(h2b(want), KEY)), '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee');
  // plum always writes version 2, sequence 0xfffffffd (replace-by-fee) and spends only its own P2WPKH coins, so the
  // example's own sighash can't come out of plum: the same inputs and outputs with plum's version and sequence must
  // match both references instead
  const plumTx = {
    inputs: [{ txid: hex(h2b('fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f').reverse()), vout: 0, value: 625_000_000n },
      { txid: hex(h2b('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a').reverse()), vout: 1, value: 600_000_000n }],
    outputs: spec.outputs,
    locktime: 0x11,
  };
  const ours = B.sighashes(plumTx, KEY_HASH);
  const asPlum = { ...spec, version: 2, inputs: spec.inputs.map((i) => ({ ...i, sequence: 0xfffffffd })) };
  const theirs = new Transaction();
  theirs.version = 2;
  theirs.locktime = 0x11;
  for (const i of plumTx.inputs) theirs.addInput(h2b(i.txid).reverse(), i.vout, 0xfffffffd);
  for (const o of spec.outputs) theirs.addOutput(o.script, o.value);
  plumTx.inputs.forEach((input, i) => {
    assert.equal(hex(ours[i]), hex(bip143(asPlum, i, scriptCode, input.value).sighash), `input ${i} vs the spec's text`);
    assert.equal(hex(ours[i]), hex(theirs.hashForWitnessV0(i, scriptCode, input.value, Transaction.SIGHASH_ALL)), `input ${i} vs bitcoinjs`);
  });
});

/* ------------------------------------------------------------ signed transactions */

/** The signer the wallet gives signPlan: the one key, a DER signature per sighash (as wallet.js signBtcAs). */
function walletSigner(key, seen) {
  return async (digests) => {
    seen.push(...digests);
    return { publicKey: btcPublicKey(key), signatures: digests.map((d) => signBtcDigest(d, key)) };
  };
}

async function checkSigned(p, feeRate, label) {
  const seen = [];
  const out = await B.signPlan(p, ME, walletSigner(KEY, seen));
  const tx = Transaction.fromHex(out.raw);
  assert.equal(tx.toHex(), out.raw, `${label}: canonical bytes`);
  assert.equal(tx.getId(), out.txid, `${label}: txid`);
  assert.equal(tx.virtualSize(), out.vsize, `${label}: vsize`);
  assert.equal(tx.version, 2);
  assert.equal(tx.locktime, 0);
  assert.ok(tx.hasWitnesses());
  // the inputs: the planned coins, in order, opt-in RBF, no scriptSig
  assert.equal(tx.ins.length, p.inputs.length);
  assert.equal(seen.length, p.inputs.length, 'one sighash per input');
  const jwkKey = (() => {
    const full = secp256k1.getPublicKey(KEY, false);
    return createPublicKey({ key: { kty: 'EC', crv: 'secp256k1', x: Buffer.from(full.subarray(1, 33)).toString('base64url'), y: Buffer.from(full.subarray(33)).toString('base64url') }, format: 'jwk' });
  })();
  const spec = {
    version: 2, locktime: 0,
    inputs: p.inputs.map((c) => ({ outpoint: outpointOf(c.txid, c.vout), sequence: 0xfffffffd })),
    outputs: p.outputs.map((o) => ({ value: o.value, script: o.script })),
  };
  tx.ins.forEach((input, i) => {
    const c = p.inputs[i];
    assert.equal(hex(Buffer.from(input.hash).reverse()), c.txid, `${label}: input ${i} txid`);
    assert.equal(input.index, c.vout);
    assert.equal(input.sequence, 0xfffffffd, 'sequence 0xfffffffd');
    assert.equal(input.script.length, 0, 'no scriptSig');
    // one signer: the witness is exactly [signature, our key]
    assert.equal(input.witness.length, 2, 'two witness items');
    const [sigWithType, pub] = input.witness;
    assert.equal(hex(pub), hex(PUB), 'our public key');
    assert.equal(sigWithType[sigWithType.length - 1], Transaction.SIGHASH_ALL);
    const der = sigWithType.subarray(0, -1);
    const { s } = parseDer(der);
    assert.ok(s <= N / 2n, 'low s');
    const sighash = tx.hashForWitnessV0(i, p2pkhScript(KEY_HASH), c.value, Transaction.SIGHASH_ALL);
    assert.equal(hex(seen[i]), hex(sighash), `${label}: input ${i} sighash vs bitcoinjs`);
    const { preimage, sighash: ref } = bip143(spec, i, p2pkhScript(KEY_HASH), c.value);
    assert.equal(hex(ref), hex(sighash), `${label}: input ${i} sighash vs the spec's text`);
    assert.ok(secp256k1.verify(der, sighash, PUB, { prehash: false, format: 'der' }), `${label}: input ${i} verifies (noble)`);
    assert.ok(nodeVerify('sha256', sha256(preimage), { key: jwkKey, dsaEncoding: 'der' }, der), `${label}: input ${i} verifies (OpenSSL)`);
  });
  // the outputs: exactly as planned
  assert.equal(tx.outs.length, p.outputs.length);
  tx.outs.forEach((o, i) => {
    assert.equal(hex(o.script), hex(p.outputs[i].script));
    assert.equal(o.value, p.outputs[i].value);
  });
  assert.equal(sum(tx.outs.map((o) => o.value)), sum(p.inputs.map((c) => c.value)) - p.fee);
  // the planned size is the real one or a little more (signatures are 71 or 72 bytes; plum plans for 72)
  const diff = p.vsize - tx.virtualSize();
  assert.ok(diff >= 0 && diff <= Math.max(2, Math.ceil(p.inputs.length / 2)), `${label}: planned ${p.vsize}, real ${tx.virtualSize()}`);
  assert.ok(p.fee >= BigInt(Math.ceil(tx.virtualSize() * feeRate)), `${label}: the fee covers the real size`);
  return { out, tx };
}

test('signPlan: bitcoinjs reads the signed transaction; txid, sighashes, signatures, sequence, outputs all check', async () => {
  const utxos = [coin('s1', 120_000, { vout: 3 }), coin('s2', 80_000, { vout: 0 }), coin('s3', 45_000, { vout: 1, confirmed: false }), coin('s4', 9_000, { vout: 7 })];
  const cases = [];
  for (const [kind, to] of Object.entries(DEST)) {
    cases.push([`${kind}, one coin with change`, { utxos, to, amount: 50_000n, feeRate: 4 }]);
    cases.push([`${kind}, three coins`, { utxos, to, amount: 210_000n, feeRate: 12.5 }]);
    cases.push([`${kind}, everything`, { utxos, to, amount: 0n, feeRate: 9, max: true }]);
  }
  cases.push(['to myself', { utxos, to: ME, amount: 1_000n, feeRate: 1 }]);
  for (const [label, args] of cases) await checkSigned(B.plan({ ...args, change: ME }), args.feeRate, label);
});

test('signPlan: 300 coins (varints past 252) still make a transaction bitcoinjs reads, every input signed', async () => {
  const utxos = Array.from({ length: 300 }, (_, i) => coin(`many ${i}`, 2_000 + i, { vout: i % 5 }));
  const p = B.plan({ utxos, to: DEST.p2wpkh, amount: 0n, feeRate: 1, change: ME, max: true });
  assert.equal(p.inputs.length, 300);
  const { tx } = await checkSigned(p, 1, '300 inputs');
  assert.equal(tx.ins.length, 300);
});

test("signPlan refuses a key that isn't the wallet's, and spends only from bc1q addresses", async () => {
  const p = B.plan({ utxos: [coin('k', 50_000)], to: DEST.p2wpkh, amount: 10_000n, feeRate: 2, change: ME });
  await assert.rejects(B.signPlan(p, ME, walletSigner(bytesOf('someone else'), [])), /isn't this wallet's/);
  await assert.rejects(B.signPlan(p, DEST.p2tr, walletSigner(KEY, [])), /native segwit/);
  // the sighashes commit to every input's amount and every output: change one, and the signature no longer verifies
  const seen = [];
  const out = await B.signPlan(p, ME, walletSigner(KEY, seen));
  const other = B.sighashes({ inputs: p.inputs.map((c) => ({ ...c, value: c.value + 1n })), outputs: p.outputs, locktime: 0 }, KEY_HASH);
  assert.notEqual(hex(other[0]), hex(seen[0]));
  const moved = B.sighashes({ inputs: p.inputs, outputs: [{ ...p.outputs[0], value: p.outputs[0].value - 1n }, p.outputs[1]], locktime: 0 }, KEY_HASH);
  assert.notEqual(hex(moved[0]), hex(seen[0]));
  assert.ok(out.raw.length > 0);
});

/* ------------------------------------------------------------ reading the chain (fetch stubbed) */

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    const res = await handler(String(url), init);
    return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), { status: res.status ?? 200 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test('utxos, balance and fee rates are read and checked; mempool.space first, blockstream.info when it is down', async () => {
  const txid = 'ab'.repeat(32);
  const coins = await withFetch(() => ({ body: [
    { txid, vout: 0, value: 1000, status: { confirmed: true } },
    { txid, vout: 1, value: 2000, status: { confirmed: false } },
    { txid: 'zz', vout: 0, value: 5 }, { txid, vout: -1.5, value: 5 }, { txid, vout: 2, value: 0 }, { txid, vout: 3, value: 2 ** 60 }, null,
  ] }), () => B.utxos(ME));
  assert.deepEqual(coins, [{ txid, vout: 0, value: 1000n, confirmed: true }, { txid, vout: 1, value: 2000n, confirmed: false }]);
  const bal = await withFetch((url) => (url.startsWith('https://mempool.space') ? { status: 503, body: 'down' } : { body: { chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 700, spent_txo_sum: 0, tx_count: 1 } } }),
    async (calls) => ({ b: await B.balance(ME), hosts: calls.map((c) => new URL(c.url).host) }));
  assert.deepEqual(bal.b, { confirmed: 4000n, pending: 700n, total: 4700n, txs: 4 });
  assert.deepEqual(bal.hosts, ['mempool.space', 'blockstream.info']);
  const rates = await withFetch(() => ({ body: { fastestFee: 12.2, halfHourFee: 8, hourFee: 0.4 } }), () => B.feeRates());
  assert.deepEqual(rates, { fast: 13, normal: 8, slow: 1 });
  const fallback = await withFetch((url) => (url.includes('mempool.space') ? { status: 500, body: '' } : { body: { 2: 20.5, 3: 11, 6: 3.2 } }), () => B.feeRates());
  assert.deepEqual(fallback, { fast: 21, normal: 11, slow: 4 });
});

test('broadcast: the txid is checked, "already in the mempool" counts as sent, a refusal is final', async () => {
  const p = B.plan({ utxos: [coin('b', 50_000)], to: DEST.p2wpkh, amount: 10_000n, feeRate: 2, change: ME });
  const { raw, txid } = await B.signPlan(p, ME, walletSigner(KEY, []));
  const sent = await withFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.body, raw);
    return { body: txid };
  }, async (calls) => ({ got: await B.broadcast(raw, txid), n: calls.length }));
  assert.deepEqual(sent, { got: txid, n: 1 });
  assert.equal(await withFetch(() => ({ status: 400, body: 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}' }), () => B.broadcast(raw, txid)), txid);
  assert.equal(await withFetch(() => ({ status: 400, body: 'txn-already-in-mempool' }), () => B.broadcast(raw, txid)), txid);
  await withFetch(() => ({ status: 400, body: 'bad-txns-inputs-missingorspent' }), async (calls) => {
    await assert.rejects(B.broadcast(raw, txid), /refused the send/);
    assert.equal(calls.length, 1, 'not sent to the other provider');
  });
  await withFetch(() => ({ body: 'ff'.repeat(32) }), () => assert.rejects(B.broadcast(raw, txid), /different transaction id/));
  const over = await withFetch((url) => (url.startsWith('https://mempool.space') ? { status: 502, body: '' } : { body: txid }), async (calls) => ({ got: await B.broadcast(raw, txid), n: calls.length }));
  assert.deepEqual(over, { got: txid, n: 2 });
});
