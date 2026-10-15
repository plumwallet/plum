// Ethereum, checked against viem (its own RLP, transaction serializer, signer, EIP-191 and EIP-712 code) and the specs'
// own examples: RLP, EIP-1559 transactions signed byte for byte the same, personal_sign, typed data (and what's refused),
// EIP-55 addresses, the calls plum reads, and the RPC answers it parses (fetch stubbed: no network here).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  bytesToHex, encodeFunctionData, erc20Abi, getAddress, hashMessage, hashTypedData, keccak256, maxUint256, parseAbiItem,
  parseTransaction, recoverMessageAddress, recoverTransactionAddress, serializeTransaction, toFunctionSelector, toRlp,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { utf8 } from '../src/shared/bytes.js';
import { signEthDigest } from '../src/background/keys.js';
import * as E from '../src/background/eth.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const keyOf = (label) => createHash('sha256').update(`plum eth test ${label}`).digest();
const KEY = keyOf('main');
const ACCOUNT = privateKeyToAccount(bytesToHex(KEY));
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** A small seeded generator, so a failure can be run again. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const bytesFrom = (r, n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));

/* ------------------------------------------------------------ RLP */

const toViem = (x) => (x instanceof Uint8Array ? bytesToHex(x) : x.map(toViem));

test("RLP matches viem's toRlp: empty, single bytes, short and long strings, nested lists", () => {
  const b = (...xs) => Uint8Array.from(xs);
  const fill = (n, v = 0xab) => new Uint8Array(n).fill(v);
  const cases = [
    new Uint8Array(0), b(0x00), b(0x01), b(0x7f), b(0x80), b(0xff), fill(2), fill(55), fill(56), fill(255), fill(256), fill(1024), fill(70_000),
    [], [new Uint8Array(0)], [b(0x00)], [[], [[]], [[], [[]]]], [fill(55)], [fill(30), fill(30)], [[[[[fill(60)]]]]],
    Array.from({ length: 100 }, (_, i) => b(i)), [fill(1, 0x80), fill(1, 0x7f), [fill(57), []]],
  ];
  for (const c of cases) assert.equal(bytesToHex(E.rlp(c)), toRlp(toViem(c)));
  // the classic examples
  assert.equal(bytesToHex(E.rlp(utf8('dog'))), '0x83646f67');
  assert.equal(bytesToHex(E.rlp([utf8('cat'), utf8('dog')])), '0xc88363617483646f67');
  assert.equal(bytesToHex(E.rlp([[], [[]], [[], [[]]]])), '0xc7c0c1c0c3c0c1c0');
  assert.equal(bytesToHex(E.rlp(E._test.intBytes(0))), '0x80');
  assert.equal(bytesToHex(E.rlp(E._test.intBytes(15))), '0x0f');
  assert.equal(bytesToHex(E.rlp(E._test.intBytes(1024))), '0x820400');
  // random nested structures
  const r = rng(1559);
  const gen = (depth) => (depth > 3 || r() < 0.55 ? bytesFrom(r, r() < 0.3 ? Math.floor(r() * 3) : Math.floor(r() * 90)) : Array.from({ length: Math.floor(r() * 6) }, () => gen(depth + 1)));
  for (let i = 0; i < 300; i++) {
    const c = gen(0);
    assert.equal(bytesToHex(E.rlp(c)), toRlp(toViem(c)), `case ${i}`);
  }
});

test('intBytes and word: minimal big-endian integers, 32-byte words; negatives refused', () => {
  const { intBytes, word } = E._test;
  assert.equal(bytesToHex(intBytes(0n)), '0x');
  assert.equal(bytesToHex(intBytes(1)), '0x01');
  assert.equal(bytesToHex(intBytes(255n)), '0xff');
  assert.equal(bytesToHex(intBytes(256n)), '0x0100');
  assert.equal(bytesToHex(intBytes(maxUint256)), `0x${'ff'.repeat(32)}`);
  assert.throws(() => intBytes(-1n), /negative/);
  assert.equal(bytesToHex(word(1n)), `0x${'00'.repeat(31)}01`);
  assert.throws(() => word(maxUint256 + 1n));
});

/* ------------------------------------------------------------ EIP-1559 transactions */

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DEST = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

/** plum's transaction as viem writes it. */
const viemTx = (tx) => ({
  type: 'eip1559', chainId: 1, nonce: Number(tx.nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas,
  gas: tx.gas, to: tx.to ?? null, value: tx.value, data: tx.data,
});

async function checkTx(tx, key, label) {
  const account = privateKeyToAccount(bytesToHex(key));
  const unsigned = serializeTransaction(viemTx(tx));
  assert.equal(bytesToHex(E.unsignedTx(tx)), unsigned, `${label}: unsigned bytes`);
  const digest = E.txDigest(tx);
  assert.equal(bytesToHex(digest), keccak256(unsigned), `${label}: what is signed`);
  const sig = signEthDigest(digest, key);
  const raw = E.signedTx(tx, sig);
  const theirs = await account.signTransaction(viemTx(tx));
  assert.equal(bytesToHex(raw), theirs, `${label}: signed bytes`);
  assert.equal(E.txHash(raw), keccak256(theirs), `${label}: hash`);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: bytesToHex(raw) }), account.address, `${label}: sender`);
  assert.equal(E.signerOf(digest, sig), account.address, `${label}: plum's own sender check`);
  const back = parseTransaction(bytesToHex(raw));
  assert.equal(back.type, 'eip1559');
  assert.equal(back.chainId, 1);
  assert.equal(BigInt(back.nonce ?? 0), tx.nonce);
  assert.equal(back.maxPriorityFeePerGas ?? 0n, tx.maxPriorityFeePerGas);
  assert.equal(back.maxFeePerGas ?? 0n, tx.maxFeePerGas);
  assert.equal(back.gas ?? 0n, tx.gas);
  assert.equal(back.to ? getAddress(back.to) : null, tx.to ?? null);
  assert.equal(back.value ?? 0n, tx.value);
  assert.equal(back.data ?? '0x', tx.data.toLowerCase());
  assert.deepEqual(back.accessList ?? [], []);
  assert.equal(back.yParity, sig.yParity);
}

test('EIP-1559: plum signs the same bytes as viem (transfers, tokens, contract creation, extremes) and recovers the sender', async () => {
  const base = { nonce: 0n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n, gas: 21_000n, to: DEST, value: 10n ** 18n, data: '0x' };
  const r = rng(712);
  const cases = {
    'an ETH transfer': base,
    'an ERC-20 transfer': { ...base, nonce: 7n, gas: 65_000n, to: USDC, value: 0n, data: E.transferData(DEST, 1_234_567n) },
    'zero everything': { ...base, maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, value: 0n },
    'values of one byte': { ...base, nonce: 127n, maxPriorityFeePerGas: 128n, maxFeePerGas: 255n, value: 1n, data: '0x00' },
    'the biggest values': { ...base, nonce: BigInt(Number.MAX_SAFE_INTEGER), maxPriorityFeePerGas: maxUint256, maxFeePerGas: maxUint256, gas: 30_000_000n, value: maxUint256 },
    'contract creation': { ...base, to: null, gas: 3_000_000n, value: 0n, data: '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea164736f6c6343000818000a' },
    'large data': { ...base, gas: 5_000_000n, to: USDC, data: bytesToHex(bytesFrom(r, 5000)) },
    'data at the 55-byte RLP edge': { ...base, data: bytesToHex(bytesFrom(r, 55)) },
    'data at 56 bytes': { ...base, data: bytesToHex(bytesFrom(r, 56)) },
    'a mixed-case data string': { ...base, data: '0xDEADbeef' },
  };
  for (const [label, tx] of Object.entries(cases)) await checkTx(tx, KEY, label);
  // and random ones, with random keys
  for (let i = 0; i < 40; i++) {
    const big = (bits) => { let v = 0n; for (let j = 0; j < bits; j += 8) v = (v << 8n) | BigInt(Math.floor(r() * 256)); return v; };
    const maxFee = big(Math.floor(r() * 80));
    const tx = {
      nonce: BigInt(Math.floor(r() * 2 ** 20)), maxPriorityFeePerGas: maxFee / BigInt(1 + Math.floor(r() * 5)), maxFeePerGas: maxFee,
      gas: 21_000n + big(20), to: r() < 0.1 ? null : getAddress(bytesToHex(bytesFrom(r, 20))), value: big(Math.floor(r() * 120)),
      data: bytesToHex(bytesFrom(r, Math.floor(r() * 300))),
    };
    await checkTx(tx, keyOf(`random ${i}`), `random ${i}`);
  }
});

test('a signature is low s, and signerOf tells a different key apart', () => {
  const tx = { nonce: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21_000n, to: DEST, value: 5n, data: '0x' };
  const digest = E.txDigest(tx);
  const sig = signEthDigest(digest, KEY);
  assert.ok(BigInt(bytesToHex(sig.s)) <= N / 2n);
  const other = privateKeyToAccount(bytesToHex(keyOf('other')));
  assert.notEqual(E.signerOf(digest, sig), other.address);
  assert.notEqual(E.signerOf(E.txDigest({ ...tx, value: 6n }), sig), ACCOUNT.address, 'a changed transaction has another sender');
});

/* ------------------------------------------------------------ personal_sign (EIP-191) */

test('personal_sign: the same hash and signature as viem for text (empty, unicode, long) and raw bytes', async () => {
  const texts = ['hello', '', 'héllo wörld 🍑 中文 \u0000 \n\r\t', 'x'.repeat(2000), 'Sign in to example.com\nNonce: 12345'];
  for (const m of texts) {
    const digest = E.personalDigest(utf8(m));
    assert.equal(bytesToHex(digest), hashMessage(m), JSON.stringify(m.slice(0, 20)));
    const sig = E.sigHex(signEthDigest(digest, KEY));
    assert.equal(sig, await ACCOUNT.signMessage({ message: m }));
    assert.equal(await recoverMessageAddress({ message: m, signature: sig }), ACCOUNT.address);
  }
  const raws = [new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(0xde, 0xad, 0xbe, 0xef), new Uint8Array(32).fill(0x19), bytesFrom(rng(191), 777)];
  for (const raw of raws) {
    const digest = E.personalDigest(raw);
    assert.equal(bytesToHex(digest), hashMessage({ raw }));
    assert.equal(bytesToHex(digest), hashMessage({ raw: bytesToHex(raw) }));
    const sig = E.sigHex(signEthDigest(digest, KEY));
    assert.equal(sig, await ACCOUNT.signMessage({ message: { raw } }));
    assert.ok(sig.endsWith('1b') || sig.endsWith('1c'), 'v is 27 or 28');
  }
});

/* ------------------------------------------------------------ typed data (EIP-712) */

const VERIFIER = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const MAIL = {
  types: {
    EIP712Domain: DOMAIN_TYPE,
    Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
    Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
  },
  primaryType: 'Mail',
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: VERIFIER },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

test("EIP-712: the spec's Mail example, its digest and its signature", async () => {
  const td = E.parseTypedData(JSON.stringify(MAIL));
  assert.equal(bytesToHex(E.typedDigest(td)), '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(MAIL))), '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  // the spec signs it with keccak256("cow")
  const cow = Buffer.from(keccak256(utf8('cow')).slice(2), 'hex');
  assert.equal(privateKeyToAccount(bytesToHex(cow)).address, '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826');
  const sig = signEthDigest(E.typedDigest(td), cow);
  assert.equal(27 + sig.yParity, 28);
  assert.equal(bytesToHex(sig.r), '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d');
  assert.equal(bytesToHex(sig.s), '0x07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562');
  assert.equal(E.sigHex(sig), await privateKeyToAccount(bytesToHex(cow)).signTypedData(MAIL));
});

const TYPED = {
  'the spec Mail': MAIL,
  'arrays of structs and of addresses': {
    types: {
      EIP712Domain: DOMAIN_TYPE,
      Person: [{ name: 'name', type: 'string' }, { name: 'wallets', type: 'address[]' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person[]' }, { name: 'contents', type: 'string' }],
      Group: [{ name: 'name', type: 'string' }, { name: 'members', type: 'Person[]' }],
    },
    primaryType: 'Mail',
    domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: VERIFIER },
    message: {
      from: { name: 'Cow', wallets: ['0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826', '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'] },
      to: [{ name: 'Bob', wallets: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '0xb0bdabea57b0bdabea57b0bdabea57b0bdabea57', '0xb0b0b0b0b0b0b000000000000000000000000000'] }],
      contents: 'Hello, Bob!',
    },
  },
  'every atomic type, fixed and nested arrays': {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      Item: [{ name: 'id', type: 'uint32' }, { name: 'tag', type: 'bytes4' }],
      All: [
        { name: 'b', type: 'bytes' }, { name: 'bEmpty', type: 'bytes' }, { name: 'b32', type: 'bytes32' }, { name: 'b4', type: 'bytes4' },
        { name: 'b1', type: 'bytes1' }, { name: 's', type: 'string' }, { name: 'sEmpty', type: 'string' }, { name: 'yes', type: 'bool' },
        { name: 'no', type: 'bool' }, { name: 'i8', type: 'int8' }, { name: 'i16', type: 'int16' }, { name: 'i256', type: 'int256' },
        { name: 'iMin', type: 'int256' }, { name: 'iMax', type: 'int256' }, { name: 'u8', type: 'uint8' }, { name: 'u48', type: 'uint48' },
        { name: 'u160', type: 'uint160' }, { name: 'u256', type: 'uint256' }, { name: 'a', type: 'address' }, { name: 'fixed', type: 'uint256[3]' },
        { name: 'flags', type: 'bool[2]' }, { name: 'names', type: 'string[]' }, { name: 'blobs', type: 'bytes[]' }, { name: 'hashes', type: 'bytes32[]' },
        { name: 'signed', type: 'int64[]' }, { name: 'grid', type: 'uint8[][]' }, { name: 'pairs', type: 'uint16[2][]' }, { name: 'items', type: 'Item[2]' },
        { name: 'none', type: 'address[]' }, { name: 'nested', type: 'Item[][]' },
      ],
    },
    primaryType: 'All',
    domain: { name: 'Types', chainId: 1 },
    message: {
      b: '0x0102', bEmpty: '0x', b32: `0x${'ab'.repeat(32)}`, b4: '0xdeadbeef', b1: '0x01', s: 'Hé𝄞 🍑 中文', sEmpty: '', yes: true, no: false,
      i8: -128n, i16: -1n, i256: -(2n ** 200n), iMin: -(2n ** 255n), iMax: 2n ** 255n - 1n, u8: 255n, u48: 2n ** 48n - 1n, u160: 2n ** 160n - 1n,
      u256: maxUint256, a: '0x000000000022d473030f116ddee9f6b43ac78ba3', fixed: [1n, 2n, 3n], flags: [true, false], names: ['a', '', 'ü'],
      blobs: ['0x', '0x00', `0x${'ff'.repeat(100)}`], hashes: [`0x${'11'.repeat(32)}`], signed: [-5n, 0n, 9n], grid: [[1n, 2n], [], [255n]],
      pairs: [[1n, 2n], [3n, 4n]], items: [{ id: 1n, tag: '0x01020304' }, { id: 4294967295n, tag: '0xffffffff' }], none: [],
      nested: [[{ id: 7n, tag: '0xcafebabe' }], []],
    },
  },
  'structs nested four deep': {
    types: {
      EIP712Domain: DOMAIN_TYPE,
      A: [{ name: 'b', type: 'B' }, { name: 'n', type: 'uint256' }],
      B: [{ name: 'c', type: 'C' }, { name: 'cs', type: 'C[]' }],
      C: [{ name: 'd', type: 'D' }],
      D: [{ name: 'x', type: 'string' }],
    },
    primaryType: 'A',
    domain: { name: 'Deep', version: '2', chainId: 1, verifyingContract: VERIFIER },
    message: { b: { c: { d: { x: 'one' } }, cs: [{ d: { x: 'two' } }, { d: { x: 'three' } }] }, n: 42n },
  },
  'type names sorted as EIP-712 says (capitals first)': {
    types: {
      EIP712Domain: DOMAIN_TYPE,
      Zebra: [{ name: 'a', type: 'apple' }, { name: 'b', type: 'Banana' }, { name: 'c', type: 'cherry' }],
      apple: [{ name: 'v', type: 'uint8' }],
      Banana: [{ name: 'w', type: 'string' }],
      cherry: [{ name: 'apple', type: 'apple' }, { name: 'more', type: 'Banana[]' }],
    },
    primaryType: 'Zebra',
    domain: { name: 'Sort', version: '1', chainId: 1, verifyingContract: VERIFIER },
    message: { a: { v: 1n }, b: { w: 'b' }, c: { apple: { v: 2n }, more: [{ w: 'x' }] } },
  },
  'a recursive type': {
    types: { EIP712Domain: DOMAIN_TYPE, Node: [{ name: 'value', type: 'uint256' }, { name: 'children', type: 'Node[]' }] },
    primaryType: 'Node',
    domain: { name: 'Tree', version: '1', chainId: 1, verifyingContract: VERIFIER },
    message: { value: 1n, children: [{ value: 2n, children: [] }, { value: 3n, children: [{ value: 4n, children: [] }] }] },
  },
  'an EIP-2612 permit': {
    types: {
      EIP712Domain: DOMAIN_TYPE,
      Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    },
    primaryType: 'Permit',
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
    message: { owner: ACCOUNT.address, spender: DEST, value: maxUint256, nonce: 0n, deadline: 1_893_456_000n },
  },
  'a Permit2 PermitSingle': {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    },
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
    message: { details: { token: USDC, amount: 2n ** 160n - 1n, expiration: 1_900_000_000n, nonce: 3n }, spender: DEST, sigDeadline: 1_900_000_000n },
  },
  'a domain with a salt': {
    types: { EIP712Domain: [...DOMAIN_TYPE, { name: 'salt', type: 'bytes32' }], Note: [{ name: 'text', type: 'string' }] },
    primaryType: 'Note',
    domain: { name: 'Salty', version: '1', chainId: 1, verifyingContract: VERIFIER, salt: `0x${'5a'.repeat(32)}` },
    message: { text: 'hi' },
  },
  'the domain alone (primaryType EIP712Domain)': {
    types: { EIP712Domain: DOMAIN_TYPE },
    primaryType: 'EIP712Domain',
    domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: VERIFIER },
    message: {},
  },
};
// no EIP712Domain type: it's inferred from the fields the domain has
const { EIP712Domain: _, ...mailTypes } = MAIL.types;
for (const [label, domain] of Object.entries({
  'full': MAIL.domain,
  'a name only': { name: 'Only a name' },
  'a chain only': { chainId: 1 },
  'a contract and a salt': { verifyingContract: VERIFIER, salt: `0x${'01'.repeat(32)}` },
  'empty': {},
})) TYPED[`no EIP712Domain type, a domain with ${label}`] = { ...MAIL, types: mailTypes, domain };

test('EIP-712: the same digest and signature as viem for structs, arrays, every atomic type, inferred domains', async () => {
  for (const [label, td] of Object.entries(TYPED)) {
    const want = hashTypedData(td);
    assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(json(td)))), want, `${label} (as JSON, the way a site sends it)`);
    assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(td))), want, `${label} (as an object)`);
    const sig = E.sigHex(signEthDigest(E.typedDigest(E.parseTypedData(json(td))), KEY));
    assert.equal(sig, await ACCOUNT.signTypedData(td), `${label} signature`);
  }
});

test('EIP-712: numbers as decimal strings, hex strings or safe integers all mean the same thing', () => {
  const td = TYPED['an EIP-2612 permit'];
  const want = hashTypedData(td);
  for (const deadline of ['1893456000', `0x${(1_893_456_000).toString(16)}`, 1_893_456_000, ' 1893456000 ']) {
    assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(json({ ...td, message: { ...td.message, deadline } })))), want, String(deadline));
  }
});

test('EIP-712: malformed typed data is refused, never signed some other way', () => {
  const clone = () => JSON.parse(JSON.stringify(MAIL));
  const withField = (type, value) => {
    const td = clone();
    td.types.Mail.push({ name: 'extra', type });
    td.message.extra = value;
    return td;
  };
  const deep = (levels) => {
    const types = { EIP712Domain: DOMAIN_TYPE };
    for (let i = 0; i < levels; i++) types[`T${i}`] = [{ name: 'next', type: `T${i + 1}` }];
    types[`T${levels}`] = [{ name: 'x', type: 'uint8' }];
    let message = { x: 1 };
    for (let i = levels - 1; i >= 0; i--) message = { next: message };
    return { types, primaryType: 'T0', domain: MAIL.domain, message };
  };
  const refused = {
    'not JSON': '{"types":',
    'a JSON list': '[1,2,3]',
    'no types': { primaryType: 'Mail', domain: MAIL.domain, message: MAIL.message },
    'no message': { ...clone(), message: undefined },
    'a primaryType it does not define': { ...clone(), primaryType: 'Letter' },
    'a type name with a space': (() => { const td = clone(); td.types['Mail Box'] = []; return td; })(),
    'fields that are not a list': (() => { const td = clone(); td.types.Person = { name: 'string' }; return td; })(),
    'a field with no type': (() => { const td = clone(); td.types.Person.push({ name: 'age' }); return td; })(),
    'a missing field': (() => { const td = clone(); delete td.message.contents; return td; })(),
    'a missing nested field': (() => { const td = clone(); delete td.message.from.wallet; return td; })(),
    'a missing struct': (() => { const td = clone(); td.message.to = null; return td; })(),
    'a domain without a field its type names': (() => { const td = clone(); delete td.domain.version; return td; })(),
    'a fixed list of the wrong length': withField('uint256[2]', [1, 2, 3]),
    'a fixed list that is short': withField('Person[2]', [MAIL.message.from]),
    'a list that is not a list': withField('uint256[]', '1,2'),
    'a list that is too long': withField('uint8[]', Array(1001).fill(1)),
    'too deep': deep(20),
    'too large': `{"pad":"${'x'.repeat(64 * 1024)}"}`,
  };
  for (const t of ['uint7', 'uint0', 'uint264', 'int9', 'bytes33', 'bytes0', 'Foo', 'function', 'fixed128x18', 'string[', 'uint256 ', 'address payable', 'tuple', 'Person]']) {
    refused[`an unknown type ${t}`] = withField(t, 1);
  }
  const outOfRange = [
    ['uint8', 256], ['uint8', -1], ['int8', 128], ['int8', -129], ['uint256', `${2n ** 256n}`], ['uint256', '-1'], ['uint48', `${2n ** 48n}`],
    ['int256', `${2n ** 255n}`], ['int256', `${-(2n ** 255n) - 1n}`], ['uint160', `0x1${'0'.repeat(40)}`],
  ];
  for (const [t, v] of outOfRange) refused[`${t} ${v} out of range`] = withField(t, v);
  const notNumbers = ['abc', 1.5, 1e21, null, true, '', '0x', '1e3', [], {}];
  for (const v of notNumbers) refused[`uint256 given ${JSON.stringify(v)}`] = withField('uint256', v);
  for (const v of ['0x1234', 'cd2a3d9f938e13cd947ec05abc7fe734df8dd826', 123, `0x${'g'.repeat(40)}`, null]) refused[`address ${JSON.stringify(v)}`] = withField('address', v);
  for (const [t, v] of [['bytes32', `0x${'00'.repeat(31)}`], ['bytes32', `0x${'00'.repeat(33)}`], ['bytes4', '0x0102030405'], ['bytes1', '0x'], ['bytes', '0x123'], ['bytes', 'hello'], ['bytes32', 'hello']]) {
    refused[`${t} ${v}`] = withField(t, v);
  }
  for (const v of ['yes', 2, null, 'TRUE']) refused[`bool ${JSON.stringify(v)}`] = withField('bool', v);
  // values that would be signed as something other than what's shown: bytes that aren't hex or byte values (a number
  // used to sign as no bytes at all, [256] as 0x00), text that is a list or an object ({} signed "[object Object]")
  for (const v of [5, true, {}, { 0: 1, length: 1 }, [256], [-1], [1.5], ['0x01'], null]) refused[`bytes given ${JSON.stringify(v)}`] = withField('bytes', v);
  for (const v of [{}, ['a', 'b'], { text: 'hi' }]) refused[`string given ${JSON.stringify(v)}`] = withField('string', v);
  for (const [label, input] of Object.entries(refused)) {
    assert.throws(() => E.typedDigest(E.parseTypedData(typeof input === 'string' ? input : json(input))), (e) => e instanceof Error && !/is not a function|Cannot read/.test(e.message), label);
  }
  // nesting up to the limit still works
  assert.doesNotThrow(() => E.typedDigest(E.parseTypedData(json(deep(12)))));
  assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(json(deep(12))))), hashTypedData(deep(12)));
  // bytes as a list of byte values (or a Uint8Array) are the same bytes as their hex
  const asHex = hashTypedData(withField('bytes', '0x0001ff'));
  assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(json(withField('bytes', [0, 1, 255]))))), asHex);
  assert.equal(bytesToHex(E.typedDigest(E.parseTypedData(withField('bytes', Uint8Array.of(0, 1, 255))))), asHex);
});

test('typed data warnings name permits, Permit2 and other chains', () => {
  const permit = E.typedWarnings(E.parseTypedData(json(TYPED['an EIP-2612 permit'])), { owner: ACCOUNT.address });
  assert.ok(permit.some((w) => w.level === 'danger' && /permit/.test(w.text) && /all of your/.test(w.text)));
  const permit2 = E.typedWarnings(E.parseTypedData(json(TYPED['a Permit2 PermitSingle'])), { owner: ACCOUNT.address });
  assert.ok(permit2.some((w) => w.level === 'danger' && /Permit2/.test(w.text)));
  const other = E.typedWarnings(E.parseTypedData(json({ ...MAIL, domain: { ...MAIL.domain, chainId: 137 } })), { owner: ACCOUNT.address });
  assert.ok(other.some((w) => w.level === 'danger' && /137/.test(w.text)));
  assert.deepEqual(E.typedWarnings(E.parseTypedData(json(MAIL)), { owner: ACCOUNT.address }), []);
  const { lines, more } = E.typedLines(E.parseTypedData(json(TYPED['arrays of structs and of addresses'])));
  assert.deepEqual(lines.map((l) => l.path), ['from.name', 'from.wallets[0]', 'from.wallets[1]', 'to[0].name', 'to[0].wallets[0]', 'to[0].wallets[1]', 'to[0].wallets[2]', 'contents']);
  assert.equal(more, 0);
  // past what plum shows, the rest is counted (and main.js makes that a danger)
  const cut = E.typedLines(E.parseTypedData(json(TYPED['arrays of structs and of addresses'])), 3);
  assert.deepEqual([cut.lines.length, cut.more], [3, 5]);
  // a type named after something every object inherits is just unknown
  assert.throws(() => E.parseTypedData(json({ ...MAIL, primaryType: 'toString' })), /no type toString/);
});

/* ------------------------------------------------------------ addresses */

test('checkAddress: lowercase, uppercase and checksummed addresses pass (checksummed); a wrong capital is refused', () => {
  const sum = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  assert.equal(E.checkAddress(sum), sum);
  assert.equal(E.checkAddress(sum.toLowerCase()), sum);
  assert.equal(E.checkAddress(`0x${sum.slice(2).toUpperCase()}`), sum);
  assert.equal(E.checkAddress(`  ${sum}\n`), sum);
  assert.throws(() => E.checkAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), /typo/);
  for (const bad of ['', '0x', sum.slice(0, -1), `${sum}0`, sum.slice(2), `0X${sum.slice(2)}`, `0x${'g'.repeat(40)}`, null, undefined, 123, {}]) {
    assert.throws(() => E.checkAddress(bad), /isn't an Ethereum address/, JSON.stringify(bad));
  }
  const r = rng(55);
  for (let i = 0; i < 200; i++) {
    const a = getAddress(bytesToHex(bytesFrom(r, 20)));
    assert.equal(E.checkAddress(a), a);
    assert.equal(E.checkAddress(a.toLowerCase()), a);
    // flip the case of one letter: a typo, unless that leaves no mixed case at all
    const at = [...a].findIndex((c, j) => j > 1 && /[a-fA-F]/.test(c));
    if (at < 0) continue;
    const c = a[at];
    const flipped = a.slice(0, at) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + a.slice(at + 1);
    const body = flipped.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) continue;
    assert.throws(() => E.checkAddress(flipped), /typo/, flipped);
    assert.equal(E.isEthAddress(flipped), false);
  }
  assert.ok(E.sameAddress(sum, sum.toLowerCase()));
  assert.ok(!E.sameAddress(sum, DEST));
});

/* ------------------------------------------------------------ calls plum reads */

test("decodeCall reads the calls viem's encodeFunctionData writes", () => {
  const SPENDER = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const calls = [
    ['function transfer(address to, uint256 amount)', 'transfer', [DEST, 1_000_000n]],
    ['function approve(address spender, uint256 amount)', 'approve', [SPENDER, maxUint256]],
    ['function transferFrom(address from, address to, uint256 amount)', 'transferFrom', [ACCOUNT.address, DEST, 5n]],
    ['function increaseAllowance(address spender, uint256 added)', 'increaseAllowance', [SPENDER, 77n]],
    ['function setApprovalForAll(address operator, bool approved)', 'setApprovalForAll', [SPENDER, true]],
    ['function setApprovalForAll(address operator, bool approved)', 'setApprovalForAll', [SPENDER, false]],
    ['function safeTransferFrom(address from, address to, uint256 id)', 'safeTransferFrom', [ACCOUNT.address, DEST, 42n]],
    ['function approve(address token, address spender, uint160 amount, uint48 expiration)', 'approve (Permit2)', [USDC, SPENDER, 2n ** 160n - 1n, 281474976710655n]],
    ['function deposit()', 'deposit', []],
    ['function withdraw(uint256 wad)', 'withdraw', [10n ** 18n]],
  ];
  for (const [sig, name, args] of calls) {
    const item = parseAbiItem(sig);
    const data = encodeFunctionData({ abi: [item], functionName: item.name, args });
    const got = E.decodeCall(data);
    assert.equal(`0x${got.selector}`, toFunctionSelector(item), sig);
    assert.equal(got.name, name, sig);
    assert.deepEqual(got.args, args.map((a) => (typeof a === 'string' ? getAddress(a) : a)), sig);
    assert.deepEqual(E.decodeCall(data.toUpperCase().replace('0X', '0x')), got, 'any case');
  }
  assert.deepEqual(E.decodeCall('0x12345678'), { selector: '12345678' });
  assert.deepEqual(E.decodeCall(`0xa9059cbb${'00'.repeat(32)}`), { selector: 'a9059cbb', name: 'transfer' }, 'arguments cut short');
  assert.equal(E.decodeCall('0x1234'), null);
  assert.equal(E.decodeCall('0x'), null);
  assert.equal(E.decodeCall(undefined), null);
});

test("transferData is viem's ERC-20 transfer; amounts outside uint256 are refused", () => {
  for (const amount of [0n, 1n, 10n ** 18n, maxUint256]) {
    assert.equal(E.transferData(DEST, amount), encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEST, amount] }));
  }
  assert.throws(() => E.transferData(DEST, -1n));
  assert.throws(() => E.transferData(DEST, maxUint256 + 1n));
});

test('hex and units helpers', () => {
  assert.deepEqual([...E.fromHex('0x')], []);
  assert.deepEqual([...E.fromHex('0xABcd')], [0xab, 0xcd]);
  assert.deepEqual([...E.fromHex('0Xff')], [0xff]);
  assert.deepEqual([...E.fromHex('00ff')], [0x00, 0xff]);
  for (const bad of ['0x1', '0xzz', '0x 1', 12, null]) assert.throws(() => E.fromHex(bad), /expected hex/);
  assert.equal(E.toHex(Uint8Array.of(0, 1, 255)), '0x0001ff');
  assert.equal(E.qty(0), '0x0');
  assert.equal(E.qty(255n), '0xff');
  assert.equal(E.units(1_234_500n, 6), '1.2345');
  assert.equal(E.units(0n, 18), '0');
  assert.equal(E.units(10n ** 18n, 18), '1');
  assert.equal(E.units(1n, 18), '0.000000000000000001');
  assert.equal(E.units(123n, 0), '123');
});

/* ------------------------------------------------------------ RPC answers (fetch stubbed) */

/** Run `fn` with fetch answering from `handler(url, body)`: { status, body } or an Error to throw. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = init.body;
    try { body = JSON.parse(init.body); } catch { /* raw text */ }
    calls.push({ url: String(url), body });
    const out = await handler(String(url), body);
    if (out instanceof Error) throw out;
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), { status: out.status ?? 200 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const rpcResult = (result) => ({ body: { jsonrpc: '2.0', id: 1, result } });
const rpcError = (message, code = -32000) => ({ body: { jsonrpc: '2.0', id: 1, error: { code, message } } });
const RPCS = ['https://rpc-a.test', 'https://rpc-b.test'];

test('feeQuote: the median recent tip, kept between 0.01 and 3 gwei; the cap is twice the base fee plus the tip', async () => {
  const gwei = 1_000_000_000n;
  const quote = (rewards, history = true) => withFetch((url, b) => {
    if (b.method === 'eth_getBlockByNumber') return rpcResult({ baseFeePerGas: E.qty(gwei) });
    if (b.method === 'eth_feeHistory') return history ? rpcResult({ reward: rewards.map((x) => [E.qty(x)]) }) : { status: 500, body: 'down' };
    return { status: 404, body: '' };
  }, () => E.feeQuote(RPCS));
  assert.deepEqual(await quote([2n * gwei, gwei, 3n * gwei, gwei / 2n, 4n * gwei]), { base: gwei, tip: 2n * gwei, maxFee: 4n * gwei });
  assert.deepEqual(await quote([50n * gwei, 60n * gwei]), { base: gwei, tip: 3n * gwei, maxFee: 5n * gwei });
  assert.deepEqual(await quote([1n, 2n, 3n]), { base: gwei, tip: 10_000_000n, maxFee: 2n * gwei + 10_000_000n });
  assert.deepEqual(await quote([], false), { base: gwei, tip: gwei, maxFee: 3n * gwei });
});

test('simulate: what a call does to the owner, read from eth_simulateV1 transfer logs', async () => {
  const owner = ACCOUNT.address;
  const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const word = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const APPROVAL_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const NFT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
  const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
  const logs = [
    { address: NATIVE, topics: [TRANSFER, pad(owner), pad(DEST)], data: word(10n ** 17n) },
    { address: USDC.toLowerCase(), topics: [TRANSFER, pad(DEST), pad(owner)], data: word(5_000_000n) },
    { address: USDC.toLowerCase(), topics: [APPROVAL, pad(owner), pad(DEST)], data: word(maxUint256) },
    { address: NFT, topics: [APPROVAL_ALL, pad(owner), pad(DEST)], data: word(1n) },
    { address: NFT, topics: [TRANSFER, pad(owner), pad(DEST), word(42n)], data: '0x' },
    { address: DAI, topics: [TRANSFER, pad(owner), pad(owner)], data: word(7n) },
  ];
  const sim = await withFetch((url, b) => {
    assert.equal(b.method, 'eth_simulateV1');
    assert.equal(b.params[0].blockStateCalls[0].calls[0].from, owner);
    return rpcResult([{ calls: [{ status: '0x1', gasUsed: '0x5208', logs }] }]);
  }, () => E.simulate(RPCS, owner, { to: DEST, value: 10n ** 17n, data: '0x' }));
  assert.equal(sim.ok, true);
  assert.equal(sim.gasUsed, 21_000n);
  assert.deepEqual(sim.changes, [{ token: null, delta: -(10n ** 17n) }, { token: USDC, delta: 5_000_000n }]);
  assert.deepEqual(sim.approvals, [
    { token: USDC.toLowerCase(), spender: DEST, amount: maxUint256, unlimited: true },
    { token: NFT, spender: DEST, all: true },
    { token: NFT, nft: '42', out: true },
  ]);
  const reverted = await withFetch(() => rpcResult([{ calls: [{ status: '0x0', error: { message: 'execution reverted: nope' }, logs: [] }] }]), () => E.simulate(RPCS, owner, { to: DEST, value: 0n, data: '0x' }));
  assert.equal(reverted.ok, false);
  assert.equal(reverted.error, 'execution reverted: nope');
  const unsupported = await withFetch(() => rpcError('the method eth_simulateV1 does not exist/is not available', -32601), () => E.simulate(RPCS, owner, { to: DEST, data: '0x' }));
  assert.equal(unsupported, null);
  const down = await withFetch(() => ({ status: 503, body: 'down' }), () => E.simulate(RPCS, owner, { to: DEST, data: '0x' }));
  assert.equal(down, null);
  // the chain refusing the call outright is an answer too: it would fail
  const poor = await withFetch(() => rpcError('insufficient funds for gas * price + value: have 0 want 1000', -32000), () => E.simulate(RPCS, owner, { to: DEST, value: 1000n, data: '0x' }));
  assert.deepEqual([poor.ok, poor.error, poor.changes], [false, 'insufficient funds for gas * price + value: have 0 want 1000', []]);
});

test('sendRaw: the hash is checked; a provider that is down moves on; a refusal from the chain is final', async () => {
  const tx = { nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21_000n, to: DEST, value: 1n, data: '0x' };
  const raw = E.signedTx(tx, signEthDigest(E.txDigest(tx), KEY));
  const hash = E.txHash(raw);
  const ok = await withFetch((url, b) => {
    assert.equal(b.method, 'eth_sendRawTransaction');
    assert.equal(b.params[0], bytesToHex(raw));
    return rpcResult(hash);
  }, async (calls) => ({ got: await E.sendRaw(raw, RPCS), calls: calls.length }));
  assert.deepEqual(ok, { got: hash, calls: 1 });
  await withFetch(() => rpcResult(`0x${'12'.repeat(32)}`), () => assert.rejects(E.sendRaw(raw, RPCS), /different transaction hash/));
  const failover = await withFetch((url) => (url === RPCS[0] ? { status: 502, body: 'bad gateway' } : rpcResult(hash)), async (calls) => ({ got: await E.sendRaw(raw, RPCS), urls: calls.map((c) => c.url) }));
  assert.deepEqual(failover, { got: hash, urls: RPCS });
  assert.equal(await withFetch(() => rpcError('already known'), () => E.sendRaw(raw, RPCS)), hash);
  await withFetch(() => rpcError('nonce too low'), async (calls) => {
    await assert.rejects(E.sendRaw(raw, RPCS), /nonce too low/);
    assert.equal(calls.length, 1, 'not tried again elsewhere');
  });
});

test('balances and activity: tokens filtered (scams, non-ERC-20, zero, bad decimals) and history merged', async () => {
  const token = (address, extra = {}) => ({ address_hash: address, type: 'ERC-20', decimals: '6', symbol: 'TKN', name: 'Token', exchange_rate: '1.5', ...extra });
  const list = [
    { token: token(USDC.toLowerCase()), value: '2500000' },
    { token: token('0x1111111111111111111111111111111111111111', { reputation: 'scam' }), value: '1' },
    { token: token('0x2222222222222222222222222222222222222222', { type: 'ERC-721' }), value: '1' },
    { token: token('0x3333333333333333333333333333333333333333'), value: '0' },
    { token: token('0x4444444444444444444444444444444444444444', { decimals: '99' }), value: '5' },
    { token: token('0x5555555555555555555555555555555555555555', { exchange_rate: null, symbol: 'U‮SDC' }), value: '7' },
    { token: token('not an address'), value: '5' },
  ];
  const got = await withFetch((url, b) => (b?.method === 'eth_getBalance' ? rpcResult('0xde0b6b3a7640000') : { body: list }), () => E.balances(RPCS, ACCOUNT.address));
  assert.equal(got.wei, 10n ** 18n);
  assert.deepEqual(got.tokens.map((t) => [t.mint, t.amount, t.verified, t.symbol]), [[USDC, '2500000', true, 'TKN'], ['0x5555555555555555555555555555555555555555', '7', false, 'USDC']]);
  assert.equal(got.tokens[0].usd, 3.75);
  const h = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
  const items = await withFetch((url) => {
    if (url.includes('token-transfers')) return { body: { items: [{ transaction_hash: h(1), timestamp: '2026-01-01T00:00:00Z' }, { transaction_hash: h(3), timestamp: '2026-03-01T00:00:00Z' }] } };
    return { body: { items: [{ hash: h(1), timestamp: '2026-01-01T00:00:00Z', status: 'ok', block_number: 1 }, { hash: h(2), timestamp: '2026-02-01T00:00:00Z', status: 'error', block_number: 2 }] } };
  }, () => E.activity(ACCOUNT.address));
  assert.deepEqual(items.map((x) => [x.id, x.ok]), [[h(3), true], [h(2), false], [h(1), true]]);
  assert.equal(items[0].explorer, `https://etherscan.io/tx/${h(3)}`);
});
