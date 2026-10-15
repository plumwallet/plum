// Red team: a site that floods plum while a Ledger is waiting for you. The caps still hold (5 waiting per site), none
// of the flood reaches the device (a site's request touches it only after you approve it in plum, and then one at a
// time), approving another request while the device is busy is turned away without losing it, and once the device has
// answered everything carries on. Nothing a page sends can make the device work on its own.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addressOf, secretAt, seedOf } from '../../src/background/keys.js';
import { fakeLedger } from '../fake-ledger.mjs';
import { fakeNet } from '../fake-net.mjs';
import { PK, boot, legacyB64, pk, sleep, transferIx } from './helpers.mjs';

const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SOL = addressOf('sol', secretAt(seedOf(LEGAL), 'sol', "m/44'/501'/0'/0'"));

const T = await boot({ balances: { [SOL]: 5_000_000_000n } });
globalThis.fetch = fakeNet().fetch;
await T.setup();
const D = await import('../../src/background/ledger/device.js');
const dev = fakeLedger({ mnemonic: LEGAL, app: 'Solana' });
D._setOpener(dev.opener);
D._setWait(1500);
const scan = await T.ok('ledger.scan', { chains: ['sol'] });
const added = await T.ok('ledger.add', { id: scan.id, keys: ['plum:0'] });
await T.ok('wallet.select', { id: added.wallets.find((w) => w.scheme === 'ledger').id });
const page = await T.connectSite('https://flood.example.org');
const tx = () => legacyB64(PK(SOL), [transferIx(PK(SOL), pk(), 1)]);

test('a page that floods while the device waits: caps hold, none of it reaches the device, nothing is lost', async () => {
  dev.decide = 'wait';
  const first = page.request('signTransaction', { account: SOL, transactions: [tx()] });
  const v = await T.nextApproval();
  const working = T.ui('approval.resolve', { id: v.id, approve: true });
  while (!dev.waiting) await sleep(5);
  const apdus = dev.log.length;
  // the flood: 40 requests in one go, transactions and messages
  const flood = Array.from({ length: 40 }, (_, i) => (i % 2
    ? page.request('signTransaction', { account: SOL, transactions: [tx()] })
    : page.request('signMessage', { account: SOL, message: Buffer.from(`flood ${i}`).toString('base64') })));
  await sleep(100);
  assert.ok(T._test.pending.size <= 5, `${T._test.pending.size} waiting: the cap is 5 a site`);
  const answered = await Promise.race([Promise.allSettled(flood.slice(5)), sleep(500).then(() => null)]);
  assert.ok(answered, 'the requests past the cap were turned away at once');
  assert.ok(answered.every((r) => r.value?.error?.code === 4100), 'with "already has 5 requests waiting"');
  assert.equal(dev.log.length, apdus, 'not one APDU reached the device');
  // approving another while the device is busy: turned away, and the request stays
  const next = [...T._test.pending.values()].find((r) => r.id !== v.id);
  const busy = await T.ui('approval.resolve', { id: next.id, approve: true });
  assert.equal(busy.code, 'ledger-busy');
  assert.ok(T._test.pending.has(next.id));
  // the device answers; the first request is signed, and the queue carries on
  dev.decide = 'approve';
  dev.press('approve');
  assert.ok((await working).ok);
  assert.ok((await first).result);
  await T.ok('approval.resolve', { id: next.id, approve: true });
  await T.ok('approval.rejectSite', { id: [...T._test.pending.values()][0].id });
  assert.equal(T._test.pending.size, 0);
});

test('requests a page sends never touch the device on their own: only an approval in plum does', async () => {
  const apdus = dev.log.length;
  const reviews = dev.reviews;
  const reqs = [
    ...Array.from({ length: 4 }, () => page.request('signTransaction', { account: SOL, transactions: [tx()] })),
    page.request('signMessage', { account: SOL, message: Buffer.from('hi').toString('base64') }),
  ];
  await sleep(200);
  assert.equal(dev.log.length, apdus);
  assert.equal(dev.reviews, reviews);
  await T.ok('approval.rejectSite', { id: [...T._test.pending.values()][0].id });
  for (const r of await Promise.all(reqs)) assert.equal(r.error.code, 4001);
  assert.equal(dev.log.length, apdus);
});

test("reading the device while it's busy is turned away too (one thing at a time on it)", async () => {
  dev.decide = 'wait';
  const req = page.request('signTransaction', { account: SOL, transactions: [tx()] });
  const v = await T.nextApproval();
  const working = T.ui('approval.resolve', { id: v.id, approve: true });
  while (!dev.waiting) await sleep(5);
  assert.equal((await T.ui('ledger.scan', { chains: ['sol'] })).code, 'ledger-busy');
  assert.equal((await T.ui('ledger.show', { chain: 'sol', address: SOL })).code, 'ledger-busy');
  dev.decide = 'approve';
  dev.press('approve');
  await working;
  assert.ok((await req).result);
});
