// Native staking: the instructions plum builds, checked against @solana/web3.js's StakeProgram and SystemProgram (a
// test-only oracle); real stake accounts from mainnet read as the RPC reads them, and their state worked out as the
// stake program does; validators ranked; and each staking step planned only when the chain allows it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Authorized, Keypair, Lockup, PublicKey, StakeProgram, SystemProgram } from '@solana/web3.js';
import { base58Decode } from '../src/shared/base58.js';
import { b64encode, u32le, u64le } from '../src/shared/bytes.js';
import { compileLegacy, readMessage } from '../src/shared/tx.js';
import {
  COOLDOWN_FEATURE, STAKE_HISTORY, STAKE_PROGRAM, VOTE_PROGRAM, activation, addressWithSeed, newRateEpoch, plan, rankValidators, readStakeAccount,
  readStakeHistory, readValidatorInfo, stakeIx, stakeSeed, stateOf,
} from '../src/background/stake.js';

const STAKES = JSON.parse(readFileSync(new URL('./fixtures/stake-mainnet.json', import.meta.url), 'utf8'));
const INFOS = JSON.parse(readFileSync(new URL('./fixtures/validator-info-mainnet.json', import.meta.url), 'utf8'));
const key = () => Keypair.generate().publicKey;
const MAX = (1n << 64n) - 1n;
const same = (ours, theirs) => {
  assert.equal(ours.programId, theirs.programId.toBase58());
  assert.deepEqual(ours.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), theirs.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  assert.equal(Buffer.from(ours.data).toString('hex'), Buffer.from(theirs.data).toString('hex'));
};

test('the stake account address: createWithSeed, as web3.js derives it', async () => {
  for (let i = 0; i < 20; i++) {
    const wallet = key();
    const theirs = await PublicKey.createWithSeed(wallet, stakeSeed(i), StakeProgram.programId);
    assert.equal(addressWithSeed(wallet.toBase58(), stakeSeed(i), STAKE_PROGRAM), theirs.toBase58());
  }
  assert.throws(() => addressWithSeed(key().toBase58(), 'x'.repeat(33), STAKE_PROGRAM), /32 bytes/);
});

test("plum's staking instructions are exactly web3.js's", () => {
  const wallet = key(), vote = key();
  const seed = stakeSeed(3);
  const account = addressWithSeed(wallet.toBase58(), seed, STAKE_PROGRAM);
  const created = StakeProgram.createAccountWithSeed({
    fromPubkey: wallet, stakePubkey: new PublicKey(account), basePubkey: wallet, seed, lamports: 1_002_282_880,
    authorized: new Authorized(wallet, wallet), lockup: new Lockup(0, 0, PublicKey.default),
  });
  same(stakeIx.createWithSeed(wallet.toBase58(), account, seed, 1_002_282_880n), created.instructions[0]);
  same(stakeIx.initialize(account, wallet.toBase58()), created.instructions[1]);
  same(stakeIx.delegate(account, vote.toBase58(), wallet.toBase58()), StakeProgram.delegate({ stakePubkey: new PublicKey(account), authorizedPubkey: wallet, votePubkey: vote }).instructions[0]);
  same(stakeIx.deactivate(account, wallet.toBase58()), StakeProgram.deactivate({ stakePubkey: new PublicKey(account), authorizedPubkey: wallet }).instructions[0]);
  same(stakeIx.withdraw(account, wallet.toBase58(), 5_000_000_000n), StakeProgram.withdraw({ stakePubkey: new PublicKey(account), authorizedPubkey: wallet, toPubkey: wallet, lamports: 5_000_000_000 }).instructions[0]);
  // created from the wallet alone: the base is the funder, so the account needs no key of its own
  assert.equal(created.instructions[0].keys.filter((k) => k.isSigner).length, 1);
  void SystemProgram;
});

test('real stake accounts read as the RPC reads them, and their state as the stake program works it out', () => {
  const history = readStakeHistory({ data: [STAKES.stakeHistory, 'base64'] });
  assert.equal(history.size, 512);
  const newRate = newRateEpoch({ data: [STAKES.cooldownFeature, 'base64'] }, STAKES.epochInfo.slotsInEpoch);
  assert.equal(newRate, 565n, 'mainnet cut warmup and cooldown to 9% at epoch 565');
  const epoch = BigInt(STAKES.epochInfo.epoch);
  const states = STAKES.accounts.map((a) => {
    const s = readStakeAccount(a.account);
    const p = a.parsed;
    assert.equal(s.kind, 'delegated');
    assert.deepEqual([s.staker, s.withdrawer, s.rentReserve.toString()], [p.meta.authorized.staker, p.meta.authorized.withdrawer, p.meta.rentExemptReserve]);
    assert.deepEqual([s.delegation.vote, s.delegation.stake.toString(), s.delegation.activationEpoch.toString(), s.delegation.deactivationEpoch.toString()],
      [p.stake.delegation.voter, p.stake.delegation.stake, p.stake.delegation.activationEpoch, p.stake.delegation.deactivationEpoch]);
    assert.deepEqual([s.lockup.epoch.toString(), s.lockup.custodian], [String(p.meta.lockup.epoch), p.meta.lockup.custodian]);
    return stateOf(s, epoch, history, newRate);
  });
  // the fifth was delegated and deactivated in the same epoch: no stake at all, withdrawable at once
  assert.deepEqual(states.map((s) => s.state), ['active', 'active', 'activating', 'activating', 'deactivating', 'inactive', 'inactive', 'inactive']);
  const stakeOf = (i) => readStakeAccount(STAKES.accounts[i].account).delegation.stake;
  assert.equal(states[0].effective, stakeOf(0));
  assert.equal(states[2].activating, stakeOf(2));
  assert.equal(states[4].deactivating, stakeOf(4));
  assert.equal(readStakeAccount({ ...STAKES.accounts[0].account, owner: VOTE_PROGRAM }), null, "another program's account isn't a stake account");
});

test('warmup and cooldown are limited by the network, as the stake program does it', () => {
  const del = (stake, act, deact = MAX) => ({ vote: 'x', stake, activationEpoch: act, deactivationEpoch: deact });
  const h = (entries) => new Map(entries.map(([e, effective, activating, deactivating]) => [BigInt(e), { effective, activating, deactivating }]));
  // bootstrap stake is effective at once; delegated and undelegated in one epoch is none at all
  assert.deepEqual(activation(del(500n, MAX), 7n, new Map()), { effective: 500n, activating: 0n, deactivating: 0n });
  assert.deepEqual(activation(del(500n, 4n, 4n), 9n, new Map()), { effective: 0n, activating: 0n, deactivating: 0n });
  // all activating in its first epoch, nothing before it
  assert.deepEqual(activation(del(500n, 10n), 10n, new Map()), { effective: 0n, activating: 500n, deactivating: 0n });
  assert.deepEqual(activation(del(500n, 10n), 9n, new Map()), { effective: 0n, activating: 0n, deactivating: 0n });
  // a busy network: 1000 effective and 1000 activating at epoch 10, so at 25% only 250 more can turn on each epoch
  const busy = h([[10, 1000n, 1000n, 0n], [11, 1250n, 750n, 0n]]);
  assert.deepEqual(activation(del(1000n, 10n), 11n, busy, null), { effective: 250n, activating: 750n, deactivating: 0n });
  assert.deepEqual(activation(del(1000n, 10n), 12n, busy, null), { effective: 562n, activating: 438n, deactivating: 0n });
  // the 9% rate from epoch 11 on
  assert.deepEqual(activation(del(1000n, 10n), 11n, busy, 11n), { effective: 90n, activating: 910n, deactivating: 0n });
  // a quiet network: fully on the next epoch; no history at all counts as fully on
  assert.deepEqual(activation(del(1000n, 10n), 11n, h([[10, 1_000_000n, 1000n, 0n]]), 0n), { effective: 1000n, activating: 0n, deactivating: 0n });
  assert.deepEqual(activation(del(1000n, 10n), 50n, new Map()), { effective: 1000n, activating: 0n, deactivating: 0n });
  // deactivating: all of it in the epoch it was deactivated, then limited by the network's cooldown (the history's
  // entry for the epoch a stake turned on always counts that stake as turning on)
  assert.deepEqual(activation(del(1000n, 1n, 20n), 20n, h([[1, 1_000_000_000n, 1000n, 0n]])), { effective: 1000n, activating: 0n, deactivating: 1000n });
  const cooling = h([[1, 1_000_000n, 1000n, 0n], [20, 1000n, 0n, 1000n], [21, 750n, 0n, 750n]]);
  assert.deepEqual(activation(del(1000n, 1n, 20n), 21n, cooling, null), { effective: 750n, activating: 0n, deactivating: 750n });
  assert.deepEqual(activation(del(1000n, 1n, 20n), 22n, cooling, null), { effective: 563n, activating: 0n, deactivating: 563n });
  assert.equal(stateOf({ delegation: del(1000n, 1n, 20n) }, 21n, cooling, null).state, 'deactivating');
  assert.equal(stateOf({ delegation: null }, 21n, cooling, null).state, 'undelegated');
});

test("validators' published names: read from the validator-info program, drawn in plum's type", () => {
  const read = INFOS.map((i) => readValidatorInfo(i.account));
  assert.equal(read[0].name, INFOS[0].name);
  assert.equal(read[0].identity.length >= 32, true);
  assert.ok(read[1].name && !/\p{Extended_Pictographic}|️/u.test(read[1].name), `no pictographs: ${read[1].name}`);
  assert.ok([...read[2].name].length <= 32);
  assert.equal(read[3], null, 'no name, nothing to show');
  assert.equal(readValidatorInfo({ data: [b64encode(new Uint8Array(643)), 'base64'] }), null);
});

test('validators ranked: voting, not skipping, not keeping it all, by what stakers earn; the biggest after the rest', () => {
  const v = (n, { stake = 1000, commission = 5, credits = 6_900_000, delinquent = false, bps = undefined } = {}) => ({
    vote: key().toBase58(), node: key().toBase58(), n,
    row: { votePubkey: '', nodePubkey: '', activatedStake: stake, commission, epochVoteAccount: true, epochCredits: [[98, 1, 0], [99, 1_000_000 + credits, 1_000_000], [100, 5, 0]], ...(bps != null ? { inflationRewardsCommissionBps: bps } : {}) },
    delinquent,
  });
  const vs = [
    v('cheap', { commission: 0 }), v('fair', { commission: 5 }), v('pricey', { commission: 10 }), v('greedy', { commission: 100 }),
    v('asleep', { commission: 0, delinquent: true }), v('skips', { commission: 0 }), v('whale', { commission: 0, stake: 100_000 }),
    v('slow', { commission: 0, credits: 3_000_000 }), v('bps', { commission: 0, bps: 700 }),
  ];
  for (const x of vs) Object.assign(x.row, { votePubkey: x.vote, nodePubkey: x.node });
  const votes = { current: vs.filter((x) => !x.delinquent).map((x) => x.row), delinquent: vs.filter((x) => x.delinquent).map((x) => x.row) };
  const skipper = vs.find((x) => x.n === 'skips');
  const production = { value: { byIdentity: { [skipper.node]: [40, 20], [vs[0].node]: [40, 40] } } };
  const names = new Map(vs.map((x) => [x.node, x.n]));
  const ranked = rankValidators({ votes, production, names, epoch: 100 });
  assert.deepEqual(ranked.map((r) => r.name), ['cheap', 'fair', 'bps', 'pricey', 'slow', 'whale', 'skips', 'greedy', 'asleep']);
  const by = Object.fromEntries(ranked.map((r) => [r.name, r]));
  assert.equal(by.whale.large, true);
  assert.equal(by.whale.suggested, true, 'a big validator is still fine, just after the rest');
  assert.deepEqual([by.skips.suggested, by.greedy.suggested, by.asleep.suggested], [false, false, false]);
  assert.match(by.skips.why.join(), /skips 50%/);
  assert.match(by.greedy.why.join(), /keeps all rewards/);
  assert.match(by.asleep.why.join(), /not voting/);
  assert.equal(by.bps.commission, 7, 'the basis-point commission wins when the RPC gives it');
  assert.equal(by.cheap.skip, 0);
  assert.equal(by.fair.skip, null, 'too few leader slots to tell');
  assert.equal(by.cheap.credits, 6_900_000);
});

/* ------------------------------------------------------------ planning a step */

const WALLET = key().toBase58();
const VOTE = key().toBase58();
const stakeData = ({ kind = 2, staker = WALLET, withdrawer = WALLET, act = 5n, deact = MAX, stake = 2_000_000_000n, lockupEpoch = 0n } = {}) => {
  const d = new Uint8Array(200);
  d.set(u32le(kind), 0);
  d.set(u64le(1_666_240n), 4);
  d.set(base58Decode(staker), 12);
  d.set(base58Decode(withdrawer), 44);
  d.set(u64le(lockupEpoch), 84);
  if (kind === 2) {
    d.set(base58Decode(VOTE), 124);
    d.set(u64le(stake), 156);
    d.set(u64le(act), 164);
    d.set(u64le(deact), 172);
  }
  return { lamports: Number(stake + 1_666_240n), owner: STAKE_PROGRAM, data: [b64encode(d), 'base64'], executable: false };
};

/** A stand-in RPC for planning: accounts by address, an epoch, the network's minimum and rent. */
function planRpc(accounts = {}, { epoch = 10, minimum = 1_000_000_000 } = {}) {
  return {
    async accounts(addrs) { return addrs.map((a) => accounts[a] ?? null); },
    async call(method) {
      if (method === 'getStakeMinimumDelegation') return { context: { slot: 1 }, value: minimum };
      if (method === 'getMinimumBalanceForRentExemption') return 1_666_240;
      if (method === 'getEpochInfo') return { epoch, slotIndex: 1000, slotsInEpoch: 432000 };
      throw new Error(`no ${method}`);
    },
  };
}
const voteAccount = { lamports: 1e9, owner: VOTE_PROGRAM, data: ['', 'base64'], executable: false };
const walletWith = (sol) => ({ lamports: sol * 1e9, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false });

test('staking: a new stake account at the first free seed, delegated, all from your wallet alone', async () => {
  const taken = addressWithSeed(WALLET, stakeSeed(0), STAKE_PROGRAM);
  const rpc = planRpc({ [VOTE]: voteAccount, [WALLET]: walletWith(10), [taken]: stakeData() });
  const p = await plan(rpc, WALLET, { action: 'stake', vote: VOTE, amount: '2.5' });
  const account = addressWithSeed(WALLET, stakeSeed(1), STAKE_PROGRAM);
  assert.equal(p.summary.account, account, 'seed 0 is in use, so seed 1');
  assert.equal(p.summary.stake, '2500000000');
  assert.equal(p.summary.lamports, String(2_500_000_000 + 1_666_240), 'the stake plus the rent the account keeps');
  assert.deepEqual(p.instructions.map((i) => [i.programId, i.data[0]]), [['11111111111111111111111111111111', 3], [STAKE_PROGRAM, 0], [STAKE_PROGRAM, 2]]);
  const m = readMessage(compileLegacy({ payer: WALLET, blockhash: VOTE, instructions: p.instructions }));
  assert.equal(m.required, 1);
  assert.deepEqual(m.keys.slice(0, 1), [WALLET]);
});

test('staking is refused when the chain says no: not a vote account, under the minimum, more than you have', async () => {
  const rpc = planRpc({ [VOTE]: voteAccount, [WALLET]: walletWith(3) });
  await assert.rejects(plan(rpc, WALLET, { action: 'stake', vote: WALLET, amount: '1' }), /isn't a validator's vote account/);
  await assert.rejects(plan(rpc, WALLET, { action: 'stake', vote: 'not an address', amount: '1' }), /pick a validator/);
  await assert.rejects(plan(rpc, WALLET, { action: 'stake', vote: VOTE, amount: '0.5' }), /smallest stake is 1 SOL/);
  await assert.rejects(plan(rpc, WALLET, { action: 'stake', vote: VOTE, amount: '2.999' }), /you have 3 SOL/);
  await assert.rejects(plan(rpc, WALLET, { action: 'stake', vote: VOTE, amount: '0' }), /above zero/);
  const max = await plan(rpc, WALLET, { action: 'stake', vote: VOTE, max: true });
  assert.equal(max.summary.stake, String(3e9 - 1_666_240 - 5_000_000), 'everything but the rent and a little for later fees');
  const full = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [addressWithSeed(WALLET, stakeSeed(i), STAKE_PROGRAM), stakeData()]));
  await assert.rejects(plan(planRpc({ ...full, [VOTE]: voteAccount, [WALLET]: walletWith(9) }), WALLET, { action: 'stake', vote: VOTE, amount: '1' }), /all 32/);
});

test('unstaking and withdrawing: only your own accounts, only when the stake program would allow it', async () => {
  const A = key().toBase58();
  const at = (acc, opts) => planRpc({ [A]: acc, [STAKE_HISTORY]: null, [COOLDOWN_FEATURE]: null }, opts);
  const un = await plan(at(stakeData()), WALLET, { action: 'unstake', account: A });
  assert.deepEqual(un.instructions.map((i) => i.data[0]), [5]);
  assert.equal(un.summary.vote, VOTE);
  await assert.rejects(plan(at(stakeData({ staker: key().toBase58() })), WALLET, { action: 'unstake', account: A }), /isn't the stake account's staker/);
  await assert.rejects(plan(at(stakeData({ deact: 10n })), WALLET, { action: 'unstake', account: A }), /already unstaking/);
  await assert.rejects(plan(at(stakeData()), WALLET, { action: 'withdraw', account: A }), /unstake it first/);
  await assert.rejects(plan(at(stakeData({ deact: 10n })), WALLET, { action: 'withdraw', account: A }), /still unstaking/);
  const out = await plan(at(stakeData({ deact: 9n })), WALLET, { action: 'withdraw', account: A });
  assert.deepEqual(out.instructions.map((i) => [i.data[0], i.keys[1].pubkey]), [[4, WALLET]], 'everything, to your wallet');
  assert.equal(out.summary.lamports, String(2_000_000_000 + 1_666_240));
  await assert.rejects(plan(at(stakeData({ deact: 9n, withdrawer: key().toBase58() })), WALLET, { action: 'withdraw', account: A }), /isn't the stake account's withdrawer/);
  await assert.rejects(plan(at(stakeData({ deact: 9n, lockupEpoch: 400n })), WALLET, { action: 'withdraw', account: A }), /locked up until epoch 400/);
  const never = await plan(at(stakeData({ kind: 1 })), WALLET, { action: 'withdraw', account: A });
  assert.equal(never.summary.vote, null);
  await assert.rejects(plan(at(voteAccount), WALLET, { action: 'withdraw', account: A }), /isn't a stake account/);
  await assert.rejects(plan(at(stakeData()), WALLET, { action: 'drain', account: A }), /unknown staking step/);
});
