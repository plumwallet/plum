// Attack: a malicious page floods plum with requests in one tick. The per-origin cap (5 waiting) and the single
// approval window are both enforced only after awaits, so concurrent requests slip past them (TOCTOU).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { b64encode, utf8 } from '../../src/shared/bytes.js';
import { ME, boot, sleep } from './helpers.mjs';

const ctx = await boot();
const { fake, _test, ok, rejectAll } = ctx;
const popups = () => fake.created.filter((o) => o.type === 'popup').length;
let app;

test('before a wallet exists: a page cannot make plum open a window per request (5 connects -> at most 1 window)', async () => {
  const pre = fake.page('https://presetup.example/');
  const before = fake.created.length;
  await Promise.all([1, 2, 3, 4, 5].map(() => pre.request('connect')));
  const opened = fake.created.length - before;
  // set up for the rest of the file whatever happens
  await ctx.setup();
  app = await ctx.connectSite('https://app.example.com/');
  fake.closeWindow([...fake.windows.keys()].at(-1)); // the user closes the approval window after connecting, as people do
  assert.ok(opened <= 1, `5 connects before setup opened ${opened} windows`);
});

test('flood: 12 concurrent requests from one origin stay within the 5-waiting cap', async () => {
  const reqs = Array.from({ length: 12 }, (_, i) => app.request('signMessage', { account: ME, message: b64encode(utf8(`flood ${i}`)) }));
  await sleep(50);
  const waiting = _test.pending.size;
  try {
    assert.ok(waiting <= 5, `the cap is 5 waiting requests per origin, but ${waiting} are queued`);
  } finally {
    await rejectAll();
    await Promise.allSettled(reqs);
  }
});

test('flood: concurrent requests open exactly one approval window, never a window per request', async () => {
  for (const id of [...fake.windows.keys()]) fake.closeWindow(id);
  const before = popups();
  const reqs = Array.from({ length: 12 }, (_, i) => app.request('signMessage', { account: ME, message: b64encode(utf8(`windows ${i}`)) }));
  await sleep(50);
  const opened = popups() - before;
  try {
    assert.equal(opened, 1, `a 12-request flood opened ${opened} approval windows (each one focused, in Firefox)`);
  } finally {
    await rejectAll();
    await Promise.allSettled(reqs);
    for (const id of [...fake.windows.keys()]) fake.closeWindow(id);
  }
});

test('flood: 20 subdomains of one attacker share one allowance of 5, and one click clears them all', async () => {
  const pages = [];
  for (let i = 0; i < 20; i++) pages.push(await ctx.connectSite(`https://s${i}.attacker.example/`));
  const reqs = [];
  for (const p of pages) for (let i = 0; i < 5; i++) reqs.push(p.request('signMessage', { account: ME, message: b64encode(utf8(`q${i}`)) }));
  await sleep(100);
  const queued = _test.pending.size;
  const real = await ctx.connectSite('https://real-dapp.example/');
  const legit = real.request('signMessage', { account: ME, message: b64encode(utf8('the one the user wants')) });
  await sleep(20);
  try {
    assert.ok(queued <= 5, `one site may keep 5 requests waiting, whatever its subdomains; ${queued} are queued`);
    const view = await ok('approval.get');
    assert.equal(view.site, 'attacker.example');
    assert.ok(view.siteQueue >= 1 && view.siteQueue <= 5);
    assert.equal(await ok('approval.rejectSite', { id: view.id }), view.siteQueue, 'every request from that site is rejected at once');
    assert.equal((await ok('approval.get')).origin, 'https://real-dapp.example', 'and the real request is next');
  } finally {
    await rejectAll();
    await Promise.allSettled([...reqs, legit]);
  }
});

test('queue integrity: a request that disappears cannot be approved by its stale id, and the next one is not approved in its place', async () => {
  const a = app.request('signMessage', { account: ME, message: b64encode(utf8('first')) });
  await sleep(10);
  const page2 = await ctx.connectSite('https://second.example/');
  const b = page2.request('signMessage', { account: ME, message: b64encode(utf8('second')) });
  await sleep(10);
  const shown = await ok('approval.get');
  assert.equal(shown.origin, 'https://app.example.com');
  const firstId = shown.id;
  app.close(); // the first page goes away while the window still shows its request
  assert.match((await a).error.message, /page closed/);
  const r = await fake.ui('approval.resolve', { id: firstId, approve: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /gone/);
  assert.equal(_test.pending.size, 1, 'the second request is still waiting, untouched');
  assert.equal((await ok('approval.get')).origin, 'https://second.example');
  await rejectAll();
  await b;
});
