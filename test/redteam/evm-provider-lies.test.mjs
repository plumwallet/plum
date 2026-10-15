// Attack: a page asks for an Ethereum transaction, and what plum's RPC says about it (the simulation,
// the fees, the gas, the answer to a send) is either limited or lying. Does the approval window still show what the
// signed transaction does, and does a danger still need "i understand"?
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeFunctionData, parseTransaction, recoverTransactionAddress } from 'viem';
import { fakeNet } from '../fake-net.mjs';
import { boot } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // m/44'/60'/0'/0/0 of the "abandon" phrase
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const SOMEONE = '0x1111111111111111111111111111111111111111';
const GWEI = 1_000_000_000n;

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { fake, ok, _test } = ctx;

const topic = (sig) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex')}`;
const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const TRANSFER = topic('Transfer(address,address,uint256)');
const APPROVAL = topic('Approval(address,address,uint256)');
const PERMIT2_APPROVAL = topic('Approval(address,address,address,uint160,uint48)');
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

let evm;
const sends = () => net.eth.sent.length;

/** Queue eth_sendTransaction, return { answer, view, preview } once the approval window could show it. */
async function ask(tx) {
  const answer = evm('eth_sendTransaction', [{ from: ETH_ME, ...tx }]);
  const view = await ctx.nextApproval(1000);
  assert.equal(view.kind, 'evmTx');
  const [preview] = await ok('approval.preview', { id: view.id });
  return { answer, view, preview };
}
const dangers = (p) => p.warnings.filter((w) => w.level === 'danger');
/** Approve exactly as the window does when no "i understand" was ticked. */
const approvePlain = (id) => fake.ui('approval.resolve', { id, approve: true });
async function cleanUp(answer) {
  await ctx.rejectAll();
  await answer;
}

test('setup: a wallet, an Ethereum site connected, ETH to spend', async () => {
  await ctx.setup();
  net.eth.balances.set(ETH_ME.toLowerCase(), 100n * 10n ** 18n);
  net.eth.nonces.set(ETH_ME.toLowerCase(), 4n);
  const page = fake.page('https://drainer-claim.example/');
  evm = (method, params) => page.request('evm', { method, params });
  const answer = evm('eth_requestAccounts');
  const v = await ctx.nextApproval();
  await ok('approval.resolve', { id: v.id, approve: true });
  assert.deepEqual((await answer).result, [ETH_ME]);
});

// FINDING (high): plum names a Permit2 approval as a danger only when the RPC can't simulate (`if (!sim && decoded?.name)`
// in evmPreview), and its simulation reader only knows the ERC-20 Approval event, not Permit2's own
// Approval(owner, token, spender, amount, expiration). With the default RPCs (which simulate), a drainer's
// "approve(USDC, attacker, max, forever)" on Permit2 is shown as "no change to your ETH or tokens", with no warning, and
// is signed and sent without "i understand". Permit2 already holds an unlimited allowance for most DeFi users' tokens, so
// this hands the attacker every one of them.
test('FINDING (high): a Permit2 approve() for an attacker, simulated by an honest RPC, needs no "i understand"', async () => {
  const data = encodeFunctionData({
    abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }], outputs: [] }],
    args: [USDC, ATTACKER, (1n << 160n) - 1n, (1n << 48n) - 1n],
  });
  // what Permit2 really emits for that call
  net.eth.simulate = () => ({
    status: '0x1', gasUsed: '0xb5b0', returnData: '0x',
    logs: [{ address: PERMIT2.toLowerCase(), topics: [PERMIT2_APPROVAL, pad(ETH_ME), pad(USDC), pad(ATTACKER)], data: `0x${word((1n << 160n) - 1n)}${word((1n << 48n) - 1n)}` }],
  });
  const before = sends();
  const { answer, view, preview } = await ask({ to: PERMIT2, data });
  try {
    assert.equal(preview.sim.ok, true);
    assert.equal(preview.call.name, 'approve (Permit2)');
    const r = await approvePlain(view.id);
    const sent = sends() - before;
    assert.equal(r.ok, false, `a Permit2 approval for ${ATTACKER} was signed and sent (${sent} transaction) without "i understand"; the window showed warnings ${JSON.stringify(preview.warnings)} and changes ${JSON.stringify(preview.changes)}`);
    assert.ok(dangers(preview).length > 0);
    assert.equal(sent, 0);
  } finally { await cleanUp(answer); }
});

// FINDING (high, same root): an ERC-721 approve(spender, tokenId) emits Approval with the token id as a 4th topic; the
// reader takes only 3-topic Approval logs, and the decoded-call fallback is skipped because a simulation exists. The NFT
// handed to the attacker isn't mentioned at all.
test('FINDING (high, same root): an NFT approve() to an attacker, simulated, is shown as no change and no warning', async () => {
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], args: [ATTACKER, 8817n] });
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0xc350', returnData: '0x', logs: [{ address: BAYC.toLowerCase(), topics: [APPROVAL, pad(ETH_ME), pad(ATTACKER), `0x${word(8817n)}`], data: '0x' }] });
  const { answer, preview } = await ask({ to: BAYC, data });
  try {
    assert.equal(preview.sim.ok, true);
    assert.ok(preview.warnings.some((w) => w.level !== 'info'), `nothing tells you NFT #8817 can now be taken by ${ATTACKER}: ${JSON.stringify(preview.warnings)}`);
  } finally { await cleanUp(answer); }
});

// Control for the two above: the same kind of approval in the ERC-20 shape the reader knows IS a danger.
test('withstood: an unlimited ERC-20 approve(), simulated, is a danger that needs "i understand"', async () => {
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], args: [ATTACKER, (1n << 256n) - 1n] });
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0xb000', returnData: '0x', logs: [{ address: USDC.toLowerCase(), topics: [APPROVAL, pad(ETH_ME), pad(ATTACKER)], data: `0x${'f'.repeat(64)}` }] });
  const { answer, view, preview } = await ask({ to: USDC, data });
  try {
    assert.ok(dangers(preview).some((w) => /spend all of your/.test(w.text)));
    const r = await approvePlain(view.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /i understand/);
  } finally { await cleanUp(answer); }
});

// FINDING (medium): the ETH a transaction sends (its `value`) is only shown if the RPC's simulation traces it as a
// transfer log from 0xeeee... An RPC that simulates but doesn't trace ETH (traceTransfers ignored by its client, a
// failover to another backend, or one that lies) makes a 5 ETH payment read "no change to your ETH or tokens (besides
// the fee)", green "simulated" chip, no warning; the value is only in the folded "details". The Solana side's rule ("a
// failed or incomplete simulation is a red warning, never 'no change'") isn't kept here.
test('FINDING (medium): a 5 ETH payment whose simulation traces no ETH is shown as "no change"', async () => {
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] });
  const value = 5n * 10n ** 18n;
  const { answer, preview } = await ask({ to: SOMEONE, value: `0x${value.toString(16)}` });
  try {
    assert.equal(preview.sim.ok, true);
    assert.equal(preview.call.value, value.toString(), 'the transaction does send 5 ETH');
    const eth = preview.changes.find((c) => c.symbol === 'ETH');
    assert.ok((eth && BigInt(eth.delta) <= -value) || preview.warnings.some((w) => w.level !== 'info'),
      `the window shows ${JSON.stringify(preview.changes)} and warnings ${JSON.stringify(preview.warnings)} for a transaction that sends 5 ETH`);
  } finally { await cleanUp(answer); }
});

// FINDING (medium): the simulation isn't run on the transaction plum signs. It's simulated with no fee at all and
// validation off (so tx.gasprice and block.basefee are 0 inside it) and with no gas limit unless the site gave one, then
// plum signs with a fresh fee quote and its own gas limit (estimate x 1.2), fetched after you approve. A contract can
// tell the two apart (gasprice == 0, basefee == 0, gasleft()) and behave in the simulation, then drain on chain:
// simulation evasion, the classic way drainers beat wallet previews.
test('FINDING (medium): the simulated call is not the signed one (no fee, no gas limit, validation off)', async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    try { const b = JSON.parse(opts?.body ?? 'null'); if (b?.method === 'eth_simulateV1') seen.push(b.params[0]); } catch { /* not json */ }
    return real(url, opts);
  };
  net.eth.simulate = (call) => ({ status: '0x1', gasUsed: '0xa000', returnData: '0x', logs: [{ address: NATIVE, topics: [TRANSFER, pad(ETH_ME), pad(call.to)], data: call.value }] });
  const before = sends();
  const { answer, view } = await ask({ to: SOMEONE, value: '0x2386f26fc10000', data: '0xd0e30db0' });
  try {
    await ok('approval.resolve', { id: view.id, approve: true });
    assert.equal(sends(), before + 1);
    const signed = parseTransaction(net.eth.sent.at(-1));
    assert.equal(await recoverTransactionAddress({ serializedTransaction: net.eth.sent.at(-1) }), ETH_ME);
    const sim = seen.at(-1);
    const simCall = sim.blockStateCalls[0].calls[0];
    const problems = [];
    if (simCall.gas == null || BigInt(simCall.gas) !== signed.gas) problems.push(`simulated with gas ${simCall.gas ?? '(none: the block limit)'}, signed with ${signed.gas}`);
    const simFee = simCall.maxFeePerGas ?? simCall.gasPrice ?? null;
    if (simFee == null || BigInt(simFee) !== signed.maxFeePerGas) problems.push(`simulated with fee ${simFee ?? '(none: gasprice 0)'}, signed with maxFeePerGas ${signed.maxFeePerGas}`);
    if (sim.validation === false && !sim.blockStateCalls[0].blockOverrides?.baseFeePerGas) problems.push('validation off and no base fee override: block.basefee is 0 in the simulation');
    assert.deepEqual(problems, []);
  } finally {
    globalThis.fetch = real;
    await cleanUp(answer);
  }
});

// Lying fee data can't make you pay more than the real base fee plus a 3 gwei tip: the tip is clamped and maxFee only
// caps what EIP-1559 charges (base fee + min(tip, maxFee - base fee)).
test('withstood: absurd fee history and base fee from the RPC: the tip you pay is still at most 3 gwei', async () => {
  const [base, tip] = [net.eth.baseFee, net.eth.tip];
  net.eth.baseFee = 10n ** 15n; // a million gwei
  net.eth.tip = 10n ** 13n; // ten thousand gwei of "tip" in every block
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [{ address: NATIVE, topics: [TRANSFER, pad(ETH_ME), pad(SOMEONE)], data: `0x${word(1000n)}` }] });
  const { answer, view, preview } = await ask({ to: SOMEONE, value: '0x3e8' });
  try {
    assert.ok(BigInt(preview.fee.max) >= 21_000n * 2n * 10n ** 15n, 'the absurd cap is shown, not hidden');
    await ok('approval.resolve', { id: view.id, approve: true });
    const tx = parseTransaction(net.eth.sent.at(-1));
    assert.ok(tx.maxPriorityFeePerGas <= 3n * GWEI, `tip ${tx.maxPriorityFeePerGas}`);
  } finally {
    [net.eth.baseFee, net.eth.tip] = [base, tip];
    await cleanUp(answer);
  }
});

test("withstood: a site's own gas limit far above plum's estimate is cut to twice the estimate; its nonce and gas price are ignored", async () => {
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0xa000', returnData: '0x', logs: [] });
  const { answer, view } = await ask({ to: SOMEONE, data: '0xd0e30db0', gas: '0x1c9c380', nonce: '0x0', gasPrice: '0x174876e800', maxFeePerGas: '0x1', chainId: '0x1' });
  try {
    await ok('approval.resolve', { id: view.id, approve: true });
    const tx = parseTransaction(net.eth.sent.at(-1));
    assert.equal(tx.gas, 0xc350n * 2n, 'capped at twice the estimate (the fake estimates 50,000)');
    assert.equal(tx.nonce, 4);
    assert.equal(tx.chainId, 1);
    assert.equal(tx.maxFeePerGas, net.eth.baseFee * 2n + net.eth.tip);
  } finally { await cleanUp(answer); }
});

test('withstood: a simulation answer plum cannot read is a danger (never "no change"), and needs "i understand"', async () => {
  for (const sim of [
    { status: '0x1', gasUsed: 'lots', logs: [] },
    { status: '0x1', gasUsed: '0x1', logs: [{ address: BAYC.toLowerCase(), topics: [TRANSFER, pad(ETH_ME), pad(ATTACKER), 'not-a-number'], data: '0x' }] },
    { status: '0x1', gasUsed: '0x1', logs: [{ address: 'zz', topics: [TRANSFER, pad(ATTACKER), pad(ETH_ME)], data: `0x${word(5n)}` }] },
  ]) {
    net.eth.simulate = () => sim;
    const { answer, view, preview } = await ask({ to: SOMEONE, data: '0x12345678' });
    try {
      assert.ok(dangers(preview).length || preview.sim.ok !== true, JSON.stringify(preview));
      const r = await approvePlain(view.id);
      assert.equal(r.ok, false, JSON.stringify(sim));
    } finally { await cleanUp(answer); }
  }
});

test('withstood: a send answered with another transaction hash is an error to the site, not a fake success', async () => {
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts?.body ?? 'null');
    if (b?.method === 'eth_sendRawTransaction') return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: b.id, result: `0x${'ab'.repeat(32)}` }) };
    return real(url, opts);
  };
  const { answer, view } = await ask({ to: SOMEONE, data: '0x' });
  try {
    const r = await fake.ui('approval.resolve', { id: view.id, approve: true, ignoreRisk: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /different transaction hash/);
    assert.match((await answer).error.message, /different transaction hash/);
  } finally {
    globalThis.fetch = real;
    await cleanUp(answer);
  }
});

test('withstood: nothing was left waiting', () => {
  assert.equal(_test.pending.size, 0);
});
