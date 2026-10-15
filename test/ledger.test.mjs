// The Ledger layer's own parts: HID framing, APDUs and status words, the Bitcoin app's client commands and Merkle
// commitments, Solana's off-chain message header, EIP-712 values, and the device manager waiting for you (unplugged,
// locked, another app open) and switching apps. What the real apps take is checked by test/ledger-speculos.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, hex, utf8 } from '../src/shared/bytes.js';
import * as A from '../src/background/ledger/apdu.js';
import * as LB from '../src/background/ledger/bitcoin.js';
import * as D from '../src/background/ledger/device.js';
import * as LE from '../src/background/ledger/ethereum.js';
import * as LS from '../src/background/ledger/solana.js';
import { collector, frames, modelOf } from '../src/background/ledger/hid.js';
import { fakeLedger } from './fake-ledger.mjs';

const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/* ------------------------------------------------------------ HID framing */

test('an APDU goes out in 64-byte reports: channel, tag 0x05, sequence, then the length and the APDU', () => {
  const [f] = frames(0x0101, fromHex('b001000000'));
  assert.equal(f.length, 64);
  assert.equal(hex(f.subarray(0, 12)), '010105000000' + '05b001000000'.slice(0, 12));
  assert.equal(hex(f.subarray(0, 7)), '01010500000005');
  assert.equal(hex(f.subarray(7, 12)), 'b001000000');
  assert.ok(f.subarray(12).every((b) => b === 0));
  // 300 bytes: 2 + 300 = 302 over 59-byte pieces -> 6 reports, numbered 0 to 5
  const many = frames(0xabcd, new Uint8Array(300).fill(7));
  assert.equal(many.length, 6);
  many.forEach((r, i) => { assert.equal(hex(r.subarray(0, 5)), `abcd05${i.toString(16).padStart(4, '0')}`); });
  assert.equal(hex(many[0].subarray(5, 7)), '012c');
});

test('an answer is put back together from its reports, and a report out of place is refused', () => {
  const answer = new Uint8Array(130).map((_, i) => i);
  const reports = frames(0x1234, answer);
  const c = collector(0x1234);
  let out = null;
  for (const r of reports) out = c.push(r);
  assert.equal(hex(out), hex(answer));
  assert.throws(() => collector(0x1234).push(frames(0x9999, answer)[0]), /another channel/);
  const badTag = frames(0x1234, answer)[0];
  badTag[2] = 0x02;
  assert.throws(() => collector(0x1234).push(badTag), /doesn't know/);
  const c2 = collector(0x1234);
  c2.push(reports[0]);
  assert.throws(() => c2.push(reports[2]), /out of order/);
  assert.throws(() => collector(0x1234).push(new Uint8Array(3)), /too short/);
});

test('the model comes from the USB product id', () => {
  assert.equal(modelOf(0x5011), 'Nano S Plus');
  assert.equal(modelOf(0x4015), 'Nano X');
  assert.equal(modelOf(0x0001), 'Nano S');
  assert.equal(modelOf(0x6011), 'Stax');
  assert.equal(modelOf(0x7011), 'Flex');
});

/* ------------------------------------------------------------ APDUs and status words */

test('paths go as their step count and 4-byte big-endian steps, hardened ones with the top bit set', () => {
  assert.equal(hex(A.pathBytes("m/44'/501'/0'/0'")), '048000002c800001f58000000080000000');
  assert.equal(hex(A.pathBytes("m/44'/60'/0'/0/7")), '058000002c8000003c800000000000000000000007');
  for (const bad of ['', 'm', "44'/0'", "m/2147483648'", 'm/x', null]) assert.throws(() => A.pathBytes(bad));
  assert.throws(() => A.apdu(0xe0, 1, 0, 0, new Uint8Array(256)), /255/);
});

test('status words become states you can act on, in plain words', () => {
  const s = (sw, opts) => A.swError(sw, opts).state;
  assert.equal(s(0x5515), 'locked');
  assert.equal(s(0x6985), 'rejected');
  assert.equal(s(0x5501), 'rejected');
  assert.equal(s(0x6e00), 'open-app');
  assert.equal(s(0x6d00), 'open-app');
  assert.equal(s(0x6807), 'not-installed');
  assert.equal(s(0x6a84), 'too-large');
  assert.equal(s(0x1234), 'error');
  assert.match(A.swError(0x1234).message, /0x1234/);
  assert.equal(A.swError(0x6e00, { app: 'Solana' }).message, 'open the Solana app on your Ledger');
  assert.equal(A.swError(0x6808, { own: { 0x6808: ['blind-sign', 'x'] } }).state, 'blind-sign');
  // a no can't be retried; a device that wasn't ready can
  assert.equal(A.swError(0x6985).retry, false);
  assert.equal(A.swError(0x5515).retry, true);
  assert.throws(() => A.splitAnswer(Uint8Array.of(0x90)), /nothing plum can read/);
});

test('the open app and its version are read from what every app answers (and the dashboard too)', async () => {
  const link = { exchange: async () => fromHex('0106536f6c616e6106312e31352e3201009000') };
  assert.deepEqual(await A.appInfo(link), { name: 'Solana', version: '1.15.2' });
  await assert.rejects(A.appInfo({ exchange: async () => fromHex('5515') }), (e) => e.state === 'locked');
  await assert.rejects(A.appInfo({ exchange: async () => fromHex('6982') }), (e) => e.state === 'locked');
  await assert.rejects(A.appInfo({ exchange: async () => fromHex('01ff9000') }), /doesn't read/);
  assert.equal(A.atLeast('1.9.19', '1.9.19'), true);
  assert.equal(A.atLeast('1.10.0', '1.9.19'), true);
  assert.equal(A.atLeast('1.9.2', '1.9.19'), false);
  assert.equal(A.atLeast('2.1.0-rc', '2.1.0'), true);
});

/* ------------------------------------------------------------ Solana */

test("a Solana message is wrapped in today's off-chain header, or the older one", () => {
  const signer = new Uint8Array(32).fill(1);
  const m = LS.offchainMessage(utf8('hi'), signer);
  assert.equal(m.length, 16 + 1 + 32 + 1 + 1 + 32 + 2 + 2);
  assert.equal(hex(m.subarray(0, 16)), hex(concat(Uint8Array.of(0xff), utf8('solana offchain'))));
  assert.equal(m[16], 0); // version
  assert.ok(m.subarray(17, 49).every((b) => b === 0)); // no application domain
  assert.equal(m[49], 0); // ASCII
  assert.equal(m[50], 1); // one signer
  assert.equal(hex(m.subarray(51, 83)), hex(signer));
  assert.equal(hex(m.subarray(83, 85)), '0200');
  assert.equal(LS.offchainMessage(utf8('été'), signer)[49], 1); // UTF-8
  const old = LS.offchainMessage(utf8('hi'), signer, { legacy: true });
  assert.equal(hex(old.subarray(16)), `0000${'0200'}${hex(utf8('hi'))}`);
  assert.throws(() => LS.offchainMessage(Uint8Array.of(0xff, 0xfe), signer), /isn't/);
  assert.throws(() => LS.offchainMessage(new Uint8Array(1200).fill(0x61), signer), (e) => e.state === 'too-large');
});

test('a v1 Solana transaction is refused before it reaches the device', async () => {
  let sent = 0;
  const link = { exchange: async () => { sent++; return fromHex('9000'); } };
  await assert.rejects(LS.signTransaction(link, "m/44'/501'/0'/0'", Uint8Array.of(0x81, 1, 0, 0)), (e) => e.state === 'refused' && /v1/.test(e.message));
  assert.equal(sent, 0);
});

test('an off-chain message the app reads only in the older header is sent again in it', async () => {
  const seen = [];
  const link = {
    exchange: async (apdu) => {
      seen.push(apdu);
      // header byte 16 + 1 + 32: today's format byte; the older header has the length there instead
      return seen.length === 1 ? fromHex('6a81') : concat(new Uint8Array(64).fill(3), fromHex('9000'));
    },
  };
  const out = await LS.signOffchain(link, "m/44'/501'/0'/0'", utf8('hello'), new Uint8Array(32));
  assert.equal(seen.length, 2);
  assert.equal(out.signed.length, 20 + 5);
});

/* ------------------------------------------------------------ Ethereum */

test('EIP-712 values go as the app reads them: integers with no leading zeros, negatives in their size', () => {
  assert.equal(hex(LE.valueBytes('uint', 256, '0')), '00');
  assert.equal(hex(LE.valueBytes('uint', 256, 128)), '80');
  assert.equal(hex(LE.valueBytes('uint', 256, '0x0100')), '0100');
  assert.equal(hex(LE.valueBytes('int', 16, -3)), 'fffd');
  assert.equal(hex(LE.valueBytes('int', 256, '-1')), 'ff'.repeat(32));
  assert.equal(hex(LE.valueBytes('bool', null, true)), '01');
  assert.equal(hex(LE.valueBytes('bool', null, 'false')), '00');
  assert.equal(hex(LE.valueBytes('address', null, '0x000000000000000000000000000000000000dEaD')), '000000000000000000000000000000000000dead');
  assert.equal(hex(LE.valueBytes('string', null, 'hé')), hex(utf8('hé')));
  assert.equal(hex(LE.valueBytes('bytes', 2, '0xabcd')), 'abcd');
  assert.deepEqual(LE.splitType('uint256[2][]'), { base: 'uint', size: 256, levels: [2, null] });
  assert.deepEqual(LE.splitType('Person'), { base: 'Person', size: null, levels: [] });
  assert.deepEqual(LE.splitType('Asset2[]'), { base: 'Asset2', size: null, levels: [null] });
});

test('a signature from the device comes back with a low s (the same signature)', () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const big = (n) => fromHex(n.toString(16).padStart(64, '0'));
  const high = concat(Uint8Array.of(27), big(5n), big(N - 7n));
  const sig = LE.readSignature(high);
  assert.equal(hex(sig.s), hex(big(7n)));
  assert.equal(sig.yParity, 1);
  assert.throws(() => LE.readSignature(concat(Uint8Array.of(27), big(0n), big(7n))), (e) => e.state === 'mismatch');
  assert.throws(() => LE.readSignature(concat(Uint8Array.of(27), big(N), big(7n))), (e) => e.state === 'mismatch');
  assert.throws(() => LE.readSignature(concat(Uint8Array.of(5), big(5n), big(7n))), (e) => e.state === 'mismatch');
  assert.throws(() => LE.readSignature(new Uint8Array(64)), (e) => e.state === 'mismatch');
  assert.equal(LE.readSignature(concat(Uint8Array.of(1), big(5n), big(7n)), { typedTx: true }).yParity, 1);
});

test('the device must give an Ethereum address that comes from its own public key', async () => {
  const dev = fakeLedger({ app: 'Ethereum' });
  const link = await dev.opener();
  assert.equal(await LE.address(link, "m/44'/60'/0'/0/0"), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  dev.lie.ethAddressText = () => '000000000000000000000000000000000000dead';
  await assert.rejects(LE.address(link, "m/44'/60'/0'/0/0"), (e) => e.state === 'mismatch');
});

/* ------------------------------------------------------------ Bitcoin */

test('Merkle roots and proofs follow the app (an empty list is 32 zero bytes; leaves and nodes are kept apart)', () => {
  assert.equal(hex(LB.merkleRoot([])), '00'.repeat(32));
  const leaves = Array.from({ length: 7 }, (_, i) => LB.elementHash(Uint8Array.of(i)));
  const root = LB.merkleRoot(leaves);
  const node = (l, r) => sha256(concat(Uint8Array.of(1), l, r));
  // 7 leaves: the left subtree holds 4
  const expect = node(node(node(leaves[0], leaves[1]), node(leaves[2], leaves[3])), node(node(leaves[4], leaves[5]), leaves[6]));
  assert.equal(hex(root), hex(expect));
  for (let i = 0; i < 7; i++) {
    // walk the proof back up to the root
    const proof = LB.merkleProof(leaves, i);
    const walk = (list, idx, rest) => {
      if (list.length === 1) return list[0];
      let k = 1;
      while (k * 2 < list.length) k *= 2;
      const sibling = rest.pop();
      return idx < k ? node(walk(list.slice(0, k), idx, rest), sibling) : node(sibling, walk(list.slice(k), idx - k, rest));
    };
    assert.equal(hex(walk(leaves, i, [...proof])), hex(root), `leaf ${i}`);
  }
});

test("the client commands answer only what plum committed to, and the device's odd questions are refused", () => {
  const it = new LB.Interpreter();
  const long = new Uint8Array(400).map((_, i) => i & 0xff);
  it.addPreimage(long);
  // GET_PREIMAGE: the length (a 3-byte varint), what fits (255 - 3 - 1), the rest queued a byte at a time for
  // GET_MORE_ELEMENTS
  const a = it.execute(concat(Uint8Array.of(0x40, 0x00), sha256(long)));
  assert.equal(hex(a.subarray(0, 4)), 'fd9001fb');
  assert.equal(a.length, 4 + 251);
  assert.equal(it.queue.length, 400 - 251);
  const more = it.execute(Uint8Array.of(0xa0));
  assert.equal(more[0], 149);
  assert.equal(more[1], 1);
  assert.equal(hex(more.subarray(2)), hex(long.subarray(251)));
  assert.throws(() => it.execute(concat(Uint8Array.of(0x40, 0x00), new Uint8Array(32))), /never committed/);
  assert.throws(() => it.execute(concat(Uint8Array.of(0x40, 0x01), sha256(long))), /doesn't know/);
  const it2 = new LB.Interpreter();
  it2.addList([utf8('a'), utf8('b'), utf8('c')]);
  const root = LB.merkleRoot([utf8('a'), utf8('b'), utf8('c')].map(LB.elementHash));
  const proof = it2.execute(concat(Uint8Array.of(0x41), root, Uint8Array.of(3, 2)));
  assert.equal(hex(proof.subarray(0, 32)), hex(LB.elementHash(utf8('c'))));
  assert.equal(proof[32], 1);
  assert.throws(() => it2.execute(concat(Uint8Array.of(0x41), root, Uint8Array.of(4, 2))), /can't give/);
  assert.throws(() => it2.execute(concat(Uint8Array.of(0x41), root, Uint8Array.of(3, 3))), /can't give/);
  assert.equal(hex(it2.execute(concat(Uint8Array.of(0x42), root, LB.elementHash(utf8('b'))))), '0101');
  assert.equal(hex(it2.execute(concat(Uint8Array.of(0x42), root, new Uint8Array(32)))), '0000');
  assert.throws(() => it2.execute(Uint8Array.of(0xa0)), /more than plum had/);
  assert.throws(() => it2.execute(Uint8Array.of(0x77)), /doesn't know/);
  assert.equal(hex(it2.execute(Uint8Array.of(0x10, 1, 2))), '');
  assert.deepEqual([...it2.yielded[0]], [1, 2]);
});

test("the default native segwit policy's id is the app's: version 2, no name, the template's hash, the keys' root", () => {
  const p = LB.segwitPolicy('73c5da0a', 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V');
  const s = LB.serializePolicy(p);
  assert.equal(s[0], 2);
  assert.equal(s[1], 0);
  assert.equal(s[2], 11); // "wpkh(@0/**)"
  assert.equal(hex(s.subarray(3, 35)), hex(sha256(utf8('wpkh(@0/**)'))));
  assert.equal(s[35], 1);
  assert.equal(hex(s.subarray(36)), hex(LB.elementHash(utf8(p.keys[0]))));
  assert.equal(hex(LB.policyId(p)), hex(sha256(s)));
});

test('a previous transaction is read without its witnesses and checked against its txid', () => {
  // a segwit transaction: version, marker and flag, one input, one output, a witness of two items, locktime
  const body = concat(Uint8Array.of(1), new Uint8Array(32).fill(1), fromHex('00000000'), Uint8Array.of(0), fromHex('ffffffff'), Uint8Array.of(1), fromHex('1027000000000000'), Uint8Array.of(22, 0, 20), new Uint8Array(20).fill(2));
  const plain = concat(fromHex('02000000'), body, fromHex('00000000'));
  const txid = hex(sha256(sha256(plain)).reverse());
  const segwit = concat(fromHex('02000000'), Uint8Array.of(0, 1), body, Uint8Array.of(2, 2, 0xaa, 0xbb, 1, 0xcc), fromHex('00000000'));
  assert.equal(hex(LB.stripWitness(hex(segwit), txid)), hex(plain));
  assert.equal(hex(LB.stripWitness(hex(plain), txid)), hex(plain));
  assert.throws(() => LB.stripWitness(hex(plain), '00'.repeat(32)), /isn't the one/);
  assert.throws(() => LB.stripWitness(`${hex(plain)}00`, txid), /left over/);
  assert.throws(() => LB.stripWitness(hex(plain).slice(0, 40), txid), /cut short/);
  assert.throws(() => LB.stripWitness('zz', txid), /malformed/);
});

test('a Bitcoin app older than 2.1 (or the legacy one) is refused with a plain reason', () => {
  assert.throws(() => LB.checkApp({ name: 'Bitcoin', version: '2.0.6' }), (e) => e.state === 'old-app');
  assert.throws(() => LB.checkApp({ name: 'Bitcoin Legacy', version: '2.1.0' }), (e) => e.state === 'old-app');
  assert.doesNotThrow(() => LB.checkApp({ name: 'Bitcoin', version: '2.1.0' }));
});

/* ------------------------------------------------------------ the device manager */

test('plum waits while the device is unplugged, locked or on another app, and says which', async () => {
  const dev = fakeLedger({ app: 'Ethereum' });
  dev.connected = false;
  D._setOpener(dev.opener);
  const seen = [];
  const watch = setInterval(() => { const s = D.status().state; if (seen.at(-1) !== s) seen.push(s); }, 20);
  const run = D.use('Solana', async (link, info) => info.name, { wait: 20_000 });
  await new Promise((r) => setTimeout(r, 1500));
  dev.connected = true;
  dev.locked = true;
  await new Promise((r) => setTimeout(r, 1500));
  dev.locked = false;
  assert.equal(await run, 'Solana');
  clearInterval(watch);
  assert.ok(seen.includes('connect'), seen.join(' '));
  assert.ok(seen.includes('locked'), seen.join(' '));
  // the Ethereum app was closed and Solana opened, by plum
  assert.equal(dev.openRequests, 1);
  assert.equal(D.status().state, 'idle');
  D._setOpener(null);
});

test('one operation at a time: another one asked meanwhile is turned away', async () => {
  const dev = fakeLedger({ app: 'Solana' });
  D._setOpener(dev.opener);
  let release;
  const first = D.use('Solana', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(D.use('Solana', async () => 1), (e) => e.state === 'busy');
  release(7);
  assert.equal(await first, 7);
  assert.equal(await D.use('Solana', async () => 8), 8);
  D._setOpener(null);
});

test('stopping in plum ends the wait at once; an app that is not installed ends it with a plain reason', async () => {
  const dev = fakeLedger({ app: 'BOLOS' });
  dev.connected = false;
  D._setOpener(dev.opener);
  const run = D.use('Solana', async () => 1);
  await new Promise((r) => setTimeout(r, 200));
  D.cancel();
  await assert.rejects(run, (e) => e.state === 'cancelled' && e.retry === false);
  dev.connected = true;
  await assert.rejects(D.use('Monero', async () => 1), (e) => e.state === 'not-installed');
  D._setOpener(null);
});
