// What a transaction will do to your wallet, before you sign it: it is simulated against the chain and the result is
// read back as balance changes (SOL and every token you hold), plus the things drainers rely on, whether they're done
// directly or hidden inside another program:
//   - your wallet account handed to another program (Assign)
//   - one of your token accounts given to someone else (SetAuthority) or opened to a spender (Approve)
//   - a durable nonce (sign today, sent whenever they like)
//   - more signers than you, someone else's signature already on it, someone else paying the fee
// The bytes are the only source of truth: nothing a site says about its transaction is shown.
import { base58Decode, base58Encode } from '../shared/base58.js';
import { b64decode, b64encode, readU32, readU64 } from '../shared/bytes.js';
import { short, prettyAmount } from '../shared/format.js';
import { programName } from '../shared/programs.js';
import { nftNotes, readCoreAsset } from './nfts.js';
import {
  SIGNATURE_FEE, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, budgetInstructions, computeBudgetOf, feeOf, isSigned, isStaticWritable, readTx, signersOf,
} from '../shared/tx.js';

const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';

/** An account's data as bytes (empty for none). */
const dataOf = (acc) => (typeof acc?.data?.[0] === 'string' ? b64decode(acc.data[0]) : new Uint8Array(0));

/** Does `hay` hold the 32 bytes of `needle` anywhere? */
function contains(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
/** A priority fee above this many lamports (0.01 SOL) gets a warning. */
const BIG_PRIORITY = 10_000_000n;

/** The addresses a v0 transaction reads from lookup tables: { writable, readonly }. */
export async function resolveLookups(t, rpc) {
  if (!t.lookups.length) return { writable: [], readonly: [] };
  const infos = await rpc.accounts(t.lookups.map((l) => l.table));
  const writable = [], readonly = [];
  t.lookups.forEach((l, i) => {
    const info = infos[i];
    if (!info) throw new Error(`it reads addresses from a lookup table that doesn't exist (${short(l.table)})`);
    if (info.owner !== ALT_PROGRAM) throw new Error(`it reads addresses from an account that isn't a lookup table (${short(l.table)})`);
    const data = b64decode(info.data[0]);
    const count = Math.max(0, Math.floor((data.length - 56) / 32));
    const at = (j) => {
      if (j >= count) throw new Error(`it reads address ${j} of a lookup table that has ${count}`);
      return base58Encode(data.subarray(56 + 32 * j, 88 + 32 * j));
    };
    writable.push(...l.writable.map(at));
    readonly.push(...l.readonly.map(at));
  });
  return { writable, readonly };
}

/** A token account's fields from its bytes, or null when the account isn't one. */
export function readTokenAccount(acc) {
  if (!acc || !TOKEN_PROGRAMS.has(acc.owner)) return null;
  const d = typeof acc.data?.[0] === 'string' ? b64decode(acc.data[0]) : acc.data;
  if (!(d instanceof Uint8Array) || d.length < 165) return null;
  if (d.length > 165 && d[165] !== 2) return null; // Token-2022: 2 marks an account (1 is a mint)
  if (d[108] === 0) return null; // not initialized
  return {
    program: acc.owner,
    mint: base58Encode(d.subarray(0, 32)),
    owner: base58Encode(d.subarray(32, 64)),
    amount: readU64(d, 64),
    delegate: readU32(d, 72) ? base58Encode(d.subarray(76, 108)) : null,
    delegatedAmount: readU64(d, 121),
    closeAuthority: readU32(d, 129) ? base58Encode(d.subarray(133, 165)) : null,
  };
}

/** A Token-2022 mint's extensions: [{ type, data }] (empty for any other account). */
export function mintExtensions(acc) {
  if (acc?.owner !== TOKEN_2022_PROGRAM) return [];
  const d = dataOf(acc);
  if (d.length <= 166 || d[165] !== 1) return []; // 1 marks a mint
  const out = [];
  for (let i = 166; i + 4 <= d.length;) {
    const type = d[i] | (d[i + 1] << 8);
    const len = d[i + 2] | (d[i + 3] << 8);
    if (type === 0 || i + 4 + len > d.length) break;
    out.push({ type, data: d.subarray(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

/** A mint's decimals from its bytes (offset 44), or null. */
export function readMintDecimals(acc) {
  if (!acc || !TOKEN_PROGRAMS.has(acc.owner)) return null;
  const d = b64decode(acc.data[0]);
  return d.length >= 82 ? d[44] : null;
}

/** A failed simulation in words. */
export function simErrorText(err, logs = []) {
  const s = typeof err === 'string' ? err : JSON.stringify(err);
  const log = logs.join('\n');
  if (/InsufficientFundsForRent/.test(s)) return 'an account would be left with too little SOL to stay open (rent)';
  if (/AccountNotFound/.test(s)) return 'the wallet paying for it has no SOL on this network';
  if (/InsufficientFundsForFee/.test(s)) return 'not enough SOL to pay the network fee';
  if (/InvalidAccountForFee/.test(s)) return "the paying account can't pay fees: it isn't a plain wallet any more (it holds data or belongs to a program)";
  if (/insufficient lamports/i.test(log)) return 'not enough SOL';
  if (/insufficient funds/i.test(log)) return 'not enough tokens';
  if (/SlippageToleranceExceeded|custom program error: 0x1771/.test(log)) return 'the price moved past your slippage';
  if (/BlockhashNotFound/.test(s)) return 'its blockhash expired';
  return `it fails on chain (${s.slice(0, 160)})`;
}

function warner() {
  const list = [];
  const seen = new Set();
  const add = (level, text, key = text) => {
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ level, text });
  };
  return { list, add };
}

/**
 * Preview one transaction for `owner`. `rpc` is a client (rpc.js); `meta(mints)` optionally names tokens
 * ({ symbol, name, icon } by mint). Throws when the transaction can't be read or doesn't ask `owner` to sign.
 */
export async function previewTx(input, { owner, rpc, meta }) {
  const t = readTx(input);
  const signers = signersOf(t);
  if (!signers.includes(owner)) throw new Error("this transaction doesn't ask for your signature");
  const ownerBytes = base58Decode(owner);
  const w = warner();

  // who signs, who pays
  const others = signers.filter((s) => s !== owner);
  const presignedBy = signers.filter((s, i) => s !== owner && isSigned(t.signatures[i]));
  const ownSlot = signers.indexOf(owner);
  if (isSigned(t.signatures[ownSlot])) w.add('warn', 'it already carries a signature in your slot: signing replaces it');
  if (others.length) w.add('warn', `it needs ${t.required} signatures: yours and ${others.map((s) => short(s)).join(', ')}`);
  if (presignedBy.length) w.add('info', `already signed by ${presignedBy.map((s) => short(s)).join(', ')} before it reached you`);
  if (t.keys[0] !== owner) w.add('info', `the network fee is paid by ${short(t.keys[0])}, not you`);

  // every account it touches
  const loaded = await resolveLookups(t, rpc);
  const all = [...t.keys, ...loaded.writable, ...loaded.readonly];
  const writable = [...t.keys.filter((_, i) => isStaticWritable(t, i)), ...loaded.writable];
  const programOf = (ix) => all[ix.programIndex];

  const instructions = t.instructions.map((ix) => ({ program: programOf(ix), name: programName(programOf(ix)), accounts: ix.accounts.length, bytes: ix.data.length }));
  const programs = [...new Set(instructions.map((i) => i.program))].map((id) => ({ id, name: programName(id) }));

  // what the instructions say outright (these show even when the simulation fails)
  const minted = []; // new supply minted with your authority, checked against the state below
  t.instructions.forEach((ix, n) => {
    const program = programOf(ix);
    const acct = (k) => all[ix.accounts[k]];
    const d = ix.data;
    if (program === SYSTEM_PROGRAM && d.length >= 4) {
      const kind = readU32(d, 0);
      if (kind === 4 && n === 0) w.add('danger', "it uses a durable nonce: once you sign, it can be sent at any time, even weeks from now", 'nonce');
      if (kind === 1 && acct(0) === owner) w.add('danger', 'it hands your wallet account to another program (Assign): drainers do this', 'wallet-owner');
      if (kind === 10 && acct(1) === owner) w.add('danger', 'it hands an account derived from your wallet to another program (AssignWithSeed)', `assign-seed:${acct(0)}`);
      if ((kind === 8 && acct(0) === owner) || (kind === 9 && acct(1) === owner)) w.add('danger', 'it gives your wallet account data (Allocate): a wallet holding data can never pay fees or send its SOL again', 'wallet-data');
      if (kind === 7 && acct(1) === owner) w.add('danger', `it hands control of the nonce account ${short(acct(0))} to someone else`, `authority:${acct(0)}`);
      // WithdrawNonceAccount: [nonce, recipient, recent blockhashes, rent, authority]
      if (kind === 5 && d.length >= 12 && acct(4) === owner && acct(1) !== owner) {
        w.add('danger', `it withdraws ${prettyAmount(readU64(d, 4), 9)} SOL from your nonce account ${short(acct(0))} to ${short(acct(1))}`, `outflow:${acct(0)}`);
      }
    }
    if (program === STAKE_PROGRAM && d.length >= 4) {
      const kind = readU32(d, 0);
      // Authorize (1) and AuthorizeChecked (10) with you as the current authority give the stake account away
      if ((kind === 1 || kind === 10) && acct(2) === owner) w.add('danger', `it hands authority over the stake account ${short(acct(0))} to someone else`, `authority:${acct(0)}`);
      // Withdraw (4): [stake, recipient, clock, stake history, withdraw authority]
      if (kind === 4 && d.length >= 12 && acct(4) === owner && acct(1) !== owner) {
        w.add('danger', `it withdraws ${prettyAmount(readU64(d, 4), 9)} SOL from your stake account ${short(acct(0))} to ${short(acct(1))}`, `outflow:${acct(0)}`);
      }
      // Initialize (0) names the withdrawer in its data, InitializeChecked (9) as its fourth account: a stake account
      // someone else can withdraw takes whatever SOL goes into it
      const withdrawer = kind === 0 && d.length >= 68 ? base58Encode(d.subarray(36, 68)) : kind === 9 ? acct(3) : null;
      if (withdrawer && withdrawer !== owner) w.add('danger', `it sets up the stake account ${short(acct(0))} for ${short(withdrawer)} to withdraw, not you: SOL put in it is theirs to take`, `withdrawer:${acct(0)}`);
      // the rest in plain words: DelegateStake (2), Split (3), Deactivate (5), Merge (7)
      if (kind === 2 && acct(5) === owner) w.add('info', `it stakes the stake account ${short(acct(0))} with the validator ${short(acct(1))}`);
      if (kind === 5 && acct(2) === owner) w.add('info', `it unstakes your stake account ${short(acct(0))}: it stops earning when this epoch ends`);
      if (kind === 3 && acct(2) === owner) w.add('info', `it splits ${prettyAmount(d.length >= 12 ? readU64(d, 4) : 0n, 9)} SOL off your stake account ${short(acct(0))} into ${short(acct(1))}`);
      if (kind === 7 && acct(4) === owner) w.add('info', `it merges your stake account ${short(acct(1))} into ${short(acct(0))}`);
    }
    // MintTo (7) / MintToChecked (14) signed by you as the mint authority: [mint, destination, authority]
    if (TOKEN_PROGRAMS.has(program) && (d[0] === 7 || d[0] === 14) && d.length >= 9 && acct(2) === owner) {
      minted.push({ mint: acct(0), dest: acct(1), amount: readU64(d, 1) });
    }
    if (TOKEN_PROGRAMS.has(program) && d.length >= 1) {
      if (d[0] === 6 && acct(1) === owner) w.add('danger', `it changes who controls ${short(acct(0))}, an account or mint you control (SetAuthority)`, `authority:${acct(0)}`);
      if (d[0] === 4 && acct(2) === owner) w.add('danger', `it lets ${short(acct(1))} spend tokens from your account ${short(acct(0))} (Approve)`, `delegate:${acct(0)}`);
      if (d[0] === 13 && acct(3) === owner) w.add('danger', `it lets ${short(acct(2))} spend tokens from your account ${short(acct(0))} (Approve)`, `delegate:${acct(0)}`);
      if (d[0] === 9 && acct(2) === owner && acct(1) !== owner) w.add('warn', `it closes your token account ${short(acct(0))} and sends its SOL to ${short(acct(1))}`);
    }
  });

  // programs plum can't name that are handed your signature
  const unknown = [...new Set(t.instructions.filter((ix) => !programName(programOf(ix)) && ix.accounts.some((k) => all[k] === owner)).map(programOf))];
  if (unknown.length) w.add('info', `it passes your signature to ${unknown.length === 1 ? 'a program' : 'programs'} plum doesn't know: ${unknown.map((p) => short(p)).join(', ')}`);

  const budget = computeBudgetOf(t, programOf);

  // simulate it, reading back your wallet and every writable account
  const watch = [...new Set([owner, ...writable])];
  const b64 = b64encode(t.bytes);
  const [pre, sim] = await Promise.all([rpc.accounts(watch), rpc.simulate(b64, watch)]);
  let ok = !sim.err;
  const logs = (sim.logs ?? []).slice(-14);
  if (!ok) w.add('danger', `the simulation failed: ${simErrorText(sim.err, sim.logs ?? [])}. If you sign, it will probably fail and still cost the fee.`, 'sim');

  // a result that doesn't cover every account plum asked about can't vouch for anything
  const balances = Array.isArray(sim.preBalances) && Array.isArray(sim.postBalances);
  const complete = Array.isArray(sim.accounts) && sim.accounts.length === watch.length && (balances || !pre[0] || sim.accounts[0] != null);
  if (ok && !complete) {
    ok = false;
    w.add('danger', "the RPC's simulation came back incomplete, so plum can't tell you what this does. Don't sign it unless you trust the site completely.", 'sim');
  }

  // the fee, and any priority fee hidden in it. A v1 transaction's is set by its header, so an RPC's word can add to it
  // (signatures checked by precompiles) but never take from it
  let fee = sim.fee != null ? BigInt(sim.fee) : feeOf(t);
  if (t.version === 1 && fee < feeOf(t)) fee = feeOf(t);
  const priority = fee > SIGNATURE_FEE * BigInt(t.required) ? fee - SIGNATURE_FEE * BigInt(t.required) : budget.priorityLamports;
  if (priority > BIG_PRIORITY) w.add('warn', `it pays a priority fee of ${prettyAmount(priority, 9)} SOL`);
  // a v1 transaction ignores compute-budget instructions: one there makes it read as cheaper than it is, to anything
  // that still looks for them
  if (t.version === 1 && budgetInstructions(t, programOf).length) {
    w.add('info', `it carries compute-budget instructions, which do nothing in a v1 transaction: its priority fee is the ${prettyAmount(budget.priorityLamports, 9)} SOL set in its header`);
  }

  const post = complete ? sim.accounts : [];
  const byAddr = (list) => new Map(watch.map((a, i) => [a, list[i] ?? null]));
  const preMap = byAddr(pre), postMap = byAddr(post);

  // SOL: the exact same-slot balances when the RPC gives them, else the two reads
  let solDelta = 0n;
  const idx = all.indexOf(owner);
  if (ok && Array.isArray(sim.preBalances) && Array.isArray(sim.postBalances) && idx >= 0 && sim.postBalances[idx] != null) {
    solDelta = BigInt(sim.postBalances[idx]) - BigInt(sim.preBalances[idx]);
  } else if (ok && postMap.get(owner) && preMap.get(owner)) {
    solDelta = BigInt(postMap.get(owner).lamports) - BigInt(preMap.get(owner).lamports);
  }

  // your wallet account must stay a plain wallet
  const walletAfter = postMap.get(owner);
  if (ok && walletAfter && walletAfter.lamports > 0 && walletAfter.owner !== SYSTEM_PROGRAM) {
    w.add('danger', `it hands your wallet account to ${programName(walletAfter.owner) ?? short(walletAfter.owner)} (Assign): drainers do this`, 'wallet-owner');
  }
  if (ok && walletAfter && dataOf(walletAfter).length > 0 && !dataOf(preMap.get(owner)).length) {
    w.add('danger', 'it gives your wallet account data (Allocate): a wallet holding data can never pay fees or send its SOL again', 'wallet-data');
  }

  // tokens: what changes in every account you own, and who can move them afterwards
  const deltas = new Map();
  const decimals = new Map();
  const bump = (mint, v) => deltas.set(mint, (deltas.get(mint) ?? 0n) + v);
  const sameSlot = ok && Array.isArray(sim.preTokenBalances) && Array.isArray(sim.postTokenBalances);
  if (sameSlot) {
    for (const b of sim.preTokenBalances) if (b.owner === owner) { bump(b.mint, -BigInt(b.uiTokenAmount.amount)); decimals.set(b.mint, b.uiTokenAmount.decimals); }
    for (const b of sim.postTokenBalances) if (b.owner === owner) { bump(b.mint, BigInt(b.uiTokenAmount.amount)); decimals.set(b.mint, b.uiTokenAmount.decimals); }
  }
  if (ok) {
    for (const addr of watch) {
      const a = readTokenAccount(preMap.get(addr));
      const b = readTokenAccount(postMap.get(addr));
      if (!sameSlot) {
        if (a?.owner === owner) bump(a.mint, -a.amount);
        if (b?.owner === owner) bump(b.mint, b.amount);
      }
      if (a?.owner === owner && b && b.owner !== owner) {
        w.add('danger', `it gives your ${a.mint === WSOL_MINT ? 'wrapped SOL' : 'token'} account ${short(addr)} to ${short(b.owner)}: everything in it becomes theirs`, `authority:${addr}`);
      }
      if (b?.owner === owner && b.delegate && b.delegatedAmount > 0n && (a?.delegate !== b.delegate || b.delegatedAmount > (a?.delegatedAmount ?? 0n))) {
        w.add('danger', `it lets ${short(b.delegate)} spend your tokens in ${short(addr)} without asking you again`, `delegate:${addr}`);
      }
      if (b?.owner === owner && b.closeAuthority && b.closeAuthority !== owner && a?.closeAuthority !== b.closeAuthority) {
        w.add('warn', `it lets ${short(b.closeAuthority)} close your token account ${short(addr)}`);
      }
      // any other account that named you (a stake, a mint, an NFT, a nonce, a program's upgrade authority...) and no
      // longer does after this transaction, while it still exists: you've been taken off it (a Core asset changing hands
      // is named by nftNotes instead)
      if (addr !== owner && !(a || b) && !readCoreAsset(preMap.get(addr))) {
        const before = dataOf(preMap.get(addr));
        const after = dataOf(postMap.get(addr));
        const prog = postMap.get(addr)?.owner ?? preMap.get(addr)?.owner;
        const named = contains(before, ownerBytes);
        if (after.length && named && !contains(after, ownerBytes)) {
          w.add('danger', `it takes you off ${short(addr)} (an account of ${programName(prog) ?? short(prog)} that named you): whatever it gave you control of may become someone else's`, `authority:${addr}`);
        }
        // SOL leaving an account that names you (a stake or nonce account, an escrow...): your wallet's own balance
        // wouldn't show it, unless the SOL comes to you
        const lost = BigInt(preMap.get(addr)?.lamports ?? 0) - BigInt(postMap.get(addr)?.lamports ?? 0);
        if (named && lost > 0n && solDelta + fee < lost) {
          w.add('warn', `${prettyAmount(lost, 9)} SOL leaves ${short(addr)}, an account of ${programName(prog) ?? short(prog)} that names you, and doesn't come to your wallet`, `outflow:${addr}`);
        }
      }
    }
    // new supply minted with your authority: to someone else is a danger
    for (const m of minted) {
      const dest = readTokenAccount(postMap.get(m.dest)) ?? readTokenAccount(preMap.get(m.dest));
      const dec = readMintDecimals(preMap.get(m.mint));
      const amount = dec != null ? prettyAmount(m.amount, dec) : m.amount.toString();
      if (dest?.owner !== owner) w.add('danger', `it mints ${amount} new tokens of ${short(m.mint)}, a mint you control, to ${short(dest?.owner ?? m.dest)}`, `mint:${m.mint}:${m.dest}`);
      else w.add('info', `it mints ${amount} new tokens of ${short(m.mint)}, a mint you control, to you`, `mint:${m.mint}:${m.dest}`);
    }
  } else {
    for (const m of minted) w.add('danger', `it mints new tokens of ${short(m.mint)}, a mint you control, to ${short(m.dest)}`, `mint:${m.mint}:${m.dest}`);
  }

  // wrapped SOL is SOL: fold it into the SOL line (a swap that unwraps your wSOL account would otherwise read as
  // "+1,136 SOL, -1,136 wSOL" instead of what you actually spend)
  const wrapped = deltas.get(WSOL_MINT) ?? 0n;
  if (deltas.has(WSOL_MINT)) { solDelta += wrapped; deltas.delete(WSOL_MINT); }

  // the mints: decimals the balances didn't carry, and what a token you're receiving can do to you later
  const mints = [...deltas.keys()].filter((m) => deltas.get(m) !== 0n);
  const missing = mints.filter((m) => !decimals.has(m));
  const received = mints.filter((m) => deltas.get(m) > 0n);
  const toRead = [...new Set([...missing, ...received])];
  const mintInfos = toRead.length ? await rpc.accounts(toRead).catch(() => []) : [];
  const mintAcct = new Map(toRead.map((m, i) => [m, mintInfos[i] ?? null]));
  missing.forEach((m) => { const d = readMintDecimals(mintAcct.get(m)); if (d != null) decimals.set(m, d); });
  let names = new Map();
  if (meta && mints.length) names = await meta(mints).catch(() => new Map());
  for (const m of received) {
    const label = names.get(m)?.symbol ?? short(m);
    for (const e of mintExtensions(mintAcct.get(m))) {
      if (e.type === 12 && e.data.length >= 32 && e.data.some((x) => x)) w.add('warn', `${label} has a permanent delegate (${short(base58Encode(e.data.subarray(0, 32)))}): its issuer can move or burn your ${label} at any time, without asking`);
      if (e.type === 14 && e.data.length >= 64 && e.data.subarray(32, 64).some((x) => x)) w.add('warn', `${label} has a transfer hook: a program (${short(base58Encode(e.data.subarray(32, 64)))}) runs on every transfer of it, and can block or charge them`);
      if (e.type === 26) w.add('warn', `${label} can be paused by its issuer: while paused, you can't move it`);
      if (e.type === 1) w.add('info', `${label} charges a fee on every transfer`);
      if (e.type === 9) w.add('info', `${label} can't be transferred once it's yours`);
    }
  }
  // NFTs, by name: each one that leaves you is said in words, whatever its standard
  const nft = await nftNotes({ t, all, programOf, owner, ok, preMap, postMap, deltas, decimals, rpc }).catch(() => ({ notes: [], labels: new Map() }));
  for (const n of nft.notes) w.add(n.level, n.text, n.key);
  const tokens = mints.map((mint) => {
    const n = names.get(mint) ?? {};
    return { mint, delta: deltas.get(mint).toString(), decimals: decimals.get(mint) ?? 0, symbol: n.symbol ?? null, name: n.name ?? null, icon: n.icon ?? null, verified: !!n.verified, nft: nft.labels.get(mint) ?? null };
  });

  const order = { danger: 0, warn: 1, info: 2 };
  return {
    version: t.version,
    size: t.size,
    required: t.required,
    signers,
    feePayer: t.keys[0],
    youPayFee: t.keys[0] === owner,
    blockhash: t.blockhash,
    programs,
    instructions,
    accounts: all.length,
    writable: writable.length,
    fee: fee.toString(),
    priority: priority.toString(),
    // a v1 transaction's compute budget, as its header sets it (null for what it leaves out)
    config: t.version === 1 ? { units: t.config.computeUnitLimit, priorityFee: t.config.priorityFee?.toString() ?? null, loadedData: t.config.loadedAccountsDataSizeLimit, heap: t.config.heapSize } : null,
    sol: solDelta.toString(),
    wrappedSol: wrapped.toString(),
    tokens,
    warnings: w.list.sort((a, b) => order[a.level] - order[b.level]),
    sim: { ok, error: ok ? null : simErrorText(sim.err, sim.logs ?? []), logs, units: sim.unitsConsumed ?? null },
  };
}
