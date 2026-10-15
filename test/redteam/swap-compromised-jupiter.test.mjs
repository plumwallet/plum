// Attack: Jupiter's API is compromised and returns a "swap" that does something else. Plum refuses
// swaps that take other tokens, too much input or too much SOL. These try what is left: drainer patterns that take
// nothing right now (delegate, Assign), a swap that gives nothing back, and a simulation that fails.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { createApproveInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ME, PK, boot, legacyB64, pk, transferIx } from './helpers.mjs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const ctx = await boot({ balance: 50_000_000_000n });
const { chain, ok, err } = ctx;
let swapTx = null;
const usdcGiven = (v) => ({ ...v, preTokenBalances: [{ accountIndex: 1, mint: USDC, owner: ME, uiTokenAmount: { amount: '0', decimals: 6 } }], postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: ME, uiTokenAmount: { amount: '100000000', decimals: 6 } }] });

// Jupiter, stood in for: knows SOL and USDC, quotes 1 SOL -> 100 USDC, and returns whatever `swapTx` is
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.includes('/tokens/v2/search')) return json([{ id: WSOL, symbol: 'SOL', decimals: 9, isVerified: true }, { id: USDC, symbol: 'USDC', decimals: 6, isVerified: true }]);
  if (u.includes('/swap/v1/quote')) return json({ inputMint: WSOL, outputMint: USDC, inAmount: '1000000000', outAmount: '100000000', otherAmountThreshold: '99000000', routePlan: [] });
  if (u.includes('/swap/v1/swap')) return json({ swapTransaction: swapTx });
  throw new Error('no network in tests');
};
const quote = () => ok('swap.quote', { inputMint: WSOL, outputMint: USDC, amount: '1', slippageBps: 100 });
const me = PK(ME);

test('baseline: an honest swap (1 SOL out, 100 USDC in) is prepared', async () => {
  await ctx.setup();
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000)]);
  chain.simExtra = usdcGiven;
  const q = await quote();
  const prep = await ok('swap.prepare', { quoteId: q.id });
  assert.equal(prep.preview.sim.ok, true);
  assert.deepEqual(prep.preview.warnings, []);
});

// A swap is plum's own request, so there is no "sign anyway" for it. Any danger in its preview, a
// failed simulation, or a swap that gives nothing back is refused outright; it never reaches the review screen.

test('a swap that also approves a delegate on your USDC account (drain later) is refused outright', async () => {
  const thief = pk();
  const ata = getAssociatedTokenAddressSync(PK(USDC), me);
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000), createApproveInstruction(ata, thief, me, 1_000_000_000_000n)]);
  chain.simExtra = usdcGiven;
  const q = await quote();
  assert.match(await err('swap.prepare', { quoteId: q.id }), /refused Jupiter's swap: .*Approve/);
});

test('a swap that hands your wallet account to a program (Assign) is refused outright', async () => {
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000), SystemProgram.assign({ accountPubkey: me, programId: pk() })]);
  chain.simExtra = usdcGiven;
  const q = await quote();
  assert.match(await err('swap.prepare', { quoteId: q.id }), /refused Jupiter's swap: .*Assign/);
});

test('a swap that takes your SOL and gives nothing back is refused outright', async () => {
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000)]);
  chain.simExtra = null; // no USDC arrives
  const q = await quote();
  assert.match(await err('swap.prepare', { quoteId: q.id }), /doesn't show you receiving/);
});

test('a swap whose simulation fails is refused outright, with the reason', async () => {
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000)]);
  chain.simExtra = (v) => ({ ...v, err: { InstructionError: [0, { Custom: 6001 }] }, logs: ['Program log: custom program error: 0x1771'] });
  const q = await quote();
  assert.match(await err('swap.prepare', { quoteId: q.id }), /would fail \(the price moved past your slippage\)/);
});

test('documented: a compromised Jupiter can skim up to 0.03 SOL per swap on top of the input (accepted by design)', async () => {
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000), transferIx(me, pk(), 29_000_000)]);
  chain.simExtra = usdcGiven;
  const q = await quote();
  const prep = await ok('swap.prepare', { quoteId: q.id });
  assert.equal(prep.preview.sol, String(-1_029_000_000 - 5000));
  chain.simExtra = null;
});

test('a swap that pre-fills your signature slot or needs a second signer is refused (regression)', async () => {
  const other = Keypair.generate();
  swapTx = legacyB64(me, [transferIx(me, pk(), 1_000_000_000), SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: me, lamports: 1 })], { signers: [other] });
  chain.simExtra = usdcGiven;
  const q = await quote();
  assert.match(await err('swap.prepare', { quoteId: q.id }), /2 signatures/);
});
