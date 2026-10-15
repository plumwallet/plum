// Attack: get plum to ed25519-sign a "message" whose bytes are a transaction message, so the
// signature works on chain. Fuzzed over many shapes web3.js can produce, plus encodings plum's reader is lenient about.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputeBudgetProgram, Keypair, MessageV0, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { messageRefusal, signInMessage } from '../../src/background/main.js';
import { base58Encode } from '../../src/shared/base58.js';
import { utf8 } from '../../src/shared/bytes.js';
import { isTransactionShaped, startsLikeTransaction } from '../../src/shared/tx.js';
import { ME } from './helpers.mjs';

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const pick = (n) => rnd(1)[0] % n;
const blockhash = () => base58Encode(rnd(32));

/** A random legacy transaction: 1-4 signers (the victim among them), 0-5 instructions over random programs. */
function randomLegacy(victim) {
  const payer = pick(2) ? victim : Keypair.generate();
  const extraSigners = Array.from({ length: pick(3) }, () => Keypair.generate());
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash() });
  const n = pick(6);
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const keys = [{ pubkey: victim.publicKey, isSigner: true, isWritable: !!pick(2) }];
    for (const s of extraSigners) if (pick(2)) { keys.push({ pubkey: s.publicKey, isSigner: true, isWritable: !!pick(2) }); used.add(s); }
    for (let k = pick(4); k > 0; k--) keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: !!pick(2) });
    tx.add(new TransactionInstruction({ programId: pick(3) ? Keypair.generate().publicKey : SystemProgram.programId, keys, data: Buffer.from(rnd(pick(40))) }));
  }
  if (!n) tx.add(SystemProgram.transfer({ fromPubkey: victim.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 + pick(1000) }));
  if (pick(2)) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 + pick(100000) }));
  const signed = pick(2) ? [...used, ...(payer !== victim ? [payer] : [])] : [];
  if (signed.length) tx.partialSign(...signed);
  return { message: tx.serializeMessage(), wire: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) };
}

/** A random v0 transaction with 0-2 lookup tables. */
function randomV0(victim) {
  const tables = Array.from({ length: pick(3) }, () => ({
    key: Keypair.generate().publicKey,
    state: { addresses: Array.from({ length: 1 + pick(5) }, () => Keypair.generate().publicKey), authority: undefined, deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 },
    isActive: () => true,
  }));
  const keys = [{ pubkey: victim.publicKey, isSigner: true, isWritable: true }];
  for (const t of tables) for (const a of t.state.addresses) keys.push({ pubkey: a, isSigner: false, isWritable: !!pick(2) });
  const ix = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys, data: Buffer.from(rnd(pick(30))) });
  const msg = MessageV0.compile({ payerKey: victim.publicKey, recentBlockhash: blockhash(), instructions: [ix], addressLookupTableAccounts: tables });
  const vtx = new VersionedTransaction(msg);
  return { message: msg.serialize(), wire: vtx.serialize() };
}

test('fuzz: 150 random legacy transactions, as messages or as wire bytes, are all refused as messages', () => {
  const victim = Keypair.generate();
  for (let i = 0; i < 150; i++) {
    const { message, wire } = randomLegacy(victim);
    assert.ok(messageRefusal(message), `legacy message #${i} accepted: ${Buffer.from(message).toString('hex').slice(0, 60)}`);
    assert.ok(messageRefusal(wire), `legacy wire #${i} accepted`);
    assert.ok(messageRefusal(Uint8Array.from([...message, ...rnd(1 + pick(50))])), `legacy message + junk #${i} accepted`);
  }
});

test('fuzz: 80 random v0 transactions with lookup tables are all refused as messages', () => {
  const victim = Keypair.generate();
  for (let i = 0; i < 80; i++) {
    const { message, wire } = randomV0(victim);
    assert.ok(messageRefusal(message), `v0 message #${i} accepted`);
    assert.ok(messageRefusal(wire), `v0 wire #${i} accepted`);
    assert.ok(messageRefusal(Uint8Array.from([...message, ...rnd(1 + pick(50))])), `v0 message + junk #${i} accepted`);
  }
});

test('a message where the victim is the second of two signers (attacker pays) is refused', () => {
  const victim = Keypair.generate(), attacker = Keypair.generate();
  const tx = new Transaction({ feePayer: attacker.publicKey, recentBlockhash: blockhash() })
    .add(SystemProgram.transfer({ fromPubkey: victim.publicKey, toPubkey: attacker.publicKey, lamports: 5_000_000_000 }));
  tx.partialSign(attacker);
  assert.ok(messageRefusal(tx.serializeMessage()));
  assert.ok(messageRefusal(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
});

test('a legacy message with zero instructions (just the fee) is refused', () => {
  const victim = Keypair.generate();
  const bytes = Uint8Array.from([1, 0, 0, 1, ...victim.publicKey.toBytes(), ...rnd(32), 0]);
  assert.ok(isTransactionShaped(bytes));
  assert.ok(messageRefusal(bytes));
});

test('non-canonical compact-u16 lengths (two bytes for a small number) do not slip a message past the reader', () => {
  const victim = Keypair.generate();
  const tx = new Transaction({ feePayer: victim.publicKey, recentBlockhash: blockhash() }).add(SystemProgram.transfer({ fromPubkey: victim.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 7 }));
  const m = tx.serializeMessage();
  // the key count sits at byte 3 of a legacy message; write it as [0x80 | n, 0x00]
  const padded = Uint8Array.from([m[0], m[1], m[2], 0x80 | m[3], 0x00, ...m.subarray(4)]);
  assert.ok(startsLikeTransaction(padded), 'plum reads the padded form as a transaction');
  assert.ok(messageRefusal(padded));
  // the same trick on the instruction count
  const ixAt = 3 + 1 + 32 * m[3] + 32;
  const padded2 = Uint8Array.from([...m.subarray(0, ixAt), 0x80 | m[ixAt], 0x00, ...m.subarray(ixAt + 1)]);
  assert.ok(messageRefusal(padded2));
});

test('a v0 message dressed as the off-chain envelope is not a transaction; a transaction dressed as text is refused', () => {
  const victim = Keypair.generate();
  const { message } = randomV0(victim);
  // the envelope prefix can never be a transaction on chain (version 127), so plum rightly allows it
  const env = Uint8Array.from([0xff, ...utf8('solana offchain'), ...message]);
  assert.equal(messageRefusal(env), null);
  // "text" that happens to begin with a valid header and keys: refused by the shape, not by readability
  const { message: legacy } = randomLegacy(victim);
  assert.ok(messageRefusal(legacy));
});

test('the Sign In With Solana text plum signs is never transaction-shaped (defence in depth, documented)', () => {
  for (const statement of ['hello', 'a'.repeat(1000), '1'.repeat(1000), String.fromCharCode(...Array.from({ length: 900 }, () => 0x21 + pick(0x5e)))]) {
    const { text } = signInMessage({ statement, nonce: 'abc', uri: 'https://app.example.com/' }, { origin: 'https://app.example.com', address: ME });
    assert.equal(messageRefusal(utf8(text)), null, 'sign-in text is signed as text');
    assert.ok(!startsLikeTransaction(utf8(text)));
  }
  void PublicKey;
});
