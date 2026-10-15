// v1 transactions (SIMD-0385): real ones from mainnet read exactly as the RPC and @solana/web3.js 1.99 read them (a
// test-only oracle that reads v1 but can't write it), the fee mainnet charged for each, and plum's own v1 writer read
// back by web3.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { base58Decode, base58Encode } from '../src/shared/base58.js';
import {
  COMPUTE_BUDGET_PROGRAM, MAX_TX_BYTES, MAX_V1_TX_BYTES, compileLegacy, compileV1, computeBudgetOf, feeOf, isStaticWritable,
  isTransactionShaped, ix, maxTxBytes, readMessage, readTx, signersOf, startsLikeTransaction, unsignedTx, withSignature,
} from '../src/shared/tx.js';

const MAINNET = JSON.parse(readFileSync(new URL('./fixtures/v1-mainnet.json', import.meta.url), 'utf8'));
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(5));
const key = () => Keypair.generate().publicKey.toBase58();
const bytesOf = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));

test('real v1 transactions from mainnet are read exactly as the RPC read them', () => {
  assert.ok(MAINNET.length >= 10);
  for (const f of MAINNET) {
    const t = readTx(bytesOf(f.transaction));
    const r = f.rpc;
    assert.equal(t.version, 1);
    assert.deepEqual([t.required, t.readonlySigned, t.readonlyUnsigned], [r.header.numRequiredSignatures, r.header.numReadonlySignedAccounts, r.header.numReadonlyUnsignedAccounts]);
    assert.deepEqual(t.keys, r.accountKeys);
    assert.equal(t.blockhash, r.recentBlockhash);
    assert.deepEqual(t.instructions.map((i) => [i.programIndex, i.accounts, base58Encode(i.data)]), r.instructions.map((i) => [i.programIdIndex, i.accounts, i.data]));
    const c = r.transactionConfig;
    assert.deepEqual(
      [t.config.priorityFee == null ? null : Number(t.config.priorityFee), t.config.computeUnitLimit, t.config.loadedAccountsDataSizeLimit, t.config.heapSize],
      [c.priorityFee ?? null, c.computeUnitLimit ?? null, c.loadedAccountsDataSizeLimit ?? null, c.heapSize ?? null],
    );
    assert.deepEqual(t.lookups, []);
    // the fee mainnet took: 5000 a signature plus the priority fee in its header, to the lamport
    assert.equal(feeOf(t), BigInt(f.fee), f.signature);
    // the signature at the tail covers exactly the bytes plum reads as the message
    assert.ok(ed25519.verify(t.signatures[0], t.message, base58Decode(t.keys[0])), f.signature);
    assert.equal(base58Encode(t.signatures[0]), f.signature);
    assert.equal(t.message.length + 64 * t.required, t.size);
  }
});

test('real v1 transactions are read the same by web3.js 1.99', () => {
  for (const f of MAINNET) {
    const bytes = bytesOf(f.transaction);
    const t = readTx(bytes);
    const w = VersionedTransaction.deserialize(bytes);
    assert.equal(w.message.version, 1);
    assert.deepEqual(w.message.staticAccountKeys.map(String), t.keys);
    assert.equal(w.message.recentBlockhash, t.blockhash);
    assert.deepEqual(w.message.compiledInstructions.map((i) => [i.programIdIndex, [...i.accountKeyIndexes], Buffer.from(i.data).toString('hex')]), t.instructions.map((i) => [i.programIndex, i.accounts, Buffer.from(i.data).toString('hex')]));
    t.keys.forEach((_, i) => assert.equal(isStaticWritable(t, i), w.message.isAccountWritable(i), `${f.signature} account ${i}`));
    assert.deepEqual(w.signatures.map((s) => Buffer.from(s).toString('hex')), t.signatures.map((s) => Buffer.from(s).toString('hex')));
    // plum reads every one of them as a transaction, and the message alone as one too (signMessage refuses both)
    assert.ok(isTransactionShaped(bytes) && isTransactionShaped(t.message) && startsLikeTransaction(t.message));
  }
});

test("plum's v1 writer: web3.js reads back the same header, accounts, config and instructions", () => {
  const payer = key(), to = key(), other = key();
  const instructions = [ix.transfer(payer, to, 123_456_789n), ix.transfer(payer, other, 1n), { programId: key(), keys: [{ pubkey: other, isSigner: false, isWritable: false }], data: new Uint8Array(300).fill(7) }];
  const configs = [
    {},
    { priorityFee: 50_000n, computeUnitLimit: 1_400_000 },
    { priorityFee: 1n, computeUnitLimit: 900, loadedAccountsDataSizeLimit: 64 * 1024, heapSize: 256 * 1024 },
    { computeUnitLimit: 0 },
  ];
  for (const config of configs) {
    const message = compileV1({ payer, blockhash: BLOCKHASH, instructions, config });
    const m = readMessage(message);
    const w = VersionedMessage.deserialize(message);
    assert.equal(w.version, 1);
    assert.equal(m.version, 1);
    assert.deepEqual(w.staticAccountKeys.map(String), m.keys);
    assert.equal(m.keys[0], payer);
    assert.deepEqual(w.header, { numRequiredSignatures: m.required, numReadonlySignedAccounts: m.readonlySigned, numReadonlyUnsignedAccounts: m.readonlyUnsigned });
    assert.equal(w.transactionConfig.priorityFee == null ? null : BigInt(w.transactionConfig.priorityFee), config.priorityFee ?? null);
    assert.equal(w.transactionConfig.computeUnitLimit, config.computeUnitLimit ?? null);
    assert.equal(w.transactionConfig.loadedAccountsDataSizeLimit, config.loadedAccountsDataSizeLimit ?? null);
    assert.equal(w.transactionConfig.heapSize, config.heapSize ?? null);
    assert.deepEqual(w.compiledInstructions.map((i) => [w.staticAccountKeys[i.programIdIndex].toBase58(), i.accountKeyIndexes.map((k) => w.staticAccountKeys[k].toBase58()), Buffer.from(i.data).toString('hex')]),
      instructions.map((i) => [i.programId, i.keys.map((k) => k.pubkey), Buffer.from(i.data).toString('hex')]));
    // the same accounts in the same order as the legacy writer
    assert.deepEqual(m.keys, readMessage(compileLegacy({ payer, blockhash: BLOCKHASH, instructions })).keys);
    assert.equal(computeBudgetOf(m).priorityLamports, config.priorityFee ?? 0n);
    assert.equal(computeBudgetOf(m).units, config.computeUnitLimit ?? 0);
  }
});

test('a v1 transaction is signed at its tail, and the signature verifies', () => {
  const payer = Keypair.generate();
  const message = compileV1({ payer: payer.publicKey.toBase58(), blockhash: BLOCKHASH, instructions: [ix.transfer(payer.publicKey.toBase58(), key(), 5n)], config: { computeUnitLimit: 300, priorityFee: 0n } });
  const unsigned = unsignedTx(message);
  assert.equal(unsigned.length, message.length + 64, 'one empty slot, after the message');
  assert.deepEqual(unsigned.subarray(0, message.length), message);
  const t = readTx(unsigned);
  assert.deepEqual(signersOf(t), [payer.publicKey.toBase58()]);
  assert.equal(t.sigStart, message.length);
  const sig = ed25519.sign(t.message, payer.secretKey.subarray(0, 32));
  const signed = withSignature(unsigned, payer.publicKey.toBase58(), sig);
  assert.deepEqual(signed.subarray(signed.length - 64), sig);
  assert.deepEqual(signed.subarray(0, message.length), message, 'the message is untouched');
  const w = VersionedTransaction.deserialize(signed);
  assert.equal(w.message.version, 1);
  assert.ok(ed25519.verify(w.signatures[0], message, payer.publicKey.toBytes()));
  assert.throws(() => withSignature(unsigned, key(), sig), /doesn't ask for your signature/);
});

test('in a v1 transaction compute-budget instructions are ignored: its fee is what its header says', () => {
  const payer = key();
  const cheapLooking = [ix.unitLimit(200), ix.unitPrice(1n), ix.transfer(payer, key(), 1n)];
  const t = readMessage(compileV1({ payer, blockhash: BLOCKHASH, instructions: cheapLooking, config: { priorityFee: 2_000_000_000n, computeUnitLimit: 1000 } }));
  assert.equal(feeOf(t), 2_000_005_000n);
  assert.equal(computeBudgetOf(t).units, 1000);
  assert.equal(t.instructions.filter((i) => t.keys[i.programIndex] === COMPUTE_BUDGET_PROGRAM).length, 2);
  // with no config at all the limits are zero: no compute, no priority fee
  const bare = readMessage(compileV1({ payer, blockhash: BLOCKHASH, instructions: [ix.transfer(payer, key(), 1n)] }));
  assert.deepEqual(computeBudgetOf(bare), { units: 0, microLamports: null, priorityLamports: 0n });
  assert.equal(feeOf(bare), 5000n);
});

test('sizes: legacy and v0 stop at 1232 bytes, v1 at 4096', () => {
  assert.equal(maxTxBytes(Uint8Array.of(1, 0)), MAX_TX_BYTES);
  assert.equal(maxTxBytes(Uint8Array.of(0x81)), MAX_V1_TX_BYTES);
  const payer = key();
  // a v1 transaction past 1232 bytes is fine; past 4096 it is refused
  const big = (n) => unsignedTx(compileV1({ payer, blockhash: BLOCKHASH, instructions: [{ programId: key(), keys: [], data: new Uint8Array(n) }], config: { computeUnitLimit: 1 } }));
  const ok = big(3000);
  assert.ok(ok.length > MAX_TX_BYTES && readTx(ok).size === ok.length);
  const fits = big(3000 + MAX_V1_TX_BYTES - ok.length);
  assert.equal(fits.length, MAX_V1_TX_BYTES);
  assert.equal(readTx(fits).size, MAX_V1_TX_BYTES);
  assert.throws(() => readTx(big(3001 + MAX_V1_TX_BYTES - ok.length)), /more than the 4096/);
});
