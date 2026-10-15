// Native staking: SOL delegated to a validator through a stake account of your own. plum makes that account with
// createAccountWithSeed, at an address derived from your wallet and a seed, so your wallet is the only signer of every
// staking transaction (a fresh stake account keypair would be a second one). Validators are read from the chain itself
// (getVoteAccounts, getBlockProduction) and named by what they publish in the validator-info program; your stake
// accounts are found by their staker or withdrawer, and their state is worked out here the way the runtime does it.
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode, isAddress } from '../shared/base58.js';
import { b64decode, concat, readU32, readU64, u32le, u64le, utf8 } from '../shared/bytes.js';
import { formatUnits, parseUnits, short } from '../shared/format.js';
import { plainName } from '../shared/text.js';
import { SYSTEM_PROGRAM, base58Decode32 } from '../shared/tx.js';
import { local } from './store.js';

export const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';
export const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111';
export const CONFIG_PROGRAM = 'Config1111111111111111111111111111111111111';
export const VALIDATOR_INFO = 'Va1idator1nfo111111111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const RENT = 'SysvarRent111111111111111111111111111111111';
export const STAKE_HISTORY = 'SysvarStakeHistory1111111111111111111111111';
/** The feature that cut stake warmup and cooldown from 25% to 9% of the network's stake an epoch. */
export const COOLDOWN_FEATURE = 'GwtDQBghCTBgmX2cpEGNPxTEBUTQRaDMGTr5qychdGMj';
/** A stake account's size. */
export const STAKE_SPACE = 200;
const NO_EPOCH = (1n << 64n) - 1n;
/** How many seeds plum looks through for a free stake account address. */
const SEEDS = 32;
/** SOL left in the wallet after staking "everything", for the fees of unstaking and withdrawing later. */
export const KEEP_FOR_FEES = 5_000_000n;
/** Validator names are read again after this long. */
const NAMES_FOR_MS = 3 * 24 * 3600 * 1000;

const fail = (message) => new Error(message);
const dataOf = (acc) => (typeof acc?.data?.[0] === 'string' ? b64decode(acc.data[0]) : new Uint8Array(0));
const key = (d, at) => base58Encode(d.subarray(at, at + 32));

/** The address createAccountWithSeed makes: sha256(base, seed, program). */
export function addressWithSeed(base, seed, program) {
  if (utf8(seed).length > 32) throw fail('a seed is 32 bytes at most');
  return base58Encode(sha256(concat(base58Decode32(base), utf8(seed), base58Decode32(program))));
}

/** The seed of plum's stake account number `n` for a wallet (the same scheme other wallets use). */
export const stakeSeed = (n) => `stake:${n}`;

/* ------------------------------------------------------------ instructions (your wallet signs them all) */

const signer = (pubkey) => ({ pubkey, isSigner: true, isWritable: true });
const writable = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });

export const stakeIx = {
  /** System CreateAccountWithSeed (3), with your wallet as both the funder and the base. */
  createWithSeed: (wallet, account, seed, lamports) => ({
    programId: SYSTEM_PROGRAM,
    keys: [signer(wallet), writable(account)],
    data: concat(u32le(3), base58Decode32(wallet), u64le(utf8(seed).length), utf8(seed), u64le(lamports), u64le(STAKE_SPACE), base58Decode32(STAKE_PROGRAM)),
  }),
  /** Stake Initialize (0): your wallet as staker and withdrawer, no lockup. */
  initialize: (account, wallet) => ({
    programId: STAKE_PROGRAM,
    keys: [writable(account), readonly(RENT)],
    data: concat(u32le(0), base58Decode32(wallet), base58Decode32(wallet), u64le(0), u64le(0), base58Decode32(SYSTEM_PROGRAM)),
  }),
  /** Stake DelegateStake (2). */
  delegate: (account, vote, wallet) => ({
    programId: STAKE_PROGRAM,
    keys: [writable(account), readonly(vote), readonly(CLOCK), readonly(STAKE_HISTORY), readonly(STAKE_CONFIG), { pubkey: wallet, isSigner: true, isWritable: false }],
    data: u32le(2),
  }),
  /** Stake Deactivate (5). */
  deactivate: (account, wallet) => ({
    programId: STAKE_PROGRAM,
    keys: [writable(account), readonly(CLOCK), { pubkey: wallet, isSigner: true, isWritable: false }],
    data: u32le(5),
  }),
  /** Stake Withdraw (4), to your wallet. */
  withdraw: (account, wallet, lamports) => ({
    programId: STAKE_PROGRAM,
    keys: [writable(account), writable(wallet), readonly(CLOCK), readonly(STAKE_HISTORY), { pubkey: wallet, isSigner: true, isWritable: false }],
    data: concat(u32le(4), u64le(lamports)),
  }),
};

/* ------------------------------------------------------------ reading stake accounts */

/**
 * A stake account's fields from its bytes, or null when it isn't one: { kind ('initialized' | 'delegated'),
 * rentReserve, staker, withdrawer, lockup: { unixTimestamp, epoch, custodian }, delegation: { vote, stake,
 * activationEpoch, deactivationEpoch } | null }.
 */
export function readStakeAccount(acc) {
  if (!acc || acc.owner !== STAKE_PROGRAM) return null;
  const d = dataOf(acc);
  if (d.length < STAKE_SPACE) return null;
  const tag = readU32(d, 0);
  if (tag !== 1 && tag !== 2) return null;
  const ts = readU64(d, 76);
  const out = {
    kind: tag === 2 ? 'delegated' : 'initialized',
    rentReserve: readU64(d, 4),
    staker: key(d, 12),
    withdrawer: key(d, 44),
    // a signed i64: a time before 1970 is no lockup
    lockup: { unixTimestamp: ts >= 1n << 63n ? 0n : ts, epoch: readU64(d, 84), custodian: key(d, 92) },
    delegation: null,
  };
  if (tag === 2) out.delegation = { vote: key(d, 124), stake: readU64(d, 156), activationEpoch: readU64(d, 164), deactivationEpoch: readU64(d, 172) };
  return out;
}

/** The stake history sysvar: Map(epoch -> { effective, activating, deactivating }), newest first on chain. */
export function readStakeHistory(acc) {
  const d = dataOf(acc);
  const out = new Map();
  if (d.length < 8) return out;
  const n = Math.min(Number(readU64(d, 0)), Math.floor((d.length - 8) / 32));
  for (let i = 0; i < n; i++) {
    const at = 8 + 32 * i;
    out.set(readU64(d, at), { effective: readU64(d, at + 8), activating: readU64(d, at + 16), deactivating: readU64(d, at + 24) });
  }
  return out;
}

/** The epoch from which warmup and cooldown run at 9% (a feature account's activation slot, over the epoch length). */
export function newRateEpoch(featureAcc, slotsPerEpoch) {
  const d = dataOf(featureAcc);
  if (d.length < 9 || d[0] !== 1 || !slotsPerEpoch) return null;
  return readU64(d, 1) / BigInt(slotsPerEpoch);
}

/**
 * How much of an account's stake may turn on (or off) in `epoch`: its share of what the network allows, which is 25%
 * of the network's effective stake an epoch (9% from the feature's epoch), split over everything turning on (or off).
 * Integer math, as the stake program does it.
 */
function allowance(epoch, account, clusterPortion, clusterEffective, newRate) {
  if (!account || !clusterPortion || !clusterEffective) return 0n;
  const bps = newRate != null && epoch >= newRate ? 900n : 2500n;
  const delta = (account * clusterEffective * bps) / (clusterPortion * 10_000n);
  return delta < account ? delta : account;
}

/** (effective, activating) for a delegation at `target`, as the stake program works it out. */
function effectiveAndActivating(del, target, history, newRate) {
  const { stake, activationEpoch: act, deactivationEpoch: deact } = del;
  if (act === NO_EPOCH) return [stake, 0n];
  if (act === deact) return [0n, 0n];
  if (target === act) return [0n, stake];
  if (target < act) return [0n, 0n];
  let prevEpoch = act;
  let prev = history.get(act);
  if (!prev) return [stake, 0n];
  let effective = 0n;
  for (;;) {
    const epoch = prevEpoch + 1n;
    if (prev.activating === 0n) break;
    const grown = allowance(epoch, stake - effective, prev.activating, prev.effective, newRate);
    effective += grown > 0n ? grown : 1n;
    if (effective >= stake) { effective = stake; break; }
    if (epoch >= target || epoch >= deact) break;
    const next = history.get(epoch);
    if (!next) break;
    prevEpoch = epoch;
    prev = next;
  }
  return [effective, stake - effective];
}

/**
 * A delegation's stake at `target`: { effective, activating, deactivating } in lamports, as the stake program works it
 * out from the network's stake history (warmup and cooldown are limited to a share of the network's stake an epoch).
 */
export function activation(del, target, history, newRate = null) {
  const [effective, activating] = effectiveAndActivating(del, target, history, newRate);
  if (target < del.deactivationEpoch) return { effective, activating, deactivating: 0n };
  if (target === del.deactivationEpoch) return { effective, activating: 0n, deactivating: effective };
  let prevEpoch = del.deactivationEpoch;
  let prev = history.get(prevEpoch);
  if (!prev) return { effective: 0n, activating: 0n, deactivating: 0n };
  let left = effective;
  for (;;) {
    const epoch = prevEpoch + 1n;
    if (prev.deactivating === 0n) break;
    const gone = allowance(epoch, left, prev.deactivating, prev.effective, newRate);
    const step = gone > 0n ? gone : 1n;
    left = left > step ? left - step : 0n;
    if (left === 0n || epoch >= target) break;
    const next = history.get(epoch);
    if (!next) break;
    prevEpoch = epoch;
    prev = next;
  }
  return { effective: left, activating: 0n, deactivating: left };
}

/**
 * What a stake account is doing now, in a word: 'activating' (starts earning next epoch), 'active', 'deactivating'
 * (stops at the end of this epoch), 'inactive' (withdrawable) or 'undelegated' (never delegated, withdrawable).
 */
export function stateOf(acc, epoch, history, newRate) {
  if (!acc.delegation) return { state: 'undelegated', effective: 0n, activating: 0n, deactivating: 0n };
  const a = activation(acc.delegation, epoch, history, newRate);
  let state = 'inactive';
  if (a.deactivating > 0n) state = 'deactivating';
  else if (a.activating > 0n) state = 'activating';
  else if (a.effective > 0n) state = 'active';
  return { state, ...a };
}

/** Is the account's lockup still on? (Only its custodian could withdraw before then, and plum never signs as one.) */
export function lockedUp(acc, { epoch, now = Math.floor(Date.now() / 1000) }) {
  const l = acc.lockup;
  return l.unixTimestamp > BigInt(now) || l.epoch > epoch;
}

/* ------------------------------------------------------------ validators */

/** A validator-info account (Config program): { identity, name } from its keys and JSON, or null. */
export function readValidatorInfo(acc) {
  const d = dataOf(acc);
  // two config keys (the validator-info key, then the validator's identity, which signed), then the JSON as a
  // bincode string (u64 length, then the bytes)
  if (d.length < 75 || d[0] !== 2 || key(d, 1) !== VALIDATOR_INFO) return null;
  const len = Number(readU64(d, 67));
  if (len > d.length - 75) return null;
  let info;
  try { info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(d.subarray(75, 75 + len))); } catch { return null; }
  const name = typeof info?.name === 'string' ? plainName(info.name, 32) : '';
  return name ? { identity: key(d, 34), name } : null;
}

/** Validators' published names, Map(identity -> name), read from the chain at most every few days and kept. */
export async function validatorNames(rpc, network) {
  const kept = await local.get('validatorNames', null);
  if (kept?.network === network && Date.now() - kept.at < NAMES_FOR_MS && kept.names) return new Map(Object.entries(kept.names));
  let list;
  try {
    list = await rpc.call('getProgramAccounts', [CONFIG_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 1, bytes: VALIDATOR_INFO } }] }], { timeout: 30_000, retries: 1 });
  } catch {
    // an RPC that won't list them (a public one): addresses only, and the old names if there are any
    return new Map(Object.entries(kept?.network === network ? kept.names ?? {} : {}));
  }
  const names = {};
  for (const item of Array.isArray(list) ? list : []) {
    const v = readValidatorInfo(item?.account);
    if (v) names[v.identity] = v.name;
  }
  await local.set({ validatorNames: { network, at: Date.now(), names } });
  return new Map(Object.entries(names));
}

/** A validator's commission in percent: the newer basis-point field when the RPC gives it. */
const commissionOf = (v) => (Number.isFinite(v.inflationRewardsCommissionBps) ? v.inflationRewardsCommissionBps / 100 : Number(v.commission ?? 100));

/** Vote credits earned in the last whole epoch (what the validator's voting earned its stakers). */
function lastCredits(v, epoch) {
  const list = Array.isArray(v.epochCredits) ? v.epochCredits : [];
  const e = list.find((c) => Array.isArray(c) && Number(c[0]) === epoch - 1) ?? list.filter((c) => Array.isArray(c) && Number(c[0]) < epoch).at(-1);
  return e ? Math.max(0, Number(e[1]) - Number(e[2])) : 0;
}

/** A skipped share above this, over enough leader slots to tell, keeps a validator off the suggestions. */
export const MAX_SKIP = 0.1;
const MIN_LEADER_SLOTS = 12;

/**
 * Validators ranked for staking: every one, each { vote, identity, name, commission, skip, stake, credits, delinquent,
 * large, suggested, why }. Suggested ones first: voting (not delinquent), not skipping blocks, commission under 100%,
 * by what their stakers earn (last epoch's vote credits after commission), with the few validators that together hold
 * a third of all stake after the rest (stake spread out keeps the network safe).
 */
export function rankValidators({ votes, production = null, names = new Map(), epoch }) {
  const all = [...(votes?.current ?? []).map((v) => ({ v, delinquent: false })), ...(votes?.delinquent ?? []).map((v) => ({ v, delinquent: true }))]
    .filter(({ v }) => isAddress(v?.votePubkey) && isAddress(v?.nodePubkey));
  const total = all.reduce((n, { v }) => n + BigInt(v.activatedStake ?? 0), 0n);
  // the superminority: the biggest validators that together hold a third of the stake
  const large = new Set();
  let held = 0n;
  for (const { v } of [...all].sort((a, b) => (BigInt(b.v.activatedStake ?? 0) > BigInt(a.v.activatedStake ?? 0) ? 1 : -1))) {
    if (held * 3n > total) break;
    held += BigInt(v.activatedStake ?? 0);
    large.add(v.votePubkey);
  }
  const by = production?.value?.byIdentity ?? production?.byIdentity ?? {};
  const out = all.map(({ v, delinquent }) => {
    const commission = commissionOf(v);
    const slots = Array.isArray(by[v.nodePubkey]) ? by[v.nodePubkey] : null;
    const skip = slots && slots[0] >= MIN_LEADER_SLOTS ? 1 - slots[1] / slots[0] : null;
    const credits = lastCredits(v, epoch);
    const why = [];
    if (delinquent) why.push('not voting');
    if (v.epochVoteAccount === false) why.push('not voting this epoch');
    if (commission >= 100) why.push('keeps all rewards');
    if (skip != null && skip > MAX_SKIP) why.push(`skips ${(skip * 100).toFixed(0)}% of its blocks`);
    return {
      vote: v.votePubkey, identity: v.nodePubkey, name: names.get(v.nodePubkey) ?? null, commission, skip, stake: String(v.activatedStake ?? 0),
      credits, delinquent, large: large.has(v.votePubkey), suggested: !why.length, why, score: credits * (100 - Math.min(100, commission)),
    };
  });
  const rank = (x) => (x.suggested ? (x.large ? 1 : 0) : x.delinquent ? 3 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.score - a.score || (BigInt(b.stake) > BigInt(a.stake) ? 1 : -1)).map(({ score, ...x }) => x);
}

/** The network's smallest stake (lamports; 1 SOL if the RPC won't say) and a stake account's rent. */
const minimumOf = (rpc) => rpc.call('getStakeMinimumDelegation', [{ commitment: 'confirmed' }]).then((r) => BigInt(r?.value ?? r ?? 0)).catch(() => 1_000_000_000n);
const rentOf = (rpc) => rpc.call('getMinimumBalanceForRentExemption', [STAKE_SPACE, { commitment: 'confirmed' }]).then((r) => BigInt(r));

/** The validators, ranked, from the chain (and their names when the RPC lists them), with the terms of staking:
 * { epoch, list, minimum, rent, keep } (lamports as strings). */
export async function validators(rpc, network) {
  const [votes, production, info, names, minimum, rent] = await Promise.all([
    rpc.call('getVoteAccounts', [{ commitment: 'confirmed' }], { timeout: 30_000 }),
    rpc.call('getBlockProduction', [{ commitment: 'confirmed' }]).catch(() => null),
    rpc.call('getEpochInfo', [{ commitment: 'confirmed' }]),
    validatorNames(rpc, network),
    minimumOf(rpc),
    rentOf(rpc),
  ]);
  return { epoch: info.epoch, list: rankValidators({ votes, production, names, epoch: info.epoch }), minimum: minimum.toString(), rent: rent.toString(), keep: KEEP_FOR_FEES.toString() };
}

/* ------------------------------------------------------------ your stake accounts */

/** Your stake accounts (as staker or withdrawer, found by the RPC, plus plum's own seeds), read and explained. */
export async function overview(rpc, owner, network) {
  const byAuthority = (offset) => rpc.call('getProgramAccounts', [STAKE_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: STAKE_SPACE }, { memcmp: { offset, bytes: owner } }] }], { timeout: 30_000, retries: 1 });
  const seeds = Array.from({ length: SEEDS }, (_, i) => addressWithSeed(owner, stakeSeed(i), STAKE_PROGRAM));
  const [info, asWithdrawer, asStaker, seeded, sys, minimum, rent] = await Promise.all([
    rpc.call('getEpochInfo', [{ commitment: 'confirmed' }]),
    byAuthority(44).catch(() => null),
    byAuthority(12).catch(() => null),
    rpc.accounts(seeds),
    rpc.accounts([STAKE_HISTORY, COOLDOWN_FEATURE]),
    minimumOf(rpc),
    rentOf(rpc),
  ]);
  const found = new Map();
  for (const item of [...(asWithdrawer ?? []), ...(asStaker ?? [])]) if (isAddress(item?.pubkey)) found.set(item.pubkey, item.account);
  seeds.forEach((a, i) => { if (seeded[i]) found.set(a, seeded[i]); });
  const epoch = BigInt(info.epoch);
  const history = readStakeHistory(sys[0]);
  const newRate = newRateEpoch(sys[1], info.slotsInEpoch);
  const accounts = [];
  for (const [address, acc] of found) {
    const s = readStakeAccount(acc);
    if (!s || (s.staker !== owner && s.withdrawer !== owner)) continue;
    const st = stateOf(s, epoch, history, newRate);
    accounts.push({
      address, lamports: String(acc.lamports), rentReserve: s.rentReserve.toString(), staker: s.staker, withdrawer: s.withdrawer,
      vote: s.delegation?.vote ?? null, stake: (s.delegation?.stake ?? 0n).toString(), state: st.state,
      effective: st.effective.toString(), activating: st.activating.toString(), deactivating: st.deactivating.toString(),
      canUnstake: s.staker === owner && (st.state === 'active' || st.state === 'activating'),
      canWithdraw: s.withdrawer === owner && (st.state === 'inactive' || st.state === 'undelegated') && !lockedUp(s, { epoch }),
      locked: lockedUp(s, { epoch }), seed: seeds.includes(address),
      reward: null,
    });
  }
  // last epoch's rewards, where the RPC knows them
  const delegated = accounts.filter((a) => a.vote);
  if (delegated.length && info.epoch > 0) {
    try {
      const rewards = await rpc.call('getInflationReward', [delegated.map((a) => a.address), { epoch: info.epoch - 1, commitment: 'confirmed' }], { timeout: 30_000, retries: 1 });
      delegated.forEach((a, i) => { const r = rewards?.[i]; if (r && Number.isFinite(Number(r.amount))) a.reward = { epoch: Number(r.epoch), amount: String(r.amount) }; });
    } catch { /* not known */ }
  }
  accounts.sort((a, b) => (BigInt(b.lamports) > BigInt(a.lamports) ? 1 : -1));
  const slotsLeft = Math.max(0, Number(info.slotsInEpoch) - Number(info.slotIndex));
  return {
    network, epoch: info.epoch, epochEndsIn: Math.round(slotsLeft * 0.4), minimum: minimum.toString(), rent: rent.toString(), accounts,
  };
}

/* ------------------------------------------------------------ what each staking step does, built for your wallet */

/**
 * The instructions for one staking step, checked against the chain first: { instructions, summary, warnings }.
 *   { action: 'stake', vote, amount }    a new stake account (from a free seed) delegated to `vote`
 *   { action: 'unstake', account }       Deactivate: it stops earning at the end of this epoch
 *   { action: 'withdraw', account }      everything in an inactive account back to your wallet (the account closes)
 */
export async function plan(rpc, owner, p = {}) {
  if (p.action === 'stake') return planStake(rpc, owner, p);
  if (p.action === 'unstake' || p.action === 'withdraw') return planExisting(rpc, owner, p);
  throw fail('unknown staking step');
}

async function planStake(rpc, owner, { vote, amount, max = false }) {
  if (!isAddress(vote)) throw fail('pick a validator');
  const seeds = Array.from({ length: SEEDS }, (_, i) => stakeSeed(i));
  const addresses = seeds.map((s) => addressWithSeed(owner, s, STAKE_PROGRAM));
  const [[voteAcc, wallet], taken, minimum, rent, info] = await Promise.all([
    rpc.accounts([vote, owner]),
    rpc.accounts(addresses),
    minimumOf(rpc),
    rentOf(rpc),
    rpc.call('getEpochInfo', [{ commitment: 'confirmed' }]),
  ]);
  // only a real vote account: a site or a list can't steer your stake into anything else
  if (voteAcc?.owner !== VOTE_PROGRAM) throw fail("that isn't a validator's vote account");
  const balance = BigInt(wallet?.lamports ?? 0);
  const stake = max ? balance - rent - KEEP_FOR_FEES : parseUnits(amount, 9);
  if (stake <= 0n) throw fail(max ? 'there is not enough SOL to stake' : 'type an amount above zero');
  if (stake < minimum) throw fail(`the network's smallest stake is ${formatUnits(minimum, 9)} SOL`);
  if (stake + rent + KEEP_FOR_FEES > balance) throw fail(`you have ${formatUnits(balance, 9)} SOL: staking ${formatUnits(stake, 9)} also needs ${formatUnits(rent, 9)} SOL kept in the stake account, and a little for fees`);
  const free = taken.findIndex((a) => a == null);
  if (free < 0) throw fail(`all ${SEEDS} of plum's stake account addresses for this wallet are in use: withdraw an old one first`);
  const account = addresses[free];
  const lamports = stake + rent;
  const slotsLeft = Math.max(0, Number(info.slotsInEpoch) - Number(info.slotIndex));
  return {
    instructions: [stakeIx.createWithSeed(owner, account, seeds[free], lamports), stakeIx.initialize(account, owner), stakeIx.delegate(account, vote, owner)],
    summary: { action: 'stake', vote, account, seed: seeds[free], stake: stake.toString(), rent: rent.toString(), lamports: lamports.toString(), startsIn: Math.round(slotsLeft * 0.4) },
    warnings: [],
  };
}

async function planExisting(rpc, owner, { action, account }) {
  if (!isAddress(account)) throw fail('pick a stake account');
  const [[acc, sysHistory, feature], info] = await Promise.all([rpc.accounts([account, STAKE_HISTORY, COOLDOWN_FEATURE]), rpc.call('getEpochInfo', [{ commitment: 'confirmed' }])]);
  const s = readStakeAccount(acc);
  if (!s) throw fail("that isn't a stake account");
  const epoch = BigInt(info.epoch);
  const st = stateOf(s, epoch, readStakeHistory(sysHistory), newRateEpoch(feature, info.slotsInEpoch));
  const slotsLeft = Math.max(0, Number(info.slotsInEpoch) - Number(info.slotIndex));
  if (action === 'unstake') {
    if (s.staker !== owner) throw fail("this wallet isn't the stake account's staker, so it can't unstake it");
    if (st.state !== 'active' && st.state !== 'activating') throw fail(st.state === 'deactivating' ? 'it is already unstaking' : 'it is not staked');
    return {
      instructions: [stakeIx.deactivate(account, owner)],
      summary: { action: 'unstake', account, vote: s.delegation.vote, stake: s.delegation.stake.toString(), lamports: String(acc.lamports), endsIn: Math.round(slotsLeft * 0.4) },
      warnings: [],
    };
  }
  if (s.withdrawer !== owner) throw fail("this wallet isn't the stake account's withdrawer, so it can't withdraw from it");
  if (lockedUp(s, { epoch })) throw fail(`it is locked up until ${s.lockup.epoch > epoch ? `epoch ${s.lockup.epoch}` : new Date(Number(s.lockup.unixTimestamp) * 1000).toISOString().slice(0, 10)}`);
  if (st.state !== 'inactive' && st.state !== 'undelegated') throw fail(st.state === 'deactivating' ? `it is still unstaking: it can be withdrawn after this epoch ends (${short(account)})` : 'unstake it first, then withdraw once the epoch has ended');
  const lamports = BigInt(acc.lamports);
  return {
    instructions: [stakeIx.withdraw(account, owner, lamports)],
    summary: { action: 'withdraw', account, vote: s.delegation?.vote ?? null, lamports: lamports.toString() },
    warnings: [],
  };
}
