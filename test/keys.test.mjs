// Keys: SLIP-0010 against the spec's own vectors and an independent implementation (node:crypto + web3.js), the
// phrase paths other wallets use, private key import and export.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base58Encode } from '../src/shared/base58.js';
import { hex } from '../src/shared/bytes.js';
import { addressOf as addressOn, exportPrivateKey as exportOn, isMnemonic, newMnemonic, normalizeMnemonic, parsePrivateKey as parseKey, schemePaths, secretAt as secretOn, signSol as sign, slip10, verifySol as verify } from '../src/background/keys.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// the Solana side of keys.js, in the shape these tests were first written for
const PATHS = { bip44change: (i) => schemePaths('bip44change', i).sol, bip44: (i) => schemePaths('bip44', i).sol };
const secretAt = (seed, path) => secretOn(seed, 'sol', path);
const addressOf = (secret) => addressOn('sol', secret);
const parsePrivateKey = (s) => { const k = parseKey(s); assert.equal(k.chain, 'sol'); return k.secret; };
const exportPrivateKey = (secret) => exportOn('sol', secret);

test('SLIP-0010 ed25519 test vector 1 (from the spec)', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const want = {
    '': '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    "0'": '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    "0'/1'": 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    "0'/1'/2'": '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
    "0'/1'/2'/2'": '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
    "0'/1'/2'/2'/1000000000'": '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
  };
  for (const [p, key] of Object.entries(want)) {
    const path = p ? p.split('/').map((s) => Number.parseInt(s, 10)) : [];
    assert.equal(hex(slip10(seed, path)), key, `m/${p}`);
  }
});

/** SLIP-0010 again, written separately on node:crypto, as a second opinion. */
function slip10Node(seed, path) {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  for (const i of path) {
    const data = Buffer.concat([Buffer.alloc(1), I.subarray(0, 32), Buffer.from([((i | 0x80000000) >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255])]);
    I = createHmac('sha512', I.subarray(32)).update(data).digest();
  }
  return I.subarray(0, 32);
}

test("a phrase gives the same accounts as Phantom's path, by two independent implementations", () => {
  const seed = mnemonicToSeedSync(ABANDON);
  for (let i = 0; i < 5; i++) {
    const ours = addressOf(secretAt(seed, PATHS.bip44change(i)));
    const theirs = Keypair.fromSeed(slip10Node(seed, [44, 501, i, 0])).publicKey.toBase58();
    assert.equal(ours, theirs, `account ${i}`);
  }
  // the well-known first account of the all-"abandon" phrase on m/44'/501'/0'/0'
  assert.equal(addressOf(secretAt(seed, PATHS.bip44change(0))), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  // the cli way: the seed's first 32 bytes
  assert.equal(addressOf(secretAt(seed, null)), Keypair.fromSeed(seed.subarray(0, 32)).publicKey.toBase58());
});

test('new phrases are valid, 12 or 24 words, and never repeat', () => {
  const a = newMnemonic(), b = newMnemonic(), c = newMnemonic(24);
  assert.equal(a.split(' ').length, 12);
  assert.equal(c.split(' ').length, 24);
  assert.notEqual(a, b);
  assert.ok(isMnemonic(a) && isMnemonic(c));
  assert.ok(isMnemonic(`  ${a.toUpperCase().replace(/ /g, '   ')}  `), 'spacing and case are forgiven');
  assert.equal(normalizeMnemonic(` Abandon  ABOUT `), 'abandon about');
  assert.ok(!isMnemonic(ABANDON.replace('about', 'abandon')), 'a bad checksum is caught');
});

test('private keys: base58 (Phantom export), a CLI keypair file, a bare 32-byte secret; mismatches refused', () => {
  const kp = Keypair.generate();
  const addr = kp.publicKey.toBase58();
  assert.equal(addressOf(parsePrivateKey(base58Encode(kp.secretKey))), addr);
  assert.equal(addressOf(parsePrivateKey(JSON.stringify([...kp.secretKey]))), addr);
  assert.equal(addressOf(parsePrivateKey(base58Encode(kp.secretKey.subarray(0, 32)))), addr);
  const forged = Uint8Array.from(kp.secretKey);
  forged.set(Keypair.generate().publicKey.toBytes(), 32);
  assert.throws(() => parsePrivateKey(base58Encode(forged)), /doesn't match/);
  assert.throws(() => parsePrivateKey('not a key at all 0OIl'), /base58/);
  assert.throws(() => parsePrivateKey('[1,2,3]'), /3 bytes/);
  assert.throws(() => parsePrivateKey('[1,2,999]'), /0 to 255/);
  assert.equal(exportPrivateKey(kp.secretKey.subarray(0, 32)), base58Encode(kp.secretKey));
});

test('signatures verify, and only for their message', () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const kp = Keypair.fromSeed(secret);
  const msg = new TextEncoder().encode('plum');
  const sig = sign(msg, secret);
  assert.ok(verify(sig, msg, kp.publicKey.toBytes()));
  assert.ok(!verify(sig, new TextEncoder().encode('plun'), kp.publicKey.toBytes()));
});
