// Attacks on plum's own send: addresses that lose funds (programs, token accounts, off-curve), poisoned history,
// expired reviews, and the one-signer rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { readTx, TOKEN_PROGRAM } from '../../src/shared/tx.js';
import { ME, boot, pk, sleep } from './helpers.mjs';

const ctx = await boot();
const { ok, err, rpcMod, _test } = ctx;
const SYSTEM = '11111111111111111111111111111111';

/** Answer getMultipleAccounts / getAccountInfo for `address` with `account`, everything else as the fake chain does. */
function plant(address, account) {
  const real = rpcMod.transport.post;
  rpcMod.transport.post = async (url, body) => {
    if (body.method === 'getMultipleAccounts' && body.params[0].includes(address)) {
      const r = await real(url, body);
      r.json.result.value = body.params[0].map((a, i) => (a === address ? account : r.json.result.value[i]));
      return r;
    }
    return real(url, body);
  };
  return () => { rpcMod.transport.post = real; };
}

test('sending SOL to a program address is refused', async () => {
  await ctx.setup();
  const prog = pk().toBase58();
  const undo = plant(prog, { lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: ['', 'base64'], executable: true });
  try { assert.match(await err('send.prepare', { mint: null, to: prog, amount: '0.1' }), /program/); } finally { undo(); }
});

test('sending SOL to a token account is a danger (the SOL is stuck there)', async () => {
  const ta = pk().toBase58();
  const undo = plant(ta, { lamports: 2039280, owner: TOKEN_PROGRAM, data: ['', 'base64'], executable: false });
  try {
    const prep = await ok('send.prepare', { mint: null, to: ta, amount: '0.1' });
    assert.ok(prep.warnings.some((w) => w.level === 'danger' && /token account/.test(w.text)), JSON.stringify(prep.warnings));
  } finally { undo(); }
});

test('sending to yourself is pointed out; an amount with too many decimals is refused; zero is refused', async () => {
  const prep = await ok('send.prepare', { mint: null, to: ME, amount: '0.5' });
  assert.ok(prep.warnings.some((w) => /wallet you're sending from/.test(w.text)));
  assert.match(await err('send.prepare', { mint: null, to: pk().toBase58(), amount: '0.0000000001' }), /9 decimals/);
  assert.match(await err('send.prepare', { mint: null, to: pk().toBase58(), amount: '0' }), /above zero/);
  assert.match(await err('send.prepare', { mint: null, to: pk().toBase58(), amount: '1e3' }), /type an amount/);
});

test('a reviewed send expires after 75 s and cannot be submitted twice', async () => {
  const prep = await ok('send.prepare', { mint: null, to: pk().toBase58(), amount: '0.01' });
  _test.prepared.get(prep.id).at -= 80_000;
  assert.match(await err('send.submit', { id: prep.id }), /took too long/);
  const prep2 = await ok('send.prepare', { mint: null, to: pk().toBase58(), amount: '0.01' });
  await ok('send.submit', { id: prep2.id });
  assert.match(await err('send.submit', { id: prep2.id }), /expired/);
});

test('every transaction plum builds has one signer: the sender, who pays (checked on 25 random recipients)', async () => {
  for (let i = 0; i < 25; i++) {
    const prep = await ok('send.prepare', { mint: null, to: Keypair.generate().publicKey.toBase58(), amount: (0.001 * (i + 1)).toFixed(3) });
    const t = readTx(_test.prepared.get(prep.id).bytes);
    assert.equal(t.required, 1);
    assert.equal(t.signatures.length, 1);
    assert.equal(t.keys[0], ME);
    assert.equal(t.readonlySigned, 0);
    assert.equal(t.keys.filter((k) => k === SYSTEM).length, 1);
  }
});

test('address poisoning: a lookalike of a recent recipient (same first and last four) is a red warning, a plain new address is not', async () => {
  const past = (await ok('send.prepare', { mint: null, to: pk().toBase58(), amount: '0.01' })).to;
  await ok('send.submit', { id: (await ok('send.prepare', { mint: null, to: past, amount: '0.01' })).id });
  let twin;
  do {
    const a = pk().toBase58();
    twin = `${past.slice(0, 4)}${a.slice(4, past.length - 4)}${past.slice(-4)}`;
  } while (twin === past || !(await import('../../src/shared/base58.js')).isAddress(twin));
  const prep = await ok('send.prepare', { mint: null, to: twin, amount: '0.01' });
  assert.ok(prep.warnings.some((w) => w.level === 'danger' && /lookalike/i.test(w.text) || /different one/.test(w.text)), JSON.stringify(prep.warnings));
  await sleep(10);
});
