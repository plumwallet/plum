// The real money path, once, on a local validator with throwaway keys only: plum's own send code builds, signs and
// sends a SOL transfer, and we confirm the signature lands on chain and carries exactly one signature (the sender's).
// Nothing here touches mainnet. Uses test/fake-browser.mjs for the browser APIs, but the RPC transport is the REAL
// localnet (rpc.js's default fetch), not the fake chain.
//   solana-test-validator  (running on 127.0.0.1:8899)  &&  node scripts/redteam/localnet-send.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { fakeBrowser } from '../../test/fake-browser.mjs';
import { readTx } from '../../src/shared/tx.js';
import { b64decode } from '../../src/shared/bytes.js';

const RPC = 'http://127.0.0.1:8899';
// the test-validator faucet (requestAirdrop) is unfunded in this build, so fund the throwaway wallet from the
// validator's own identity keypair via the CLI. Pass its ledger dir with --ledger and the solana binary with --solana.
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const LEDGER = arg('--ledger') ?? join(tmpdir(), 'plumln');
const SOLANA = arg('--solana') ?? 'solana';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (method, params) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, ...(params ? {} : {}) }) }).then((r) => r.json());
const balanceOf = async (addr) => (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr, { commitment: 'confirmed' }] }) }).then((r) => r.json())).result?.value ?? 0;

const fake = fakeBrowser();
globalThis.browser = fake.browser;
// IMPORTANT: do not stub fetch and do not override transport — plum talks to the real local validator.
const { start } = await import('../../src/background/main.js');
start();
const ui = async (method, params = {}) => { const r = await fake.ui(method, params); if (!r?.ok) throw new Error(`${method}: ${r?.error}`); return r.result; };

// a throwaway wallet (fresh random phrase, never used anywhere else)
const mnemonic = await ui('newMnemonic', { words: 12 });
await ui('create', { password: 'localnet throwaway password', mnemonic });
await ui('settings.set', { patch: { network: 'localnet', rpc: { localnet: RPC } } });
const me = (await ui('state')).accounts[0].address;
console.log('> throwaway wallet:', me);

// fund it from the validator's identity keypair (throwaway, local only)
const idKey = `${LEDGER}\\validator-keypair.json`;
const out = execFileSync(SOLANA, ['transfer', me, '2', '--from', idKey, '--fee-payer', idKey, '--url', RPC, '--allow-unfunded-recipient', '--commitment', 'confirmed'], { encoding: 'utf8' });
console.log('> funding transfer:', out.trim().split('\n')[0]);
let funded = 0;
for (let i = 0; i < 40; i++) { funded = await balanceOf(me); if (funded >= 2_000_000_000) break; await sleep(500); }
console.log('> funded with', funded / 1e9, 'SOL');
assert.ok(funded >= 2_000_000_000, 'funding did not land');

// send through plum's own code
const to = Keypair.generate().publicKey.toBase58();
const prep = await ui('send.prepare', { mint: null, to, amount: '0.5' });
console.log('> prepared: sol change', prep.preview.sol, 'fee', prep.preview.fee, 'signers', prep.preview.required, prep.preview.sim.ok ? 'sim ok' : `sim ${prep.preview.sim.error}`);
assert.equal(prep.preview.required, 1, 'plum built a one-signer transaction');
assert.ok(prep.preview.sim.ok, 'the localnet simulation is clean');
const bytes = (await import('../../src/background/main.js'))._test.prepared.get(prep.id).bytes;
const t = readTx(bytes);
assert.equal(t.required, 1);
assert.equal(t.keys[0], me, 'the sender is the fee payer and sole signer');

const done = await ui('send.submit', { id: prep.id });
console.log('> submitted:', done.signature);

let status = null;
for (let i = 0; i < 60; i++) {
  const s = await rpc('getSignatureStatuses', [[done.signature]]);
  status = s.result?.value?.[0];
  if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) break;
  await sleep(500);
}
assert.ok(status && !status.err, `the transfer did not confirm: ${JSON.stringify(status)}`);
console.log('> confirmed on localnet:', status.confirmationStatus);

// read it back from the chain and check exactly one signature slot
let tx = null;
for (let i = 0; i < 30; i++) { tx = await rpc('getTransaction', [done.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); if (tx.result) break; await sleep(500); }
assert.ok(tx.result, 'the transaction is on chain');
const sigCount = readTx(b64decode(tx.result.transaction[0])).signatures.length;
assert.equal(sigCount, 1, 'the on-chain transaction has exactly one signature slot');
const recipientBal = await balanceOf(to);
assert.equal(recipientBal, 500_000_000, 'the recipient received exactly 0.5 SOL');

console.log('\nlocalnet money-path proof passed: plum built, signed (one signer) and landed a 0.5 SOL transfer. Throwaway keys only.');
process.exit(0);
