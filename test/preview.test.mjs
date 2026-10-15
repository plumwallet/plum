// The preview: balance changes from the simulation, and every drainer pattern caught whether it's done directly or
// hidden inside another program (the simulated state is checked, not just the instructions).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, NONCE_ACCOUNT_LENGTH, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createApproveInstruction, createSetAuthorityInstruction, AuthorityType } from '@solana/spl-token';
import { base58Decode, base58Encode } from '../src/shared/base58.js';
import { b64encode, u64le } from '../src/shared/bytes.js';
import { TOKEN_PROGRAM, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM } from '../src/shared/tx.js';
import { PublicKey, StakeProgram, StakeAuthorizationLayout } from '@solana/web3.js';
import { previewTx, readTokenAccount, simErrorText } from '../src/background/preview.js';

const BLOCKHASH = base58Encode(new Uint8Array(32).fill(3));
const pk = () => Keypair.generate().publicKey;

function txBytes(payer, ixs, { signers = [] } = {}) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(...ixs);
  if (signers.length) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/** A token account's bytes. */
function tokenAccount({ mint, owner, amount, delegate = null, delegated = 0n, close = null }) {
  const d = new Uint8Array(165);
  d.set(base58Decode(mint), 0);
  d.set(base58Decode(owner), 32);
  d.set(u64le(amount), 64);
  if (delegate) { d.set([1, 0, 0, 0], 72); d.set(base58Decode(delegate), 76); }
  d[108] = 1;
  d.set(u64le(delegated), 121);
  if (close) { d.set([1, 0, 0, 0], 129); d.set(base58Decode(close), 133); }
  return { lamports: 2039280, owner: TOKEN_PROGRAM, data: [b64encode(d), 'base64'], executable: false };
}
const wallet = (lamports, owner = SYSTEM_PROGRAM) => ({ lamports, owner, data: ['', 'base64'], executable: false });

/** A stand-in RPC: `pre` and `post` are maps address -> account; `sim` adds fields to the simulation result. */
function fakeRpc({ pre = {}, post = {}, sim = {} } = {}) {
  return {
    async accounts(addrs) { return addrs.map((a) => pre[a] ?? null); },
    async simulate(_b64, addrs) { return { err: null, logs: ['Program log: ok'], unitsConsumed: 1234, accounts: addrs.map((a) => (a in post ? post[a] : pre[a] ?? null)), ...sim }; },
  };
}

test('a plain SOL transfer: the change and the fee, nothing to warn about', async () => {
  const me = pk(), to = pk();
  const bytes = txBytes(me, [SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports: 1_000_000 })]);
  const rpc = fakeRpc({ sim: { fee: 5000, preBalances: [10_000_000, 0, 1], postBalances: [8_995_000, 1_000_000, 1] } });
  const p = await previewTx(bytes, { owner: me.toBase58(), rpc });
  assert.equal(p.sol, '-1005000');
  assert.equal(p.fee, '5000');
  assert.equal(p.required, 1);
  assert.ok(p.youPayFee);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.sim.ok, true);
  assert.deepEqual(p.programs.map((x) => x.name), ['System']);
});

test("a transaction that doesn't ask you to sign is refused outright", async () => {
  const a = pk(), b = pk();
  const bytes = txBytes(a, [SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports: 1 })]);
  await assert.rejects(previewTx(bytes, { owner: b.toBase58(), rpc: fakeRpc() }), /doesn't ask for your signature/);
});

test('more signers than you, already signed by them, and someone else paying are all said', async () => {
  const me = pk();
  const site = Keypair.generate();
  const ixs = [new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: site.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) })];
  const bytes = txBytes(site.publicKey, ixs, { signers: [site] });
  const p = await previewTx(bytes, { owner: me.toBase58(), rpc: fakeRpc() });
  const text = p.warnings.map((w) => `${w.level}: ${w.text}`).join('\n');
  assert.match(text, /warn: it needs 2 signatures/);
  assert.match(text, /info: already signed by/);
  assert.match(text, /info: the network fee is paid by/);
});

test('a durable nonce is a danger (sign now, sent whenever)', async () => {
  const me = pk(), nonce = pk();
  void NONCE_ACCOUNT_LENGTH;
  const bytes = txBytes(me, [SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: me }), SystemProgram.transfer({ fromPubkey: me, toPubkey: pk(), lamports: 1 })]);
  const p = await previewTx(bytes, { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /durable nonce/.test(w.text)));
});

test('Assign of your wallet: caught from the instruction, and from the state when a program hides it', async () => {
  const me = pk();
  const direct = txBytes(me, [SystemProgram.assign({ accountPubkey: me, programId: pk() })]);
  const p1 = await previewTx(direct, { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p1.warnings.some((w) => w.level === 'danger' && /hands your wallet account/.test(w.text)));

  // a "claim" program that does the Assign by CPI: only the simulated state shows it
  const evil = pk();
  const hidden = txBytes(me, [new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Buffer.from([7]) })]);
  const rpc = fakeRpc({ pre: { [me.toBase58()]: wallet(5e9) }, post: { [me.toBase58()]: wallet(5e9, evil.toBase58()) } });
  const p2 = await previewTx(hidden, { owner: me.toBase58(), rpc });
  assert.ok(p2.warnings.some((w) => w.level === 'danger' && /hands your wallet account/.test(w.text)), JSON.stringify(p2.warnings));
});

test('your token account given away or opened to a spender: caught directly and by state', async () => {
  const me = pk(), thief = pk(), mint = pk().toBase58();
  const acct = pk();
  const a = acct.toBase58();
  // directly
  const set = txBytes(me, [createSetAuthorityInstruction(acct, me, AuthorityType.AccountOwner, thief)]);
  const p1 = await previewTx(set, { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p1.warnings.some((w) => w.level === 'danger' && /SetAuthority/.test(w.text)));
  const approve = txBytes(me, [createApproveInstruction(acct, thief, me, 1_000_000n)]);
  const p2 = await previewTx(approve, { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p2.warnings.some((w) => w.level === 'danger' && /spend tokens/.test(w.text)));

  // hidden in a program: the state after the simulation says it all
  const evil = pk();
  const hidden = txBytes(me, [new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: acct, isSigner: false, isWritable: true }], data: Buffer.from([1]) })]);
  const pre = { [a]: tokenAccount({ mint, owner: me.toBase58(), amount: 500n }) };
  const p3 = await previewTx(hidden, { owner: me.toBase58(), rpc: fakeRpc({ pre, post: { [a]: tokenAccount({ mint, owner: thief.toBase58(), amount: 500n }) } }) });
  assert.ok(p3.warnings.some((w) => w.level === 'danger' && /everything in it becomes theirs/.test(w.text)), JSON.stringify(p3.warnings));
  assert.deepEqual(p3.tokens.map((t) => [t.mint, t.delta]), [[mint, '-500']], 'the tokens count as gone');
  const p4 = await previewTx(hidden, { owner: me.toBase58(), rpc: fakeRpc({ pre, post: { [a]: tokenAccount({ mint, owner: me.toBase58(), amount: 500n, delegate: thief.toBase58(), delegated: 500n }) } }) });
  assert.ok(p4.warnings.some((w) => w.level === 'danger' && /spend your tokens/.test(w.text)), JSON.stringify(p4.warnings));
});

test('token changes come from the same-slot balances when the RPC gives them', async () => {
  const me = pk(), pool = pk(), mint = pk().toBase58();
  const bytes = txBytes(me, [new TransactionInstruction({ programId: pk(), keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }], data: Buffer.from([1]) })]);
  const owner = me.toBase58();
  const sim = {
    fee: 7000, preBalances: [3e9, 1, 1], postBalances: [2e9 - 7000, 1, 1],
    preTokenBalances: [{ accountIndex: 3, mint, owner, uiTokenAmount: { amount: '0', decimals: 6 } }],
    postTokenBalances: [{ accountIndex: 3, mint, owner, uiTokenAmount: { amount: '42000000', decimals: 6 } }, { accountIndex: 1, mint, owner: pk().toBase58(), uiTokenAmount: { amount: '1', decimals: 6 } }],
  };
  const meta = async (mints) => new Map(mints.map((m) => [m, { symbol: 'PLUM', name: 'plum', icon: null }]));
  const p = await previewTx(bytes, { owner, rpc: fakeRpc({ sim }), meta });
  assert.equal(p.sol, String(-1e9 - 7000));
  assert.deepEqual(p.tokens.map((t) => [t.symbol, t.delta, t.decimals]), [['PLUM', '42000000', 6]]);
});

test('a failed simulation is a danger, in words', async () => {
  const me = pk();
  const bytes = txBytes(me, [SystemProgram.transfer({ fromPubkey: me, toPubkey: pk(), lamports: 1 })]);
  const rpc = fakeRpc({ sim: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 0, need 1'] } });
  const p = await previewTx(bytes, { owner: me.toBase58(), rpc });
  assert.equal(p.sim.ok, false);
  assert.match(p.sim.error, /not enough SOL/);
  assert.ok(p.warnings[0].level === 'danger' && /simulation failed/.test(p.warnings[0].text));
  assert.match(simErrorText({ InstructionError: [2, { Custom: 6001 }] }, ['Program log: custom program error: 0x1771']), /slippage/);
});

test('stake authority, Allocate and nonce authority handed over are dangers', async () => {
  const me = pk(), thief = pk(), stake = pk();
  const auth = StakeProgram.authorize({ stakePubkey: stake, authorizedPubkey: me, newAuthorizedPubkey: thief, stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer });
  const p1 = await previewTx(txBytes(me, auth.instructions), { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p1.warnings.some((w) => w.level === 'danger' && /stake account/.test(w.text)), JSON.stringify(p1.warnings));
  const p2 = await previewTx(txBytes(me, [SystemProgram.allocate({ accountPubkey: me, space: 8 })]), { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p2.warnings.some((w) => w.level === 'danger' && /Allocate/.test(w.text)));
  const p3 = await previewTx(txBytes(me, [SystemProgram.nonceAuthorize({ noncePubkey: pk(), authorizedPubkey: me, newAuthorizedPubkey: thief })]), { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p3.warnings.some((w) => w.level === 'danger' && /nonce account/.test(w.text)));
});

test('your key taken off any account (hidden in a program) is caught by the state', async () => {
  const me = pk(), thief = pk(), asset = pk(), evil = pk();
  const ix = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: asset, isSigner: false, isWritable: true }], data: Buffer.from([3]) });
  const bytesOf = (owner) => { const d = new Uint8Array(80); d.set(owner.toBytes(), 10); return { lamports: 3e6, owner: evil.toBase58(), data: [b64encode(d), 'base64'], executable: false }; };
  const rpc = fakeRpc({ pre: { [asset.toBase58()]: bytesOf(me) }, post: { [asset.toBase58()]: bytesOf(thief) } });
  const p = await previewTx(txBytes(me, [ix]), { owner: me.toBase58(), rpc });
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /takes you off/.test(w.text)), JSON.stringify(p.warnings));
  assert.ok(p.warnings.some((w) => w.level === 'info' && /doesn't know/.test(w.text)), 'an unknown program gets your signature: said');
  const rpc2 = fakeRpc({ pre: { [me.toBase58()]: wallet(5e9) }, post: { [me.toBase58()]: { ...wallet(5e9), data: [b64encode(new Uint8Array(8)), 'base64'] } } });
  const p2 = await previewTx(txBytes(me, [ix]), { owner: me.toBase58(), rpc: rpc2 });
  assert.ok(p2.warnings.some((w) => w.level === 'danger' && /Allocate/.test(w.text)));
});

test('an incomplete simulation is a danger, never "no change"', async () => {
  const me = pk();
  const bytes = txBytes(me, [SystemProgram.transfer({ fromPubkey: me, toPubkey: pk(), lamports: 1 })]);
  const rpc = { accounts: async (a) => a.map(() => wallet(1e9)), simulate: async () => ({ err: null, logs: [], accounts: [] }) };
  const p = await previewTx(bytes, { owner: me.toBase58(), rpc });
  assert.equal(p.sim.ok, false);
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /incomplete/.test(w.text)));
});

test('a priority fee padded with extra bytes still counts (the runtime ignores the padding)', async () => {
  const me = pk();
  const data = Buffer.alloc(16);
  data[0] = 3;
  data.writeBigUInt64LE(50_000_000_000n, 1);
  const pad = new TransactionInstruction({ programId: new PublicKey(COMPUTE_BUDGET_PROGRAM), keys: [], data });
  const bytes = txBytes(me, [pad, SystemProgram.transfer({ fromPubkey: me, toPubkey: pk(), lamports: 1 })]);
  const p = await previewTx(bytes, { owner: me.toBase58(), rpc: fakeRpc() });
  assert.ok(p.warnings.some((w) => /priority fee/.test(w.text)), JSON.stringify(p.warnings));
});

test('reads token accounts and nothing else', () => {
  const mint = pk().toBase58(), owner = pk().toBase58();
  const t = readTokenAccount(tokenAccount({ mint, owner, amount: 7n }));
  assert.deepEqual([t.mint, t.owner, t.amount, t.delegate], [mint, owner, 7n, null]);
  assert.equal(readTokenAccount(wallet(1)), null);
  assert.equal(readTokenAccount(null), null);
});
