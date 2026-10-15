// The transaction reader and writer, checked against @solana/web3.js (a test-only oracle: plum itself never loads it).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ComputeBudgetProgram, Keypair, SystemInstruction, MessageV0, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '../src/shared/base58.js';
import { utf8 } from '../src/shared/bytes.js';
import { associatedTokenAddress } from '../src/shared/pda.js';
import {
  compileLegacy, feeOf, isStaticWritable, isTransactionShaped, ix, readMessage, readTx, signersOf, unsignedTx, withSignature,
} from '../src/shared/tx.js';

const BLOCKHASH = base58Encode(new Uint8Array(32).fill(9));

function legacyFromWeb3(payer, ixs, extraSigners = []) {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(...ixs);
  return { tx, bytes: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), extraSigners };
}

test('reads a legacy transaction exactly as web3.js wrote it', () => {
  const payer = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const { tx, bytes } = legacyFromWeb3(payer, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 12345 })]);
  const t = readTx(bytes);
  assert.equal(t.version, 'legacy');
  assert.equal(t.required, 1);
  assert.equal(t.signatures.length, 1);
  assert.deepEqual(signersOf(t), [payer.publicKey.toBase58()]);
  assert.deepEqual(Buffer.from(t.message), tx.serializeMessage());
  assert.equal(t.blockhash, BLOCKHASH);
  assert.equal(t.instructions.length, 1);
  assert.ok(isStaticWritable(t, 0) && isStaticWritable(t, 1) && !isStaticWritable(t, 2));
});

test('reads a v0 transaction with a lookup table', () => {
  const payer = Keypair.generate();
  const table = Keypair.generate().publicKey;
  const inTable = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const lookup = { key: table, state: { addresses: inTable, authority: undefined, deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 }, isActive: () => true };
  const message = MessageV0.compile({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: inTable[0], isSigner: false, isWritable: true }, { pubkey: inTable[1], isSigner: false, isWritable: false }], data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) })],
    addressLookupTableAccounts: [lookup],
  });
  const vtx = new VersionedTransaction(message);
  const t = readTx(vtx.serialize());
  assert.equal(t.version, 0);
  assert.equal(t.lookups.length, 1);
  assert.equal(t.lookups[0].table, table.toBase58());
  assert.deepEqual(t.lookups[0].writable, [0]);
  assert.deepEqual(t.lookups[0].readonly, [1]);
  assert.deepEqual(Buffer.from(t.message), Buffer.from(message.serialize()));
});

test('refuses what it cannot read: a legacy one dressed as v1, truncated, extra bytes, impossible headers', () => {
  const payer = Keypair.generate();
  const { bytes } = legacyFromWeb3(payer, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })]);
  assert.throws(() => readTx(Uint8Array.of(0x81, ...bytes.subarray(1))), /no fee payer|left over|ends too early|impossible/);
  assert.throws(() => readTx(Uint8Array.of(0x82, ...bytes.subarray(1))));
  assert.throws(() => readTx(bytes.subarray(0, bytes.length - 3)), /ends too early/);
  assert.throws(() => readTx(Uint8Array.from([...bytes, 0])), /left over/);
  const bad = Uint8Array.from(bytes);
  bad[65] = 9; // numRequiredSignatures far beyond the slots
  assert.throws(() => readTx(bad));
});

test("signs into the right slot, and web3.js accepts the signature", () => {
  const payer = Keypair.generate();
  const other = Keypair.generate();
  const { bytes } = legacyFromWeb3(payer, [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 5 }),
    new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) }),
  ]);
  const t = readTx(bytes);
  assert.equal(t.required, 2);
  const signed = withSignature(bytes, other.publicKey.toBase58(), ed25519.sign(t.message, other.secretKey.subarray(0, 32)));
  const back = Transaction.from(signed);
  const otherSig = back.signatures.find((s) => s.publicKey.equals(other.publicKey));
  assert.ok(otherSig.signature && ed25519.verify(otherSig.signature, back.serializeMessage(), other.publicKey.toBytes()));
  assert.ok(back.signatures.find((s) => s.publicKey.equals(payer.publicKey)).signature === null, "the payer's slot stays empty");
  assert.throws(() => withSignature(bytes, Keypair.generate().publicKey.toBase58(), new Uint8Array(64)), /doesn't ask for your signature/);
});

test('a "message" that is really a transaction is recognised (signMessage must refuse it)', () => {
  const payer = Keypair.generate();
  const { tx, bytes } = legacyFromWeb3(payer, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })]);
  assert.ok(isTransactionShaped(bytes));
  assert.ok(isTransactionShaped(tx.serializeMessage()));
  assert.ok(!isTransactionShaped(utf8('Sign in to plum.fun\nNonce: 1234')));
  assert.ok(!isTransactionShaped(utf8('hello')));
  assert.ok(!isTransactionShaped(crypto.getRandomValues(new Uint8Array(300))));
});

test("plum's own SOL send: ONE signer (the sender, who pays), and web3.js reads it the same", () => {
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();
  const message = compileLegacy({ payer: from, blockhash: BLOCKHASH, instructions: [ix.unitLimit(600), ix.unitPrice(10_000n), ix.transfer(from, to, 1_500_000_000n)] });
  const bytes = unsignedTx(message);
  const t = readTx(bytes);
  assert.equal(t.required, 1, 'exactly one signer');
  assert.equal(t.signatures.length, 1);
  assert.equal(t.keys[0], from, 'the sender pays the fee');
  const w = Transaction.from(bytes);
  assert.equal(w.feePayer.toBase58(), from);
  assert.equal(w.instructions.length, 3);
  const transfer = SystemInstruction.decodeTransfer(w.instructions[2]);
  assert.equal(transfer.fromPubkey.toBase58(), from);
  assert.equal(transfer.toPubkey.toBase58(), to);
  assert.equal(BigInt(transfer.lamports), 1_500_000_000n);
  assert.equal(ComputeBudgetProgram.programId.toBase58(), w.instructions[0].programId.toBase58());
  assert.equal(feeOf(t), 5000n + 6n); // 600 units at 10,000 micro-lamports = 6 lamports
});

test("plum's own token send: ONE signer, same accounts and data as spl-token's instructions", () => {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const owner = Keypair.generate().publicKey;
    const to = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const src = getAssociatedTokenAddressSync(mint, owner, false, program);
    const dest = getAssociatedTokenAddressSync(mint, to, false, program);
    assert.equal(associatedTokenAddress(to.toBase58(), mint.toBase58(), program.toBase58()), dest.toBase58());
    const ours = [
      ix.createAtaIdempotent(owner.toBase58(), dest.toBase58(), to.toBase58(), mint.toBase58(), program.toBase58()),
      ix.transferChecked(src.toBase58(), mint.toBase58(), dest.toBase58(), owner.toBase58(), 123_456_789n, 6, program.toBase58()),
    ];
    const theirs = [
      createAssociatedTokenAccountIdempotentInstruction(owner, dest, to, mint, program),
      createTransferCheckedInstruction(src, mint, dest, owner, 123_456_789n, 6, [], program),
    ];
    ours.forEach((o, i) => {
      assert.equal(o.programId, theirs[i].programId.toBase58());
      assert.deepEqual(Buffer.from(o.data), theirs[i].data);
      assert.deepEqual(o.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), theirs[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
    });
    const t = readTx(unsignedTx(compileLegacy({ payer: owner.toBase58(), blockhash: BLOCKHASH, instructions: ours })));
    assert.equal(t.required, 1, 'exactly one signer');
    assert.deepEqual(signersOf(t), [owner.toBase58()]);
  }
});

test('readMessage reads a bare message and nothing else', () => {
  const payer = Keypair.generate();
  const { tx, bytes } = legacyFromWeb3(payer, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })]);
  assert.equal(readMessage(tx.serializeMessage()).required, 1);
  assert.throws(() => readMessage(bytes));
  void PublicKey;
});
