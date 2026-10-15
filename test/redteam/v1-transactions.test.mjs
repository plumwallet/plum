// Attacks through v1 transactions (SIMD-0385): malformed v1 bytes, v1 messages passed off as messages to sign, a
// header config that hides the fee, oversize transactions, and the signer rules carried over from legacy and v0. Every
// refusal must come before an approval window opens. v1 transactions here are built by plum's own writer, which
// test/tx-v1.test.mjs checks against @solana/web3.js and real mainnet transactions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair } from '@solana/web3.js';
import { messageRefusal } from '../../src/background/main.js';
import { base58Decode, base58Encode } from '../../src/shared/base58.js';
import { b64decode, b64encode, concat, u32le, utf8 } from '../../src/shared/bytes.js';
import { compileV1, ix, readTx, unsignedTx, withSignature } from '../../src/shared/tx.js';
import { BLOCKHASH, ME, boot, sleep } from './helpers.mjs';

const ctx = await boot();
await ctx.setup();
const page = await ctx.connectSite('https://v1.example/');
const key = () => Keypair.generate().publicKey.toBase58();
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const pick = (n) => rnd(1)[0] % n;

/** An unsigned v1 transaction from instructions, paid by `payer` (you by default). */
const v1 = (instructions, { payer = ME, config = { computeUnitLimit: 10_000, priorityFee: 0n } } = {}) => unsignedTx(compileV1({ payer, blockhash: BLOCKHASH, instructions, config }));
const transfer = (lamports = 1000n) => ix.transfer(ME, key(), lamports);

/** Ask, and say whether an approval appeared (then reject it) or the request was refused outright. */
async function ask(method, txs) {
  let answered = false;
  const answer = page.request(method, { account: ME, transactions: txs.map((t) => (typeof t === 'string' ? t : b64encode(t))) }).finally(() => { answered = true; });
  const until = Date.now() + 300;
  while (!answered && !ctx._test.pending.size && Date.now() < until) await sleep(5);
  const queued = ctx._test.pending.size > 0;
  if (queued) await ctx.rejectAll();
  const r = await answer;
  return { queued, error: r.error?.message ?? null, result: r.result };
}

test('a site signs a v1 transaction: previewed as v1, signed at its tail by you alone', async () => {
  const tx = v1([transfer(2_000_000n)], { config: { computeUnitLimit: 600, priorityFee: 1234n } });
  const answer = page.request('signTransaction', { account: ME, transactions: [b64encode(tx)] });
  const view = await ctx.nextApproval();
  assert.equal(view.kind, 'sign');
  const [p] = await ctx.ok('approval.preview', { id: view.id });
  assert.equal(p.version, 1);
  assert.equal(p.sim.ok, true);
  assert.equal(p.fee, String(5000 + 1234), 'the fee is the header\'s');
  assert.equal(p.config.units, 600);
  assert.equal(p.sol, String(-2_000_000 - 5000), 'the simulated SOL change');
  await ctx.ok('approval.resolve', { id: view.id, approve: true });
  const { result } = await answer;
  const signed = b64decode(result[0]);
  const t = readTx(signed);
  assert.deepEqual(t.message, readTx(tx).message, 'the message is exactly what the site sent');
  assert.ok(ed25519.verify(t.signatures[0], t.message, base58Decode(ME)));
});

test('a site signs and sends a v1 transaction: it goes out as base64, and its signature comes back', async () => {
  const tx = v1([transfer(3_000n)]);
  const before = ctx.chain.sentTxs.length;
  const answer = page.request('signAndSendTransaction', { account: ME, transactions: [b64encode(tx)] });
  await ctx.approveNext();
  const { result } = await answer;
  assert.equal(ctx.chain.sentTxs.length, before + 1);
  const sent = readTx(b64decode(ctx.chain.sentTxs.at(-1)));
  assert.equal(sent.version, 1);
  assert.equal(result[0], base58Encode(sent.signatures[0]));
});

test('malformed v1 bytes are refused before any window opens', async () => {
  const good = v1([transfer()]);
  const m = readTx(good);
  // where things sit in `good`: its one instruction's header comes after the addresses and 12 bytes of config (a u64
  // priority fee and a u32 compute limit), and its account indexes after that header
  const at = { mask: 4, ixCount: 40, keyCount: 41, keys: 42 };
  const ixHead = at.keys + 32 * m.keys.length + 12;
  const edit = (fn) => { const b = good.slice(); fn(b); return b; };
  const withMessage = (message) => concat(message, new Uint8Array(64 * message[1]));
  const cases = {
    'an unknown config bit': edit((b) => b.set(u32le(0b100000 | 0b100), at.mask)),
    'the top config bit': edit((b) => b.set(u32le(0x80000004), at.mask)),
    'half of the priority fee bits': withMessage(compileV1({ payer: ME, blockhash: BLOCKHASH, instructions: [transfer()], config: { computeUnitLimit: 5 } }).map((x, i) => (i === at.mask ? 0b101 : x))),
    'no fee payer': edit((b) => { b[1] = 0; }),
    'a read-only fee payer': edit((b) => { b[2] = 1; }),
    'thirteen signers': (() => { const msg = compileV1({ payer: ME, blockhash: BLOCKHASH, instructions: [transfer()], config: {} }); const b = msg.slice(); b[1] = 13; return concat(b, new Uint8Array(64 * 13)); })(),
    'the same address twice': edit((b) => b.set(b.subarray(at.keys, at.keys + 32), at.keys + 32)),
    'the fee payer as a program': edit((b) => { b[ixHead] = 0; }),
    'a program it does not name': edit((b) => { b[ixHead] = 9; }),
    'an account it does not name': edit((b) => { b[ixHead + 4] = 40; }),
    'a heap size that is not whole kilobytes': withMessage(compileV1Unchecked({ heapSize: 33_000 })),
    'a heap size under 32 KB': withMessage(compileV1Unchecked({ heapSize: 16 * 1024 })),
    'a heap size over 256 KB': withMessage(compileV1Unchecked({ heapSize: 512 * 1024 })),
    'cut short': good.subarray(0, good.length - 1),
    'a byte too many': concat(good, Uint8Array.of(0)),
    'only its version byte': Uint8Array.of(0x81),
    'nothing but a header': Uint8Array.of(0x81, 1, 0, 0),
    'a version past v1': Uint8Array.of(0x82, ...good.subarray(1)),
  };
  for (const [what, bytes] of Object.entries(cases)) {
    assert.throws(() => readTx(bytes), `${what}: plum's reader should refuse it`);
    const r = await ask('signTransaction', [bytes]);
    assert.equal(r.queued, false, `${what}: an approval window opened`);
    assert.match(r.error ?? '', /can't read this transaction|malformed|more than/, what);
  }
});

/** A v1 message with any config, written without the writer's own check (for configs the runtime refuses). */
function compileV1Unchecked(config) {
  const ok = compileV1({ payer: ME, blockhash: BLOCKHASH, instructions: [transfer()], config: { computeUnitLimit: 7, heapSize: 32 * 1024 } });
  const b = ok.slice();
  // the heap size is the last u32 of the config values, which sit right after the addresses
  const keysEnd = 42 + 32 * b[41];
  b.set(u32le(config.heapSize), keysEnd + 4);
  return b;
}

test('too many instructions or addresses, and oversize transactions, are refused', async () => {
  const many = (n) => Array.from({ length: n }, () => ({ programId: ix.transfer(ME, ME, 0n).programId, keys: [], data: new Uint8Array(0) }));
  assert.throws(() => compileV1({ payer: ME, blockhash: BLOCKHASH, instructions: many(65) }), /64 instructions/);
  const keys = Array.from({ length: 64 }, () => ({ pubkey: key(), isSigner: false, isWritable: false }));
  assert.throws(() => compileV1({ payer: ME, blockhash: BLOCKHASH, instructions: [{ programId: key(), keys, data: new Uint8Array(0) }] }), /64 addresses/);
  // by hand: 65 instructions in the count byte
  const good = v1([transfer()]);
  const lie = good.slice();
  lie[40] = 65;
  assert.equal((await ask('signTransaction', [lie])).queued, false);
  // 4096 bytes is fine; 4097 is not; legacy past 1232 is not
  const sized = (n) => v1([{ programId: key(), keys: [], data: new Uint8Array(n) }]);
  const base = sized(0).length;
  const max = sized(4096 - base);
  assert.equal(max.length, 4096);
  const r = await ask('signTransaction', [max]);
  assert.equal(r.queued, true, 'a full-size v1 transaction reaches the window');
  const r2 = await ask('signTransaction', [sized(4097 - base)]);
  assert.equal(r2.queued, false);
  assert.match(r2.error, /4097 bytes, more than the 4096/);
  const legacyBig = Uint8Array.from([1, ...new Uint8Array(64), ...rnd(1200)]);
  assert.match((await ask('signTransaction', [legacyBig])).error, /more than the 1232/);
  // base64 longer than any v1 transaction could be
  assert.match((await ask('signTransaction', ['A'.repeat(5468)])).error, /malformed/);
});

test('a header config that hides the fee: the preview shows what the header charges, whatever else it says', async () => {
  // compute-budget instructions that make it look nearly free, and 2 SOL of priority fee in the header
  const tx = v1([ix.unitLimit(200), ix.unitPrice(1n), transfer(1n)], { config: { computeUnitLimit: 5000, priorityFee: 2_000_000_000n } });
  const answer = page.request('signTransaction', { account: ME, transactions: [b64encode(tx)] });
  const view = await ctx.nextApproval();
  // the stand-in RPC answers a fee of 5000 a signature: an RPC can't talk the header's fee down
  const [p] = await ctx.ok('approval.preview', { id: view.id });
  await ctx.rejectAll();
  await answer;
  assert.equal(p.fee, '2000005000');
  assert.equal(p.priority, '2000000000');
  const text = p.warnings.map((w) => `${w.level}: ${w.text}`).join('\n');
  assert.match(text, /warn: it pays a priority fee of 2 SOL/);
  assert.match(text, /info: it carries compute-budget instructions, which do nothing in a v1 transaction/);
});

test('the signer rules hold for v1: other signers are named, and one that never asks for you is refused', async () => {
  const attacker = Keypair.generate();
  const message = compileV1({ payer: attacker.publicKey.toBase58(), blockhash: BLOCKHASH, instructions: [{ ...transfer(5_000_000n) }], config: { computeUnitLimit: 900 } });
  const unsigned = unsignedTx(message);
  const presigned = withSignature(unsigned, attacker.publicKey.toBase58(), ed25519.sign(message, attacker.secretKey.subarray(0, 32)));
  const answer = page.request('signTransaction', { account: ME, transactions: [b64encode(presigned)] });
  const view = await ctx.nextApproval();
  const [p] = await ctx.ok('approval.preview', { id: view.id });
  await ctx.rejectAll();
  await answer;
  assert.equal(p.required, 2);
  const text = p.warnings.map((w) => `${w.level}: ${w.text}`).join('\n');
  assert.match(text, /warn: it needs 2 signatures/);
  assert.match(text, /info: already signed by/);
  assert.match(text, /info: the network fee is paid by/);
  const notMine = v1([ix.transfer(attacker.publicKey.toBase58(), key(), 1n)], { payer: attacker.publicKey.toBase58() });
  const r = await ask('signTransaction', [notMine]);
  assert.equal(r.queued, false);
  assert.match(r.error, /doesn't ask for the connected account's signature/);
});

/** A random v1 message with you among its signers: 1-4 signers, 0-6 instructions over random programs, any config. */
function randomV1Message() {
  const others = Array.from({ length: pick(4) }, () => key());
  const instructions = [];
  for (let i = pick(7); i > 0; i--) {
    const keys = [{ pubkey: ME, isSigner: true, isWritable: !!pick(2) }];
    for (const o of others) if (pick(2)) keys.push({ pubkey: o, isSigner: true, isWritable: !!pick(2) });
    for (let k = pick(5); k > 0; k--) keys.push({ pubkey: key(), isSigner: false, isWritable: !!pick(2) });
    instructions.push({ programId: key(), keys, data: rnd(pick(60)) });
  }
  const config = {};
  if (pick(2)) config.priorityFee = BigInt(pick(250)) * 1000n;
  if (pick(2)) config.computeUnitLimit = pick(250) * 1000;
  if (pick(2)) config.loadedAccountsDataSizeLimit = pick(250) * 1024;
  if (pick(2)) config.heapSize = (32 + 8 * pick(28)) * 1024;
  return compileV1({ payer: pick(3) ? ME : others[0] ?? ME, blockhash: base58Encode(rnd(32)), instructions, config });
}

test('fuzz: 200 random v1 messages, as messages, as transactions or with bytes after them, are all refused as messages', () => {
  for (let i = 0; i < 200; i++) {
    const message = randomV1Message();
    assert.ok(messageRefusal(message), `v1 message #${i} accepted: ${Buffer.from(message).toString('hex').slice(0, 60)}`);
    assert.ok(messageRefusal(unsignedTx(message)), `v1 transaction #${i} accepted`);
    assert.ok(messageRefusal(concat(message, rnd(1 + pick(50)))), `v1 message + junk #${i} accepted`);
    assert.match(messageRefusal(message), /transaction/, 'named for what it is');
  }
  // real ones from mainnet too
  for (const f of JSON.parse(readFileSync(new URL('../fixtures/v1-mainnet.json', import.meta.url), 'utf8'))) {
    const bytes = Uint8Array.from(Buffer.from(f.transaction, 'base64'));
    assert.ok(messageRefusal(bytes) && messageRefusal(readTx(bytes).message));
  }
});

test('a v1 message sent to signMessage is refused before you see it', async () => {
  const message = compileV1({ payer: ME, blockhash: BLOCKHASH, instructions: [transfer(9_000_000_000n)], config: { computeUnitLimit: 500 } });
  for (const bytes of [message, unsignedTx(message), concat(message, utf8(' please sign'))]) {
    const answer = page.request('signMessage', { account: ME, message: b64encode(bytes) });
    const r = await answer;
    assert.equal(ctx._test.pending.size, 0);
    assert.match(r.error.message, /refuses to sign this message/);
  }
});

test('history lists v1 transactions like any other (getSignaturesForAddress has no version to ask for)', async () => {
  const [real] = JSON.parse(readFileSync(new URL('../fixtures/v1-mainnet.json', import.meta.url), 'utf8'));
  ctx.chain.handlers.getSignaturesForAddress = () => [{ signature: real.signature, slot: real.slot, blockTime: 1_791_000_000, err: null, confirmationStatus: 'finalized' }];
  try {
    const { items, errors } = await ctx.ok('activity');
    assert.equal(errors.sol, undefined, 'Solana answered (the other chains have no network here)');
    const it = items.find((x) => x.id === real.signature);
    assert.equal(it.ok, true);
    assert.match(it.explorer, new RegExp(`/tx/${real.signature}$`));
  } finally {
    delete ctx.chain.handlers.getSignaturesForAddress;
  }
});

test('plum tells sites it takes v1 transactions', () => {
  const src = readFileSync(new URL('../../src/content/inject.js', import.meta.url), 'utf8');
  assert.equal((src.match(/supportedTransactionVersions: \['legacy', 0, 1\]/g) ?? []).length, 2);
});
