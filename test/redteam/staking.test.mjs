// Attacks around staking: a validator list (or a site) that points your stake at something that isn't a validator,
// stake accounts that aren't yours, a withdrawal steered elsewhere, and sites' stake transactions that hand your SOL to
// a stake account someone else controls. And every staking step plum builds is signed by you alone, sent as built.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Authorized, Keypair, Lockup, PublicKey, StakeProgram } from '@solana/web3.js';
import { base58Decode } from '../../src/shared/base58.js';
import { b64decode, b64encode, u32le, u64le } from '../../src/shared/bytes.js';
import { isSigned, readTx } from '../../src/shared/tx.js';
import { STAKE_PROGRAM, VOTE_PROGRAM, addressWithSeed, stakeSeed } from '../../src/background/stake.js';
import { ME, PK, boot, legacyB64, pk } from './helpers.mjs';

const ctx = await boot({ balance: 20_000_000_000n });
await ctx.setup();
const VOTE = pk().toBase58();
ctx.chain.accounts.set(VOTE, { lamports: 27_074_400, owner: VOTE_PROGRAM, data: [b64encode(new Uint8Array(3762)), 'base64'], executable: false });

/** A stake account's bytes, as the stake program keeps them. */
function stakeAccount({ staker = ME, withdrawer = ME, act = 5n, deact = (1n << 64n) - 1n, stake = 3_000_000_000n } = {}) {
  const d = new Uint8Array(200);
  d.set(u32le(2), 0);
  d.set(u64le(2_282_880n), 4);
  d.set(base58Decode(staker), 12);
  d.set(base58Decode(withdrawer), 44);
  d.set(base58Decode(VOTE), 124);
  d.set(u64le(stake), 156);
  d.set(u64le(act), 164);
  d.set(u64le(deact), 172);
  return { lamports: Number(stake + 2_282_880n), owner: STAKE_PROGRAM, data: [b64encode(d), 'base64'], executable: false };
}

test('staking: one transaction, one signer (you, who pays), nothing signed before you; sent exactly as reviewed', async () => {
  const prep = await ctx.ok('stake.prepare', { action: 'stake', vote: VOTE, amount: '2' });
  const built = readTx(ctx._test.prepared.get(prep.id).bytes);
  assert.equal(built.required, 1);
  assert.deepEqual(built.keys.slice(0, 1), [ME]);
  assert.ok(!built.signatures.some(isSigned));
  assert.equal(prep.summary.account, addressWithSeed(ME, stakeSeed(0), STAKE_PROGRAM));
  assert.equal(prep.preview.sim.ok, true);
  assert.equal(prep.preview.sol, String(-(2_000_000_000 + 1_666_240) - Number(prep.preview.fee)), 'the stake and its rent leave your wallet, in the preview');
  assert.ok(!prep.preview.warnings.some((w) => w.level === 'danger'), JSON.stringify(prep.preview.warnings));
  assert.ok(prep.preview.warnings.some((w) => /it stakes the stake account/.test(w.text)));
  const before = ctx.chain.sentTxs.length;
  const done = await ctx.ok('stake.submit', { id: prep.id });
  assert.equal(ctx.chain.sentTxs.length, before + 1);
  const sent = readTx(b64decode(ctx.chain.sentTxs.at(-1)));
  assert.deepEqual(sent.message, built.message, 'what was reviewed is what was signed');
  assert.equal(sent.signatures.length, 1);
  assert.ok(ed25519.verify(sent.signatures[0], sent.message, base58Decode(ME)));
  assert.equal(done.chain, 'sol');
});

test("a stake can only go to a real vote account: a list or a site can't steer it at a wallet or a program", async () => {
  const thief = pk().toBase58();
  ctx.chain.accounts.set(thief, { lamports: 5_000_000, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false });
  assert.match(await ctx.err('stake.prepare', { action: 'stake', vote: thief, amount: '2' }), /isn't a validator's vote account/);
  const program = pk().toBase58();
  ctx.chain.accounts.set(program, { lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: ['', 'base64'], executable: true });
  assert.match(await ctx.err('stake.prepare', { action: 'stake', vote: program, amount: '2' }), /isn't a validator's vote account/);
  assert.match(await ctx.err('stake.prepare', { action: 'stake', vote: pk().toBase58(), amount: '2' }), /isn't a validator's vote account/);
});

test("someone else's stake account can't be unstaked or withdrawn, and a withdrawal only ever comes to you", async () => {
  const theirs = pk().toBase58();
  ctx.chain.accounts.set(theirs, stakeAccount({ staker: pk().toBase58(), withdrawer: pk().toBase58(), deact: 2n }));
  assert.match(await ctx.err('stake.prepare', { action: 'unstake', account: theirs }), /isn't the stake account's staker/);
  assert.match(await ctx.err('stake.prepare', { action: 'withdraw', account: theirs }), /isn't the stake account's withdrawer/);
  const mine = pk().toBase58();
  ctx.chain.accounts.set(mine, stakeAccount({ deact: 2n }));
  const thief = pk().toBase58();
  const prep = await ctx.ok('stake.prepare', { action: 'withdraw', account: mine, to: thief, recipient: thief });
  const t = readTx(ctx._test.prepared.get(prep.id).bytes);
  assert.equal(t.required, 1);
  assert.ok(!t.keys.includes(thief), 'the address a caller slipped in is nowhere in it');
  const withdraw = t.instructions.find((i) => t.keys[i.programIndex] === STAKE_PROGRAM);
  assert.equal(t.keys[withdraw.accounts[1]], ME, 'the SOL comes to your wallet');
});

test("a site's stake account that someone else can withdraw is a danger", async () => {
  const page = await ctx.connectSite('https://stake-yield.example/');
  const thief = Keypair.generate().publicKey;
  const stake = Keypair.generate();
  const steal = StakeProgram.createAccount({ fromPubkey: PK(ME), stakePubkey: stake.publicKey, authorized: new Authorized(PK(ME), thief), lockup: new Lockup(0, 0, PublicKey.default), lamports: 5_000_000_000 });
  const answer = page.request('signTransaction', { account: ME, transactions: [legacyB64(PK(ME), steal.instructions, { signers: [stake] })] });
  const view = await ctx.nextApproval();
  const [p] = await ctx.ok('approval.preview', { id: view.id });
  await ctx.rejectAll();
  await answer;
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /for .* to withdraw, not you/.test(w.text)), JSON.stringify(p.warnings));
  // InitializeChecked names the withdrawer as an account (and needs it to sign): the same danger
  const checked = { programId: StakeProgram.programId, keys: [{ pubkey: stake.publicKey, isSigner: false, isWritable: true }, { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false }, { pubkey: PK(ME), isSigner: false, isWritable: false }, { pubkey: thief, isSigner: true, isWritable: false }], data: Buffer.from(u32le(9)) };
  const answer2 = page.request('signTransaction', { account: ME, transactions: [legacyB64(PK(ME), [checked])] });
  const view2 = await ctx.nextApproval();
  const [p2] = await ctx.ok('approval.preview', { id: view2.id });
  await ctx.rejectAll();
  await answer2;
  assert.ok(p2.warnings.some((w) => w.level === 'danger' && /to withdraw, not you/.test(w.text)), JSON.stringify(p2.warnings));
  // your own staking, from a site, is said in plain words and isn't a danger
  const fine = StakeProgram.createAccount({ fromPubkey: PK(ME), stakePubkey: stake.publicKey, authorized: new Authorized(PK(ME), PK(ME)), lockup: new Lockup(0, 0, PublicKey.default), lamports: 2_000_000_000 });
  const delegate = StakeProgram.delegate({ stakePubkey: stake.publicKey, authorizedPubkey: PK(ME), votePubkey: PK(VOTE) });
  const answer3 = page.request('signTransaction', { account: ME, transactions: [legacyB64(PK(ME), [...fine.instructions, ...delegate.instructions], { signers: [stake] })] });
  const view3 = await ctx.nextApproval();
  const [p3] = await ctx.ok('approval.preview', { id: view3.id });
  await ctx.rejectAll();
  await answer3;
  assert.ok(!p3.warnings.some((w) => w.level === 'danger'), JSON.stringify(p3.warnings));
  assert.ok(p3.warnings.some((w) => /it stakes the stake account .* with the validator/.test(w.text)));
  // a site unstaking your stake: said in plain words
  const mine = pk();
  const answer4 = page.request('signTransaction', { account: ME, transactions: [legacyB64(PK(ME), StakeProgram.deactivate({ stakePubkey: mine, authorizedPubkey: PK(ME) }).instructions)] });
  const view4 = await ctx.nextApproval();
  const [p4] = await ctx.ok('approval.preview', { id: view4.id });
  await ctx.rejectAll();
  await answer4;
  assert.ok(p4.warnings.some((w) => w.level === 'info' && /it unstakes your stake account/.test(w.text)));
});

test("staking's reads are plum's own: a page can't call them", async () => {
  assert.equal(await ctx.fake.ui('stake.prepare', { action: 'stake', vote: VOTE, amount: '2' }, 'https://evil.example/'), undefined);
  assert.equal(await ctx.fake.ui('stake.list', {}, 'https://evil.example/'), undefined);
  const page = ctx.fake.page('https://evil.example/');
  const r = await page.request('stake.prepare', { action: 'stake', vote: VOTE, amount: '2' });
  assert.match(r.error.message, /unknown method|connect to Plum first/);
});
