// Keys on Ethereum and Bitcoin (and Solana's alongside them): BIP-32 against the spec's own vectors and a second
// implementation written here on node:crypto (OpenSSL's HMAC and secp256k1), the all-"abandon" phrase against viem,
// bitcoinjs, web3.js and BIP-84's vectors, the only paths plum will derive, private keys pasted in, and signatures
// checked by other libraries.
import assert from 'node:assert/strict';
import { createECDH, createHash, createHmac, createPublicKey, pbkdf2Sync, verify as nodeVerify } from 'node:crypto';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import { Keypair } from '@solana/web3.js';
import { payments } from 'bitcoinjs-lib';
import { bytesToHex, getAddress, keccak256, recoverAddress } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, publicKeyToAddress, sign as viemSign } from 'viem/accounts';
import { base58Encode } from '../src/shared/base58.js';
import { hex } from '../src/shared/bytes.js';
import {
  CHAINS, SCHEMES, addressOf, btcAddressOfPublicKey, btcPublicKey, checksumEth, ethAddressOfPublicKey, exportPrivateKey,
  parsePrivateKey, schemePaths, secretAt, seedOf, signBtcDigest, signEthDigest, validPath,
} from '../src/background/keys.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/* ------------------------------------------------------------ a second implementation, on node:crypto */

const big = (b) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
const be32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const sha256 = (b) => createHash('sha256').update(b).digest();
const hash160 = (b) => createHash('ripemd160').update(sha256(b)).digest();

/** A secp256k1 public key by OpenSSL. */
function pointOf(priv, compressed = true) {
  const e = createECDH('secp256k1');
  e.setPrivateKey(Buffer.from(priv));
  return e.getPublicKey(null, compressed ? 'compressed' : 'uncompressed');
}

/** BIP-32 private derivation, from the spec's text: { key, chainCode } at a path like "m/0'/1". */
function bip32Node(seed, path) {
  let I = createHmac('sha512', 'Bitcoin seed').update(seed).digest();
  let k = big(I.subarray(0, 32));
  let c = I.subarray(32);
  for (const step of path.split('/').slice(1)) {
    const hardened = /['hH]$/.test(step);
    const index = Buffer.alloc(4);
    index.writeUInt32BE(Number.parseInt(step, 10) + (hardened ? 0x80000000 : 0));
    const data = hardened ? Buffer.concat([Buffer.alloc(1), be32(k), index]) : Buffer.concat([pointOf(be32(k)), index]);
    I = createHmac('sha512', c).update(data).digest();
    k = (big(I.subarray(0, 32)) + k) % N;
    c = I.subarray(32);
  }
  return { key: be32(k), chainCode: Buffer.from(c) };
}

/** SLIP-0010 for ed25519, written separately (as in keys.test.mjs). */
function slip10Node(seed, path) {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  for (const i of path) {
    const data = Buffer.concat([Buffer.alloc(1), I.subarray(0, 32), Buffer.from([((i | 0x80000000) >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255])]);
    I = createHmac('sha512', I.subarray(32)).update(data).digest();
  }
  return I.subarray(0, 32);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  let h = n ? n.toString(16) : '';
  if (h.length % 2) h = `0${h}`;
  return Buffer.concat([Buffer.alloc(s.match(/^1*/)[0].length), Buffer.from(h, 'hex')]);
}
function b58encode(buf) {
  let n = big(buf);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}
const b58check = (body) => b58encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
function b58uncheck(s) {
  const raw = b58decode(s);
  const body = raw.subarray(0, -4);
  assert.equal(hex(raw.subarray(-4)), hex(sha256(sha256(body)).subarray(0, 4)), `${s} has a bad checksum`);
  return body;
}
/** An extended private key (xprv, zprv): its chain code and key. */
function decodeXprv(s) {
  const body = b58uncheck(s);
  assert.equal(body.length, 78);
  assert.equal(body[45], 0);
  return { chainCode: body.subarray(13, 45), key: body.subarray(46, 78) };
}
const wif = (key, { version = 0x80, compressed = true } = {}) => b58check(Buffer.concat([Buffer.from([version]), Buffer.from(key), compressed ? Buffer.from([1]) : Buffer.alloc(0)]));

/** BIP-66 strict DER: { r, s } as numbers. */
function parseDer(sig) {
  assert.equal(sig[0], 0x30, 'a DER sequence');
  assert.equal(sig[1], sig.length - 2, 'its length');
  assert.equal(sig[2], 0x02);
  const rlen = sig[3];
  const r = sig.subarray(4, 4 + rlen);
  assert.equal(sig[4 + rlen], 0x02);
  const slen = sig[5 + rlen];
  const s = sig.subarray(6 + rlen, 6 + rlen + slen);
  assert.equal(6 + rlen + slen, sig.length, 'nothing after s');
  for (const x of [r, s]) {
    assert.ok(x.length > 0 && x.length <= 33);
    assert.ok(x[0] < 0x80, 'not negative');
    if (x.length > 1) assert.ok(!(x[0] === 0 && x[1] < 0x80), 'no needless leading zero');
  }
  return { r: big(r), s: big(s) };
}

/* ------------------------------------------------------------ BIP-32 */

const VECTOR_1 = {
  seed: '000102030405060708090a0b0c0d0e0f',
  keys: {
    m: 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    "m/0'": 'xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7',
    "m/0'/1": 'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs',
    "m/0'/1/2'": 'xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM',
    "m/0'/1/2'/2": 'xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334',
    "m/0'/1/2'/2/1000000000": 'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
  },
};
// leading zeros in a private key are kept (the spec's vector 3)
const VECTOR_3 = {
  seed: '4b381541583be4423346c643850da4b320e46a87ae3d2a4e6da11eba819cd4acba45d239319ac14f863b8d5ab5a0d0c64d2e8a1e7d1457df2e5a3c51c73235be',
  keys: {
    m: 'xprv9s21ZrQH143K25QhxbucbDDuQ4naNntJRi4KUfWT7xo4EKsHt2QJDu7KXp1A3u7Bi1j8ph3EGsZ9Xvz9dGuVrtHHs7pXeTzjuxBrCmmhgC6',
    "m/0'": 'xprv9uPDJpEQgRQfDcW7BkF7eTya6RPxXeJCqCJGHuCJ4GiRVLzkTXBAJMu2qaMWPrS7AANYqdq6vcBcBUdJCVVFceUvJFjaPdGZ2y9WACViL4L',
  },
};

test("BIP-32 test vectors 1 and 3: the spec's keys, by the second implementation and by @scure/bip32 as plum calls it", () => {
  for (const vector of [VECTOR_1, VECTOR_3]) {
    const seed = Buffer.from(vector.seed, 'hex');
    for (const [path, xprv] of Object.entries(vector.keys)) {
      const want = decodeXprv(xprv);
      const ours = bip32Node(seed, path);
      assert.equal(hex(ours.key), hex(want.key), `${path} key (second implementation)`);
      assert.equal(hex(ours.chainCode), hex(want.chainCode), `${path} chain code (second implementation)`);
      const root = HDKey.fromMasterSeed(seed);
      assert.equal(hex(root.derive(path).privateKey), hex(want.key), `${path} key (@scure/bip32)`);
    }
  }
  // the vector 1 keys spelled out, as a check on the xprv decoding above
  const seed = Buffer.from(VECTOR_1.seed, 'hex');
  assert.equal(hex(bip32Node(seed, 'm').key), 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35');
  assert.equal(hex(bip32Node(seed, "m/0'/1/2'/2/1000000000").key), '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8');
});

test('secretAt agrees with the second implementation on every Ethereum and Bitcoin path plum derives', () => {
  for (const seed of [seedOf(ABANDON), Buffer.from(VECTOR_1.seed, 'hex'), Buffer.alloc(64, 0xa5)]) {
    for (const n of [0, 1, 2, 3, 4, 77, 999_999_999]) {
      for (const scheme of ['bip44change', 'bip44']) {
        for (const [chain, path] of Object.entries(schemePaths(scheme, n))) {
          if (chain === 'sol') continue;
          assert.equal(hex(secretAt(seed, chain, path)), hex(bip32Node(seed, path).key), `${chain} ${path}`);
        }
      }
    }
  }
});

/* ------------------------------------------------------------ the all-"abandon" phrase */

test('the phrase becomes the BIP-39 seed (PBKDF2 by node:crypto), whatever its spacing and case', () => {
  const want = pbkdf2Sync(ABANDON.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
  assert.equal(hex(seedOf(ABANDON)), hex(want));
  assert.equal(hex(seedOf(`  ${ABANDON.toUpperCase().replace(/ /g, ' \t ')}\n`)), hex(want));
});

test("Ethereum wallets 0..4 are viem's (m/44'/60'/0'/0/n, and the older m/44'/60'/1'/0/n)", () => {
  const seed = seedOf(ABANDON);
  for (let n = 0; n < 5; n++) {
    const path = schemePaths('bip44change', n).eth;
    assert.equal(path, `m/44'/60'/0'/0/${n}`);
    const secret = secretAt(seed, 'eth', path);
    assert.equal(addressOf('eth', secret), mnemonicToAccount(ABANDON, { addressIndex: n }).address, `wallet ${n}`);
    assert.equal(addressOf('eth', secret), privateKeyToAccount(bytesToHex(secret)).address);
    const old = schemePaths('bip44', n).eth;
    assert.equal(old, `m/44'/60'/1'/0/${n}`);
    assert.equal(addressOf('eth', secretAt(seed, 'eth', old)), mnemonicToAccount(ABANDON, { accountIndex: 1, addressIndex: n }).address, `bip44 wallet ${n}`);
  }
  // the phrase's well-known first Ethereum address
  assert.equal(addressOf('eth', secretAt(seed, 'eth', "m/44'/60'/0'/0/0")), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});

test("Bitcoin wallets are BIP-84's own vectors, and bitcoinjs's addresses for wallets 0..4", () => {
  const seed = seedOf(ABANDON);
  // BIP-84's account key (a zprv) is the second implementation's m/84'/0'/0'
  const account = decodeXprv('zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE');
  assert.equal(hex(bip32Node(seed, "m/84'/0'/0'").key), hex(account.key));
  const bip84 = [
    { path: "m/84'/0'/0'/0/0", wif: 'KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d', pub: '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
    { path: "m/84'/0'/0'/0/1", wif: 'Kxpf5b8p3qX56DKEe5NqWbNUP9MnqoRFzZwHRtsFqhzuvUJsYZCy', pub: '03e775fd51f0dfb8cd865d9ff1cca2a158cf651fe997fdc9fee9c1d3b5e995ea77', address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' },
  ];
  for (const v of bip84) {
    const secret = secretAt(seed, 'btc', v.path);
    assert.equal(addressOf('btc', secret), v.address, v.path);
    assert.equal(hex(btcPublicKey(secret)), v.pub);
    assert.equal(exportPrivateKey('btc', secret), v.wif, 'the WIF plum exports is the spec\'s');
    const back = parsePrivateKey(v.wif);
    assert.equal(back.chain, 'btc');
    assert.equal(hex(back.secret), hex(secret));
  }
  // the first change address is not a path plum derives (one address per wallet), but the same code makes it
  const change = { path: "m/84'/0'/0'/1/0", wif: 'KxuoxufJL5csa1Wieb2kp29VNdn92Us8CoaUG3aGtPtcF3AzeXvF', pub: '03025324888e429ab8e3dbaf1f7802648b9cd01e9b418485c5fa4c1b9b5700e1a6', address: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el' };
  assert.equal(validPath('btc', change.path), false);
  assert.throws(() => secretAt(seed, 'btc', change.path), /doesn't derive/);
  const key = HDKey.fromMasterSeed(seed).derive(change.path).privateKey;
  assert.equal(hex(key), hex(bip32Node(seed, change.path).key));
  assert.equal(hex(btcPublicKey(key)), change.pub);
  assert.equal(btcAddressOfPublicKey(btcPublicKey(key)), change.address);
  assert.equal(exportPrivateKey('btc', key), change.wif);
  // wallets 0..4 against bitcoinjs, from OpenSSL's public key
  for (let n = 0; n < 5; n++) {
    const path = schemePaths('bip44change', n).btc;
    assert.equal(path, `m/84'/0'/0'/0/${n}`);
    const theirs = payments.p2wpkh({ pubkey: pointOf(bip32Node(seed, path).key) }).address;
    assert.equal(addressOf('btc', secretAt(seed, 'btc', path)), theirs, `wallet ${n}`);
  }
  assert.equal(schemePaths('bip44', 0).btc, undefined, 'the older grouping has no Bitcoin wallet');
});

test("Solana wallets 0..4 still match web3.js (m/44'/501'/n'/0', the older m/44'/501'/n', the cli key)", () => {
  const seed = seedOf(ABANDON);
  for (let n = 0; n < 5; n++) {
    const now = schemePaths('bip44change', n).sol;
    assert.equal(addressOf('sol', secretAt(seed, 'sol', now)), Keypair.fromSeed(slip10Node(seed, [44, 501, n, 0])).publicKey.toBase58(), now);
    const old = schemePaths('bip44', n).sol;
    assert.equal(addressOf('sol', secretAt(seed, 'sol', old)), Keypair.fromSeed(slip10Node(seed, [44, 501, n])).publicKey.toBase58(), old);
  }
  assert.equal(addressOf('sol', secretAt(seed, 'sol', "m/44'/501'/0'/0'")), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(addressOf('sol', secretAt(seed, 'sol', schemePaths('cli', 0).sol)), Keypair.fromSeed(seed.subarray(0, 32)).publicKey.toBase58());
});

test('schemePaths: the paths of each scheme, for wallet n; an unknown scheme is refused', () => {
  assert.deepEqual(CHAINS, ['sol', 'eth', 'btc']);
  assert.deepEqual(Object.keys(SCHEMES).sort(), ['bip44', 'bip44change', 'cli']);
  assert.deepEqual(schemePaths('bip44change', 3), { sol: "m/44'/501'/3'/0'", eth: "m/44'/60'/0'/0/3", btc: "m/84'/0'/0'/0/3" });
  assert.deepEqual(schemePaths('bip44', 2), { sol: "m/44'/501'/2'", eth: "m/44'/60'/1'/0/2" });
  assert.deepEqual(schemePaths('cli', 0), { sol: null });
  assert.throws(() => schemePaths('bip84', 0), /unknown derivation/);
  assert.throws(() => schemePaths(undefined, 0), /unknown derivation/);
});

/* ------------------------------------------------------------ the paths plum will derive */

test('validPath accepts exactly the paths of the schemes, and secretAt refuses everything else', () => {
  for (const scheme of Object.keys(SCHEMES)) {
    for (const n of [0, 1, 9, 10, 123_456_789, 999_999_999]) {
      if (scheme === 'cli' && n) continue;
      for (const [chain, path] of Object.entries(schemePaths(scheme, n))) assert.equal(validPath(chain, path), true, `${chain} ${path}`);
    }
  }
  const seed = seedOf(ABANDON);
  const refused = [
    ['eth', "m/44'/60'/0'/0"], ['eth', "m/44'/60'/0'/0/0/0"], ['eth', "m/44'/60'/2'/0/0"], ['eth', "m/44'/60'/0'/1/0"],
    ['eth', "m/44'/60'/0'/0/0'"], ['eth', "m/44'/60/0'/0/0"], ['eth', "m/44'/61'/0'/0/0"], ['eth', "m/44'/60'/0'/0/1234567890"],
    ['eth', "m/44'/60'/0'/0/-1"], ['eth', 'm/44h/60h/0h/0/0'], ['eth', "M/44'/60'/0'/0/0"], ['eth', " m/44'/60'/0'/0/0"],
    ['eth', "m/44'/60'/0'/0/0\n"], ['eth', "m/44'/60'/0'/0/0/"], ['eth', "m/44'/60'/0'/0/"], ['eth', "m/44'/60'/0'/0/1e3"],
    ['eth', "m/44'/60'/0'/0/0x1"], ['eth', "m/44'/60'/0'/0/٣"], ['eth', null], ['eth', undefined], ['eth', 0], ['eth', ["m/44'/60'/0'/0/0"]],
    ['eth', { toString: () => "m/44'/60'/0'/0/0" }], ['eth', "m/44'/501'/0'/0'"],
    ['btc', "m/84'/0'/0'/1/0"], ['btc', "m/84'/1'/0'/0/0"], ['btc', "m/84'/0'/1'/0/0"], ['btc', "m/44'/0'/0'/0/0"],
    ['btc', "m/49'/0'/0'/0/0"], ['btc', "m/86'/0'/0'/0/0"], ['btc', "m/84'/0'/0'/0/0'"], ['btc', null], ['btc', "m/44'/60'/0'/0/0"],
    ['sol', "m/44'/501'/0'/0"], ['sol', "m/44'/501'/0'/1'"], ['sol', "m/44'/501'/0"], ['sol', "m/44'/501'"], ['sol', "m/44'/501'/0'/0'/0'"],
    ['sol', "m/44'/60'/0'/0'"], ['sol', ''], ['sol', undefined], ['sol', "m/44'/501'/1234567890'/0'"],
    ['doge', "m/44'/3'/0'/0/0"], [undefined, "m/44'/60'/0'/0/0"], ['ETH', "m/44'/60'/0'/0/0"],
    ['constructor', "m/44'/60'/0'/0/0"], ['__proto__', "m/44'/60'/0'/0/0"], ['toString', "m/84'/0'/0'/0/0"], ['hasOwnProperty', null],
  ];
  for (const [chain, path] of refused) {
    assert.equal(validPath(chain, path), false, `${String(chain)} ${JSON.stringify(path)}`);
    assert.throws(() => secretAt(seed, chain, path), /doesn't derive/, `${String(chain)} ${JSON.stringify(path)}`);
  }
});

/* ------------------------------------------------------------ private keys pasted in */

test('an Ethereum key is 64 hex characters, with or without 0x, any case; it round trips through export', () => {
  for (let i = 0; i < 20; i++) {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    for (const pasted of [key, key.slice(2), key.toUpperCase().replace('0X', '0x'), `  ${key}\n`, key.slice(2).toUpperCase()]) {
      const { chain, secret } = parsePrivateKey(pasted);
      assert.equal(chain, 'eth');
      assert.equal(bytesToHex(secret), key);
      assert.equal(addressOf('eth', secret), address);
    }
    assert.equal(exportPrivateKey('eth', parsePrivateKey(key).secret), key);
  }
  // the classic test key
  const k = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  assert.equal(addressOf('eth', parsePrivateKey(k).secret), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
});

test('a Bitcoin key is WIF, mainnet and compressed (K... or L...); it round trips through export', () => {
  // the Bitcoin wiki's example key, written here by the second implementation
  const wikiKey = Buffer.from('0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d', 'hex');
  assert.equal(wif(wikiKey, { compressed: false }), '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');
  assert.equal(wif(wikiKey), 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  const parsed = parsePrivateKey('KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  assert.equal(parsed.chain, 'btc');
  assert.equal(hex(parsed.secret), hex(wikiKey));
  assert.equal(addressOf('btc', parsed.secret), payments.p2wpkh({ pubkey: pointOf(wikiKey) }).address);
  const starts = new Set();
  const keys = [be32(1n), be32(N - 1n), Buffer.alloc(32, 0x01), Buffer.alloc(32, 0xee)];
  for (let i = 0; i < 30; i++) keys.push(createHash('sha256').update(`plum btc ${i}`).digest());
  for (const key of keys) {
    const w = wif(key);
    starts.add(w[0]);
    const { chain, secret } = parsePrivateKey(` ${w} `);
    assert.equal(chain, 'btc');
    assert.equal(hex(secret), hex(key));
    assert.equal(exportPrivateKey('btc', secret), w);
    assert.equal(addressOf('btc', secret), payments.p2wpkh({ pubkey: pointOf(key) }).address);
  }
  assert.deepEqual([...starts].sort(), ['K', 'L'], 'both K and L keys');
});

test('uncompressed and testnet Bitcoin keys, and broken ones, are refused with a reason', () => {
  const key = createHash('sha256').update('plum wif').digest();
  assert.throws(() => parsePrivateKey('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'), /uncompressed/);
  assert.throws(() => parsePrivateKey(wif(key, { compressed: false })), /uncompressed/);
  const testnet = wif(key, { version: 0xef });
  assert.equal(testnet[0], 'c');
  assert.throws(() => parsePrivateKey(testnet), /testnet/);
  const testnetOld = wif(key, { version: 0xef, compressed: false });
  assert.equal(testnetOld[0], '9');
  assert.throws(() => parsePrivateKey(testnetOld), /testnet/);
  // one character changed: the checksum catches it
  const good = wif(key);
  const typo = good.slice(0, 20) + (good[20] === 'a' ? 'b' : 'a') + good.slice(21);
  assert.throws(() => parsePrivateKey(typo), /checksum/);
  // the right length and checksum, but a compression flag that isn't 1
  assert.throws(() => parsePrivateKey(b58check(Buffer.concat([Buffer.from([0x80]), key, Buffer.from([2])]))), /isn't a Bitcoin private key/);
});

test('keys outside secp256k1 range are refused (0, n and above), n - 1 is the last good one', () => {
  for (const k of [0n, N, N + 1n, (1n << 256n) - 1n]) {
    assert.throws(() => parsePrivateKey(`0x${be32(k).toString('hex')}`), /outside the range/, `hex ${k}`);
    assert.throws(() => parsePrivateKey(wif(be32(k))), /outside the range/, `wif ${k}`);
  }
  for (const k of [1n, N - 1n]) {
    const { secret } = parsePrivateKey(`0x${be32(k).toString('hex')}`);
    assert.equal(addressOf('eth', secret), privateKeyToAccount(`0x${be32(k).toString('hex')}`).address);
    assert.equal(hex(parsePrivateKey(wif(be32(k))).secret), hex(be32(k)));
  }
});

test('Solana keys still parse: base58 (64 bytes as Phantom exports, or 32), a CLI keypair file; export round trips', () => {
  for (let i = 0; i < 5; i++) {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    for (const pasted of [base58Encode(kp.secretKey), JSON.stringify([...kp.secretKey]), base58Encode(kp.secretKey.subarray(0, 32))]) {
      const { chain, secret } = parsePrivateKey(pasted);
      assert.equal(chain, 'sol');
      assert.equal(addressOf('sol', secret), addr);
      assert.equal(exportPrivateKey('sol', secret), base58Encode(kp.secretKey));
    }
  }
  const kp = Keypair.generate();
  const forged = Uint8Array.from(kp.secretKey);
  forged.set(Keypair.generate().publicKey.toBytes(), 32);
  assert.throws(() => parsePrivateKey(base58Encode(forged)), /doesn't match/);
  assert.throws(() => parsePrivateKey('not a key 0OIl'), /isn't a key/);
});

/* ------------------------------------------------------------ addresses */

test("EIP-55: the spec's examples, and checksumEth agrees with viem's getAddress", () => {
  const examples = [
    '0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  for (const a of examples) {
    assert.equal(checksumEth(a.toLowerCase()), a);
    assert.equal(checksumEth(`0x${a.slice(2).toUpperCase()}`), a);
    assert.equal(checksumEth(a.slice(2).toLowerCase()), a, 'without 0x');
  }
  for (let i = 0; i < 200; i++) {
    const a = `0x${createHash('sha256').update(`plum addr ${i}`).digest('hex').slice(0, 40)}`;
    assert.equal(checksumEth(a), getAddress(a));
  }
});

test('addresses from public keys: Ethereum from compressed or full keys, Bitcoin P2WPKH', () => {
  for (let i = 0; i < 20; i++) {
    const key = createHash('sha256').update(`plum pub ${i}`).digest();
    const full = pointOf(key, false);
    const short = pointOf(key, true);
    assert.equal(hex(btcPublicKey(key)), hex(short));
    const want = publicKeyToAddress(bytesToHex(full));
    assert.equal(ethAddressOfPublicKey(full), want);
    assert.equal(ethAddressOfPublicKey(short), want);
    assert.equal(ethAddressOfPublicKey(full), getAddress(`0x${keccak256(full.subarray(1)).slice(-40)}`));
    assert.equal(btcAddressOfPublicKey(short), payments.p2wpkh({ pubkey: short }).address);
    assert.equal(btcAddressOfPublicKey(short), payments.p2wpkh({ hash: hash160(short) }).address);
    assert.equal(addressOf('btc', key), btcAddressOfPublicKey(short));
    assert.equal(addressOf('eth', key), want);
  }
});

/* ------------------------------------------------------------ signatures */

test('signEthDigest: deterministic (RFC 6979), low s, the same signature as viem, recovers to the key\'s address', async () => {
  for (let i = 0; i < 25; i++) {
    const key = createHash('sha256').update(`plum eth key ${i}`).digest();
    const digest = createHash('sha256').update(`plum eth digest ${i}`).digest();
    const sig = signEthDigest(digest, key);
    assert.ok(sig.yParity === 0 || sig.yParity === 1);
    assert.equal(sig.r.length, 32);
    assert.equal(sig.s.length, 32);
    assert.ok(big(sig.s) <= N / 2n, 'low s');
    const theirs = await viemSign({ hash: bytesToHex(digest), privateKey: bytesToHex(key) });
    assert.equal(bytesToHex(sig.r), theirs.r);
    assert.equal(bytesToHex(sig.s), theirs.s);
    assert.equal(sig.yParity, theirs.yParity);
    const again = signEthDigest(digest, key);
    assert.equal(hex(again.r) + hex(again.s), hex(sig.r) + hex(sig.s), 'deterministic');
    const signature = { r: bytesToHex(sig.r), s: bytesToHex(sig.s), yParity: sig.yParity };
    assert.equal(await recoverAddress({ hash: bytesToHex(digest), signature }), addressOf('eth', key));
  }
  const key = Buffer.alloc(32, 7);
  for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0), `0x${'11'.repeat(32)}`, [...new Uint8Array(32)]]) {
    assert.throws(() => signEthDigest(bad, key), /32-byte hash/);
  }
});

test('signBtcDigest: strict DER with low s, verified by OpenSSL (node:crypto) and by noble', () => {
  for (let i = 0; i < 25; i++) {
    const key = createHash('sha256').update(`plum btc key ${i}`).digest();
    const preimage = Buffer.from(`a transaction's sighash preimage ${i}`);
    const once = sha256(preimage);
    const digest = sha256(once);
    const der = signBtcDigest(digest, key);
    const { r, s } = parseDer(der);
    assert.ok(r > 0n && r < N);
    assert.ok(s > 0n && s <= N / 2n, 'low s');
    const full = pointOf(key, false);
    const jwk = { kty: 'EC', crv: 'secp256k1', x: full.subarray(1, 33).toString('base64url'), y: full.subarray(33).toString('base64url') };
    // OpenSSL hashes once more: a signature over sha256(sha256(x)) is a sha256 signature over sha256(x)
    assert.ok(nodeVerify('sha256', once, { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'der' }, der), 'OpenSSL verifies it');
    assert.ok(secp256k1.verify(der, digest, pointOf(key), { prehash: false, format: 'der' }), 'noble verifies it');
    assert.ok(!secp256k1.verify(der, sha256(digest), pointOf(key), { prehash: false, format: 'der' }), 'and only for its own hash');
    assert.equal(hex(signBtcDigest(digest, key)), hex(der), 'deterministic');
  }
  assert.throws(() => signBtcDigest(new Uint8Array(31), Buffer.alloc(32, 7)), /32-byte hash/);
});
