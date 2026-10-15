// Key handling in the account model. Secrets must stay in the background's memory
// (never storage.local, a reply, an error or a page) and be forgotten at lock; a phrase already in plum can't come in
// twice under another spelling; picks can't reach derivations plum doesn't use; a pasted key is read as the chain it's
// for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import * as K from '../../src/background/keys.js';
import * as W from '../../src/background/wallet.js';
import { b64encode, hex, utf8 } from '../../src/shared/bytes.js';
import { fakeNet } from '../fake-net.mjs';
import { ABANDON, PASSWORD, boot } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ctx = await boot();
globalThis.fetch = fakeNet().fetch;
const { fake, ok, err, _test } = ctx;
const seed = K.seedOf(ABANDON);
const SECRETS = {
  phrase: ABANDON,
  'phrase words': 'abandon abandon abandon',
  'wallet 1 sol': K.exportPrivateKey('sol', K.secretAt(seed, 'sol', "m/44'/501'/0'/0'")),
  'wallet 1 eth': hex(K.secretAt(seed, 'eth', "m/44'/60'/0'/0/0")),
  'wallet 1 btc': K.exportPrivateKey('btc', K.secretAt(seed, 'btc', "m/84'/0'/0'/0/0")),
  'seed': hex(seed).slice(0, 32),
};
const ETH_KEY = `0x${'5a'.repeat(32)}`;
const SOL_KEY = Keypair.generate();
const BTC_KEY = K.exportPrivateKey('btc', Uint8Array.from({ length: 32 }, (_, i) => i + 1));
Object.assign(SECRETS, { 'imported eth': ETH_KEY.slice(2), 'imported sol': JSON.stringify([...SOL_KEY.secretKey]).slice(1, 60), 'imported sol b64': b64encode(SOL_KEY.secretKey.subarray(0, 32)), 'imported btc': BTC_KEY });

const leaks = (text) => Object.entries(SECRETS).filter(([, s]) => text.toLowerCase().includes(s.toLowerCase())).map(([k]) => k);

test('withstood: the phrase already in plum, spelled another way (case, spacing, tabs, NBSP, ideographic spaces, full-width letters), is refused as the same account', async () => {
  await ctx.setup();
  const fullWidth = ABANDON.replace(/[a-z]/g, (c) => String.fromCodePoint(c.codePointAt(0) - 0x61 + 0xff41));
  for (const spelling of [
    ABANDON.toUpperCase(), `  ${ABANDON}  `, ABANDON.replace(/ /g, '\t\n '), ABANDON.replace(/ /g, ' '), ABANDON.replace(/ /g, '　'),
    fullWidth, ABANDON.replace('about', 'ABOUT'), ABANDON.normalize('NFKD'),
  ]) {
    assert.match(await err('account.import', { mnemonic: spelling }), /already in plum|isn't valid/, JSON.stringify(spelling));
  }
  assert.equal((await ok('state')).accounts.length, 1);
  // a zero-width space inside a word isn't the same phrase: it isn't a phrase at all
  assert.match(await err('account.import', { mnemonic: ABANDON.replace('about', 'ab​out') }), /isn't valid/);
});

test('withstood: picks can only name plum\'s own derivations, at sane numbers', async () => {
  const other = K.newMnemonic(12);
  for (const picks of [
    [{ scheme: 'toString', index: 0 }], [{ scheme: '__proto__', index: 0 }], [{ scheme: 'cli', index: 1 }], [{ scheme: 'bip44change', index: 1.5 }],
    [{ scheme: 'bip44change', index: -1 }], [{ scheme: 'bip44change', index: 10_000 }], [{ scheme: 'bip44change', index: '3' }], [null],
    Array.from({ length: 51 }, (_, i) => ({ scheme: 'bip44change', index: i })), 'all', [],
  ]) {
    assert.ok(await err('account.import', { mnemonic: other, picks }), JSON.stringify(picks).slice(0, 60));
  }
  assert.equal((await ok('state')).accounts.length, 1);
  // duplicates collapse into one
  const s = await ok('account.import', { mnemonic: other, picks: [{ scheme: 'bip44change', index: 2 }, { scheme: 'bip44change', index: 2 }] });
  const added = s.accounts.find((a) => a.kind === 'phrase' && a.id !== s.accounts[0].id);
  assert.equal(s.wallets.filter((w) => w.account === added.id).length, 1);
  await ok('account.remove', { id: added.id });
});

test('withstood: a pasted key is read as the chain it belongs to, and malformed ones are refused with a reason that never repeats the key', async () => {
  assert.equal((await ok('checkKey', { secret: ETH_KEY })).chain, 'eth');
  assert.equal((await ok('checkKey', { secret: ETH_KEY.slice(2).toUpperCase() })).chain, 'eth');
  assert.equal((await ok('checkKey', { secret: `  ${BTC_KEY}\n` })).chain, 'btc');
  assert.equal((await ok('checkKey', { secret: JSON.stringify([...SOL_KEY.secretKey]) })).chain, 'sol');
  assert.equal((await ok('checkKey', { secret: K.exportPrivateKey('sol', SOL_KEY.secretKey.subarray(0, 32)) })).address, SOL_KEY.publicKey.toBase58());
  // (note: a Solana secret written as 64 hex characters is read as an Ethereum key; checkKey shows the chain and
  // address before anything is imported, so it's a surprise, not a loss)
  assert.equal((await ok('checkKey', { secret: Buffer.from(SOL_KEY.secretKey.subarray(0, 32)).toString('hex') })).chain, 'eth');
  const testnetWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
  const uncompressed = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
  for (const bad of [testnetWif, uncompressed, `0X${'5a'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`, `${BTC_KEY.slice(0, -1)}z`, '[1,2,3]', 'SECRETMARKER123zzz', JSON.stringify([...SOL_KEY.secretKey.subarray(0, 32), ...Keypair.generate().publicKey.toBytes()])]) {
    const e = await err('checkKey', { secret: bad });
    assert.ok(!e.includes(bad.slice(4, 20)), `the error repeats the key: ${e}`);
  }
});

test('withstood: no secret reaches storage.local, a reply to plum\'s pages beyond the export you asked for, or a page', async () => {
  await ok('importKey', { secret: ETH_KEY, name: 'k eth' });
  await ok('importKey', { secret: JSON.stringify([...SOL_KEY.secretKey]), name: 'k sol' });
  await ok('importKey', { secret: BTC_KEY, name: 'k btc' });
  const s = await ok('state');
  await ok('wallet.select', { id: s.wallets[0].id });
  // sign something on each chain path a page can reach
  const page = fake.page('https://leak.example/');
  const evm = (method, params) => page.request('evm', { method, params });
  const ask = evm('eth_requestAccounts');
  await ok('approval.resolve', { id: (await ctx.nextApproval()).id, approve: true });
  await ask;
  const msg = evm('personal_sign', ['0x6869', ETH_ME]);
  await ok('approval.resolve', { id: (await ctx.nextApproval()).id, approve: true });
  const replies = [JSON.stringify(await msg), JSON.stringify(await page.request('evm', { method: 'eth_accounts', params: [] }))];
  for (const m of ['scanPhrase', 'checkKey', 'account.phrase', 'wallet.export', 'state', 'sites']) replies.push(JSON.stringify(await page.request(m, { mnemonic: ABANDON, secret: ETH_KEY, id: s.accounts[0].id, password: PASSWORD })));
  for (const m of ['scanPhrase', 'account.phrase', 'wallet.export']) replies.push(JSON.stringify(await evm(m, [{ mnemonic: ABANDON, password: PASSWORD }])));
  assert.deepEqual(leaks(replies.join('\n')), [], 'a page saw a secret');
  const local = JSON.stringify(await fake.browser.storage.local.get());
  assert.deepEqual(leaks(local), [], 'storage.local holds a secret');
  const { dataKey } = await fake.browser.storage.session.get('dataKey');
  assert.ok(!local.includes(dataKey), 'the data key is on disk');
  const sessionRest = JSON.stringify(Object.fromEntries(Object.entries(await fake.browser.storage.session.get()).filter(([k]) => k !== 'dataKey')));
  assert.deepEqual(leaks(sessionRest), []);
  const shown = JSON.stringify(await ok('state'));
  assert.deepEqual(leaks(shown), [], "plum's state carries a secret");
  // the exports you ask for, with your password, are the only way out, and only on the wallet's own chain
  const keysWallet = s.wallets.find((w) => w.name === 'k eth');
  assert.match(await err('wallet.export', { id: keysWallet.id, chain: 'btc', password: PASSWORD }), /missing|no btc/);
  assert.match(await err('wallet.export', { id: keysWallet.id, chain: 'eth', password: 'wrong' }), /wrong password/);
  assert.equal(await ok('wallet.export', { id: keysWallet.id, chain: 'eth', password: PASSWORD }), ETH_KEY);
});

test('withstood: locking forgets the data key, the seeds and every derived key (the cached bytes are zeroed), and nothing signs after', async () => {
  const digest = new Uint8Array(32).fill(3);
  await W.signEthAs(ETH_ME, digest);
  assert.ok(W._test.derived.size > 0 && W._test.seeds.size > 0);
  const cached = [...W._test.derived.values()].map((b) => b);
  const seeds = [...W._test.seeds.values()].map((b) => b);
  await ok('lock');
  assert.equal(W._test.derived.size, 0);
  assert.equal(W._test.seeds.size, 0);
  assert.ok([...cached, ...seeds].every((b) => b.every((x) => x === 0)), 'a cached secret survived the lock');
  assert.deepEqual(await fake.browser.storage.session.get('dataKey'), {});
  await assert.rejects(W.signEthAs(ETH_ME, digest), /locked/);
  await assert.rejects(W.signSolAs('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', utf8('x')), /locked/);
  await ok('unlock', { password: PASSWORD });
});

test('withstood: a key that is already one of your phrase\'s wallets, or a phrase holding an imported key, is refused', async () => {
  assert.match(await err('importKey', { secret: SECRETS['wallet 1 sol'] }), /already in plum/);
  assert.match(await err('importKey', { secret: `0x${SECRETS['wallet 1 eth']}` }), /already in plum/);
  assert.match(await err('importKey', { secret: SECRETS['wallet 1 btc'] }), /already in plum/);
  const phrase = K.newMnemonic(12);
  await ok('importKey', { secret: `0x${hex(K.secretAt(K.seedOf(phrase), 'eth', "m/44'/60'/0'/0/0"))}`, name: 'its wallet 1' });
  assert.match(await err('account.import', { mnemonic: phrase }), /imported key/);
  assert.equal(_test.pending.size, 0);
});
