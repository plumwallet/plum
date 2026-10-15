// Attacks on the preview: ways to move or endanger the user's assets that none of the current checks name, and the
// existing checks retried through lookup tables and Token-2022 accounts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, MessageV0, PublicKey, StakeProgram, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { createApproveInstruction, createCloseAccountInstruction, createMintToInstruction, createSetAuthorityInstruction, AuthorityType } from '@solana/spl-token';
import { previewTx } from '../../src/background/preview.js';
import { base58Decode } from '../../src/shared/base58.js';
import { b64encode } from '../../src/shared/bytes.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '../../src/shared/tx.js';
import { BLOCKHASH, EXT, fakeRpc, legacyBytes, mint2022, pk, tokenAccount, walletAccount } from './helpers.mjs';

const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const text = (p) => p.warnings.map((w) => `${w.level}: ${w.text}`).join('\n') || '(no warnings)';

test('stake: withdrawing your staked SOL to an attacker with your withdraw authority gets no warning', async () => {
  const me = pk(), thief = pk(), stake = pk();
  const ixs = StakeProgram.withdraw({ stakePubkey: stake, authorizedPubkey: me, toPubkey: thief, lamports: 5_000_000_000 }).instructions;
  const data = new Uint8Array(200);
  data.set(me.toBytes(), 12); // Meta.authorized.staker
  data.set(me.toBytes(), 44); // Meta.authorized.withdrawer
  const acct = (lamports) => ({ lamports, owner: STAKE_PROGRAM, data: [b64encode(data), 'base64'], executable: false });
  const rpc = fakeRpc({ pre: { [me.toBase58()]: walletAccount(1e9), [stake.toBase58()]: acct(5_002_282_880) }, post: { [stake.toBase58()]: acct(2_282_880) } });
  const p = await previewTx(legacyBytes(me, ixs), { owner: me.toBase58(), rpc });
  assert.ok(p.sim.ok);
  assert.equal(p.sol, '0', 'your wallet shows no change');
  assert.ok(p.warnings.some((w) => (w.level === 'danger' || w.level === 'warn') && /stake/i.test(w.text)), `5 SOL leave your stake account for a stranger and plum says:\n${text(p)}`);
});

test('nonce: withdrawing a nonce account you control to an attacker (System 5) gets no warning', async () => {
  const me = pk(), thief = pk(), nonce = pk();
  const ixs = [SystemProgram.nonceWithdraw({ noncePubkey: nonce, authorizedPubkey: me, toPubkey: thief, lamports: 1_000_000_000 })];
  const data = new Uint8Array(80);
  data.set(me.toBytes(), 8);
  const acct = (lamports) => ({ lamports, owner: SystemProgram.programId.toBase58(), data: [b64encode(data), 'base64'], executable: false });
  const rpc = fakeRpc({ pre: { [me.toBase58()]: walletAccount(1e9), [nonce.toBase58()]: acct(1_001_447_680) }, post: { [nonce.toBase58()]: acct(1_447_680) } });
  const p = await previewTx(legacyBytes(me, ixs), { owner: me.toBase58(), rpc });
  assert.ok(p.warnings.some((w) => /nonce/i.test(w.text) && w.level !== 'info'), `1 SOL leaves your nonce account and plum says:\n${text(p)}`);
});

test('mint authority: minting new supply of your token to an attacker (MintTo) gets no warning', async () => {
  const me = pk(), thief = pk(), mint = pk(), dest = pk();
  const ixs = [createMintToInstruction(mint, dest, me, 1_000_000_000_000n)];
  const mintData = new Uint8Array(82);
  mintData.set([1, 0, 0, 0], 0);
  mintData.set(me.toBytes(), 4);
  mintData[44] = 6;
  mintData[45] = 1;
  const mintAcct = { lamports: 1_461_600, owner: TOKEN_PROGRAM, data: [b64encode(mintData), 'base64'], executable: false };
  const rpc = fakeRpc({
    pre: { [me.toBase58()]: walletAccount(1e9), [mint.toBase58()]: mintAcct, [dest.toBase58()]: tokenAccount({ mint: mint.toBase58(), owner: thief.toBase58(), amount: 0n }) },
    post: { [dest.toBase58()]: tokenAccount({ mint: mint.toBase58(), owner: thief.toBase58(), amount: 1_000_000_000_000n }) },
  });
  const p = await previewTx(legacyBytes(me, ixs), { owner: me.toBase58(), rpc });
  assert.ok(p.warnings.some((w) => /mint/i.test(w.text) && w.level !== 'info'), `a trillion of your token are minted to a stranger and plum says:\n${text(p)}`);
});

test('Token-2022: receiving a token whose mint has a permanent delegate (it can be taken back any time) gets no warning', async () => {
  const me = pk(), thief = pk(), mint = pk(), evil = pk();
  const ix = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: pk(), isSigner: false, isWritable: true }], data: Buffer.from([1]) });
  const owner = me.toBase58();
  const sim = {
    fee: 5000, preBalances: [2e9, 1, 1], postBalances: [2e9 - 5000, 1, 1],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner, uiTokenAmount: { amount: '1000000', decimals: 6 } }],
  };
  const rpc = fakeRpc({ pre: { [owner]: walletAccount(2e9), [mint.toBase58()]: mint2022({ authority: thief.toBase58(), extensions: [{ type: EXT.PermanentDelegate, data: [...thief.toBytes()] }] }) }, sim });
  const p = await previewTx(legacyBytes(me, [ix]), { owner, rpc });
  assert.deepEqual(p.tokens.map((t) => t.delta), ['1000000'], 'the preview shows you receiving the token');
  assert.ok(p.warnings.some((w) => /permanent delegate/i.test(w.text)), `plum says:\n${text(p)}`);
});

test('Token-2022: receiving a token with a transfer hook (a program runs on every transfer of it) gets no warning', async () => {
  const me = pk(), hook = pk(), mint = pk(), evil = pk();
  const ix = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: pk(), isSigner: false, isWritable: true }], data: Buffer.from([1]) });
  const owner = me.toBase58();
  const sim = { fee: 5000, preBalances: [2e9, 1, 1], postBalances: [2e9 - 5000, 1, 1], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner, uiTokenAmount: { amount: '5', decimals: 0 } }] };
  const rpc = fakeRpc({ pre: { [owner]: walletAccount(2e9), [mint.toBase58()]: mint2022({ decimals: 0, extensions: [{ type: EXT.TransferHook, data: [...pk().toBytes(), ...hook.toBytes()] }] }) }, sim });
  const p = await previewTx(legacyBytes(me, [ix]), { owner, rpc });
  assert.ok(p.warnings.some((w) => /transfer hook/i.test(w.text)), `plum says:\n${text(p)}`);
});

test('M1 retried: Approve on a token account named only in a lookup table (v0) is caught, directly and when hidden in a CPI', async () => {
  const me = Keypair.generate(), thief = pk(), mint = pk().toBase58(), acct = pk(), evil = pk();
  const table = pk();
  const lookup = { key: table, state: { addresses: [acct, thief], authority: undefined, deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 }, isActive: () => true };
  const tableData = new Uint8Array(56 + 64);
  tableData.set(acct.toBytes(), 56);
  tableData.set(thief.toBytes(), 88);
  const owner = me.publicKey.toBase58();
  const a = acct.toBase58();
  const rpc = fakeRpc({
    pre: { [owner]: walletAccount(1e9), [a]: tokenAccount({ mint, owner, amount: 500n }) },
    post: { [a]: tokenAccount({ mint, owner, amount: 500n, delegate: thief.toBase58(), delegated: 1_000_000n }) },
    lookups: { [table.toBase58()]: { lamports: 1, owner: ALT_PROGRAM, data: [b64encode(tableData), 'base64'], executable: false } },
  });
  const v0 = (ix) => new VersionedTransaction(MessageV0.compile({ payerKey: me.publicKey, recentBlockhash: BLOCKHASH, instructions: [ix], addressLookupTableAccounts: [lookup] })).serialize();
  // directly: the instruction names the account through the table
  const p1 = await previewTx(v0(createApproveInstruction(acct, thief, me.publicKey, 1_000_000n)), { owner, rpc });
  assert.equal(p1.version, 0);
  assert.ok(p1.warnings.some((w) => w.level === 'danger' && /spend tokens/.test(w.text)), `static check through the table: ${text(p1)}`);
  // hidden in another program: only the simulated state of the table-loaded account shows it
  const hidden = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me.publicKey, isSigner: true, isWritable: true }, { pubkey: acct, isSigner: false, isWritable: true }, { pubkey: thief, isSigner: false, isWritable: false }], data: Buffer.from([9]) });
  const p2 = await previewTx(v0(hidden), { owner, rpc });
  assert.ok(p2.warnings.some((w) => w.level === 'danger' && /spend your tokens/.test(w.text)), `state check through the table: ${text(p2)}`);
});

test('M1 retried: a Token-2022 account with extensions (longer than 165 bytes) given away is caught by state', async () => {
  const me = pk(), thief = pk(), mint = pk().toBase58(), acct = pk(), evil = pk();
  const ix = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: acct, isSigner: false, isWritable: true }], data: Buffer.from([1]) });
  const owner = me.toBase58();
  const immutableOwner = [7, 0, 0, 0]; // ImmutableOwner TLV: type 7, length 0
  const pre = { [owner]: walletAccount(1e9), [acct.toBase58()]: tokenAccount({ mint, owner, amount: 9n, program: TOKEN_2022_PROGRAM, extensions: immutableOwner }) };
  const post = { [acct.toBase58()]: tokenAccount({ mint, owner: thief.toBase58(), amount: 9n, program: TOKEN_2022_PROGRAM, extensions: immutableOwner }) };
  const p = await previewTx(legacyBytes(me, [ix]), { owner, rpc: fakeRpc({ pre, post }) });
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /becomes theirs/.test(w.text)), text(p));
  assert.deepEqual(p.tokens.map((t) => t.delta), ['-9']);
});

test('M1 retried: raising the allowance of a delegate you already have is caught', async () => {
  const me = pk(), thief = pk(), mint = pk().toBase58(), acct = pk(), evil = pk();
  const ix = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: acct, isSigner: false, isWritable: true }], data: Buffer.from([1]) });
  const owner = me.toBase58();
  const pre = { [owner]: walletAccount(1e9), [acct.toBase58()]: tokenAccount({ mint, owner, amount: 500n, delegate: thief.toBase58(), delegated: 1n }) };
  const post = { [acct.toBase58()]: tokenAccount({ mint, owner, amount: 500n, delegate: thief.toBase58(), delegated: 500n }) };
  const p = await previewTx(legacyBytes(me, [ix]), { owner, rpc: fakeRpc({ pre, post }) });
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /spend your tokens/.test(w.text)), text(p));
});

test('wrapped SOL: closing your wSOL account into an attacker shows the SOL leaving and a warning', async () => {
  const me = pk(), thief = pk(), wsol = pk();
  const ix = createCloseAccountInstruction(wsol, thief, me);
  const owner = me.toBase58();
  const sim = { fee: 5000, preBalances: [1e9, 10_002_039_280, 0], postBalances: [1e9 - 5000, 0, 10_002_039_280], preTokenBalances: [{ accountIndex: 1, mint: WSOL_MINT, owner, uiTokenAmount: { amount: '10000000000', decimals: 9 } }], postTokenBalances: [] };
  const p = await previewTx(legacyBytes(me, [ix]), { owner, rpc: fakeRpc({ pre: { [owner]: walletAccount(1e9) }, sim }) });
  assert.equal(p.sol, String(-10_000_000_000 - 5000));
  assert.ok(p.warnings.some((w) => /closes your token account/.test(w.text)), text(p));
});

test('a mint you are the authority of handed to someone else (SetAuthority MintTokens) is caught', async () => {
  const me = pk(), thief = pk(), mint = pk();
  const ix = createSetAuthorityInstruction(mint, me, AuthorityType.MintTokens, thief);
  const p = await previewTx(legacyBytes(me, [ix]), { owner: me.toBase58(), rpc: fakeRpc({ pre: { [me.toBase58()]: walletAccount(1e9) } }) });
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /SetAuthority/.test(w.text)), text(p));
});

test('the "taken off an account" check is evaded by a program that keeps your key elsewhere in the data (known limit, documented)', async () => {
  const me = pk(), thief = pk(), asset = pk(), evil = pk();
  const ix = new TransactionInstruction({ programId: evil, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: asset, isSigner: false, isWritable: true }], data: Buffer.from([3]) });
  const before = new Uint8Array(120); before.set(me.toBytes(), 8);
  const after = new Uint8Array(120); after.set(thief.toBytes(), 8); after.set(me.toBytes(), 80); // "previous authority" field
  const acct = (d) => ({ lamports: 3e6, owner: evil.toBase58(), data: [b64encode(d), 'base64'], executable: false });
  const p = await previewTx(legacyBytes(me, [ix]), { owner: me.toBase58(), rpc: fakeRpc({ pre: { [me.toBase58()]: walletAccount(1e9), [asset.toBase58()]: acct(before) }, post: { [asset.toBase58()]: acct(after) } }) });
  // only the generic "unknown program gets your signature" info line remains
  assert.ok(!p.warnings.some((w) => w.level === 'danger'));
  assert.ok(p.warnings.some((w) => w.level === 'info' && /doesn't know/.test(w.text)));
  void Transaction; void PublicKey; void base58Decode;
});
