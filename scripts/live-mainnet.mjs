// plum's preview against real mainnet, read-only: nothing is signed or sent. A transfer and a real Jupiter swap (a v0
// transaction with lookup tables) are built for a wallet that holds SOL, then previewed exactly as plum previews
// what a site asks you to sign. Checks the balance changes, the one-signer rule and that nothing looks dangerous.
//   node scripts/live-mainnet.mjs [--rpc https://your.rpc]
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { b64decode } from '../src/shared/bytes.js';
import { formatUnits } from '../src/shared/format.js';
import { readTx, signersOf, WSOL_MINT } from '../src/shared/tx.js';
import { previewTx } from '../src/background/preview.js';
import { client } from '../src/background/rpc.js';
import { quote, swapTransaction, tokenInfo } from '../src/background/jupiter.js';

const i = process.argv.indexOf('--rpc');
const rpc = client(i > 0 ? process.argv[i + 1] : 'https://api.mainnet-beta.solana.com');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WHALE = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'; // an exchange hot wallet: lots of SOL, a plain system account
const meta = (mints) => tokenInfo(mints);
const show = (p) => {
  console.log(`   sol ${formatUnits(BigInt(p.sol), 9)} (wrapped ${formatUnits(BigInt(p.wrappedSol), 9)})  fee ${formatUnits(BigInt(p.fee), 9)}  signers ${p.required}  ${p.version === 'legacy' ? 'legacy' : `v${p.version}`} ${p.size}B  sim ${p.sim.ok ? 'ok' : p.sim.error}`);
  for (const t of p.tokens) console.log(`   ${t.symbol ?? t.mint} ${formatUnits(BigInt(t.delta), t.decimals)}`);
  for (const w of p.warnings) console.log(`   [${w.level}] ${w.text}`);
};

console.log('> a plain transfer of 0.01 SOL');
const { blockhash } = await rpc.latestBlockhash();
const tx = new Transaction({ feePayer: new PublicKey(WHALE), recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(WHALE), toPubkey: Keypair.generate().publicKey, lamports: 10_000_000 }));
const p1 = await previewTx(tx.serialize({ requireAllSignatures: false, verifySignatures: false }), { owner: WHALE, rpc, meta });
show(p1);
assert.ok(p1.sim.ok);
assert.equal(BigInt(p1.sol), -10_000_000n - BigInt(p1.fee), 'SOL change is the amount plus the fee');
assert.deepEqual(p1.warnings, []);

console.log('> a Jupiter swap: 0.05 SOL for USDC');
const q = await quote({ inputMint: WSOL_MINT, outputMint: USDC, amount: 50_000_000n, slippageBps: 100 });
const bytes = b64decode(await swapTransaction(q, WHALE));
const t = readTx(bytes);
assert.equal(t.required, 1, "Jupiter's swap needs one signer");
assert.deepEqual(signersOf(t), [WHALE]);
const p2 = await previewTx(bytes, { owner: WHALE, rpc, meta });
show(p2);
assert.ok(p2.sim.ok, p2.sim.error);
const usdc = p2.tokens.find((x) => x.mint === USDC);
assert.ok(usdc && BigInt(usdc.delta) >= BigInt(q.otherAmountThreshold), 'receives at least the minimum USDC');
assert.ok(BigInt(p2.sol) < -40_000_000n && BigInt(p2.sol) > -60_000_000n, 'the net SOL change is the 0.05 swapped (give or take fees and rent)');
assert.ok(!p2.tokens.some((x) => x.mint === WSOL_MINT), 'wrapped SOL is folded into SOL');
assert.ok(!p2.warnings.some((w) => w.level === 'danger'), 'nothing dangerous in a plain swap');
console.log('\nlive mainnet checks passed (nothing was signed or sent)');
