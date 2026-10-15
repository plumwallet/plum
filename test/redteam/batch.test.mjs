// Attack: two transactions in one request. Each is simulated alone, so a
// program that behaves one way on a fresh state and drains once the first transaction has flipped a flag shows
// "no change" twice. Plum adds a 'warn' line, which needs no acknowledgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ME, PK, boot, legacyB64, pk, transferIx, unknownProgramIx } from './helpers.mjs';

const ctx = await boot();
const { ok, rejectAll } = ctx;
let app;

test('documented: a two-step unknown-program batch ("arm" then "fire") shows each tx as "no change" and raises no danger, so approve arms with no extra ack', async () => {
  await ctx.setup();
  app = await ctx.connectSite('https://claim.example/');
  const evil = pk();
  const me = PK(ME);
  const arm = legacyB64(me, [unknownProgramIx(evil, me, [], [1])]);
  const fire = legacyB64(me, [unknownProgramIx(evil, me, [{ pubkey: pk(), isSigner: false, isWritable: true }], [2])]);
  const answer = app.request('signTransaction', { account: ME, transactions: [arm, fire] });
  const v = await ctx.nextApproval();
  const previews = await ok('approval.preview', { id: v.id });
  await rejectAll();
  await answer;
  assert.equal(previews.length, 2);
  assert.ok(previews.every((p) => p.sim.ok && p.sol === '-5000' && p.tokens.length === 0), 'each one alone looks like "no change"');
  // the residual risk: no danger is raised, so approve.js never shows the "i understand" toggle for this batch
  assert.ok(!previews.some((p) => p.warnings.some((w) => w.level === 'danger')), 'no danger raised');
  assert.ok(previews.every((p) => p.warnings.some((w) => /one of 2 transactions/.test(w.text))), 'only a per-tx-ordering warning');
  assert.ok(previews.every((p) => p.warnings.some((w) => w.level === 'info' && /doesn't know/.test(w.text))), 'and an info line that an unknown program gets your signature');
});

test('a batch whose second transaction fails on its own is a danger (the user is told; regression)', async () => {
  const me = PK(ME);
  const first = legacyB64(me, [transferIx(me, pk(), 1000)]);
  const second = legacyB64(me, [transferIx(me, pk(), 100_000_000_000)]); // more than the wallet holds
  const answer = app.request('signTransaction', { account: ME, transactions: [first, second] });
  const v = await ctx.nextApproval();
  const previews = await ok('approval.preview', { id: v.id });
  assert.ok(previews[1].warnings.some((w) => w.level === 'danger' && /simulation failed/.test(w.text)));
  assert.ok(previews[0].warnings.some((w) => /one of 2 transactions/.test(w.text)));
  await rejectAll();
  await answer;
});
