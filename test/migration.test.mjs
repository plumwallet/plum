// Updating over plum 0.1.5 (the wallet already installed): its one recovery phrase and its "accounts" become an account
// and its wallets, an imported key moves into "imported keys", default names like "account 3" become "wallet 3", and at
// the first unlock every wallet of the phrase gets its Ethereum and Bitcoin addresses and the vault is resealed in the
// new layout. Nothing is lost: the same addresses, names, icons, connected sites and keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { b64encode } from '../src/shared/bytes.js';
import { createVault, unlockVault } from '../src/background/vault.js';
import { fakeBrowser, fakeChain } from './fake-browser.mjs';
import { fakeNet } from './fake-net.mjs';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const BTC_ME = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const PASSWORD = 'the 0.1.5 password';

const fake = fakeBrowser();
globalThis.browser = fake.browser;
const chain = fakeChain({ [ME]: 1_000_000_000n });
const { transport } = await import('../src/background/rpc.js');
transport.post = (url, body) => chain.post(url, body);
globalThis.fetch = fakeNet().fetch;
const store = fake.browser.storage.local;

// what plum 0.1.5 left on disk: a vault holding { mnemonic, keys }, and its account list in the clear
const key = Keypair.generate();
const K = await import('../src/background/keys.js');
const ACC2 = K.addressOf('sol', K.secretAt(K.seedOf(ABANDON), 'sol', "m/44'/501'/1'/0'"));
const OLD3 = K.addressOf('sol', K.secretAt(K.seedOf(ABANDON), 'sol', "m/44'/501'/2'"));
const { vault } = await createVault(PASSWORD, { mnemonic: ABANDON, keys: { k1: b64encode(key.secretKey.subarray(0, 32)) } });
await store.set({
  vault,
  accounts: [
    { id: 'x1', name: 'account 1', icon: 'frog', address: ME, kind: 'phrase', path: [44, 501, 0, 0] },
    { id: 'x2', name: 'dfdf', icon: null, address: ACC2, kind: 'phrase', path: [44, 501, 1, 0] },
    { id: 'x3', name: 'account 3', icon: 'cat', address: OLD3, kind: 'phrase', path: [44, 501, 2] },
    { id: 'k1', name: 'imported 1', icon: 'ghost', address: key.publicKey.toBase58(), kind: 'key', path: null },
  ],
  active: 'x2',
  sites: { 'https://pump.example': { accounts: [ACC2], connectedAt: 1, lastUsed: 2 } },
  settings: { autolockMin: 60, hideZero: false },
  recents: ['11111111111111111111111111111112'],
});

const { start } = await import('../src/background/main.js');
start();
const ok = async (method, params) => {
  const r = await fake.ui(method, params);
  assert.ok(r?.ok, `${method}: ${r?.error}`);
  return r.result;
};

test('locked, right after the update: the same wallets, in their new places, with nothing asked of you', async () => {
  const s = await ok('state');
  assert.deepEqual([s.hasVault, s.unlocked], [true, false]);
  assert.deepEqual(s.accounts.map((a) => [a.id, a.kind, a.name]), [['a1', 'phrase', 'account 1'], ['keys', 'keys', 'imported keys']]);
  assert.deepEqual(s.wallets.map((w) => [w.id, w.account, w.name, w.icon, w.scheme, w.index, w.chains.sol.address]), [
    ['x1', 'a1', 'wallet 1', 'frog', 'bip44change', 0, ME],
    ['x2', 'a1', 'dfdf', null, 'bip44change', 1, ACC2],
    ['x3', 'a1', 'wallet 3', 'cat', 'bip44', 2, OLD3],
    ['k1', 'keys', 'imported 1', 'ghost', null, null, key.publicKey.toBase58()],
  ]);
  assert.equal(s.active, 'x2', "you're still in the wallet you were in");
  assert.equal(s.settings.autolockMin, 60);
  // a site you connected still sees you, before you even unlock
  assert.deepEqual((await fake.page('https://pump.example/').request('accounts')).result, [ACC2]);
});

test('the first unlock: every wallet of the phrase gets its Ethereum and Bitcoin addresses, and the vault is resealed', async () => {
  const s = await ok('unlock', { password: PASSWORD });
  const by = Object.fromEntries(s.wallets.map((w) => [w.id, w]));
  assert.deepEqual([by.x1.chains.eth.address, by.x1.chains.btc.address], [ETH_ME, BTC_ME]);
  assert.deepEqual(Object.keys(by.x2.chains), ['sol', 'eth', 'btc']);
  assert.deepEqual(Object.keys(by.x3.chains), ['sol', 'eth'], "Phantom's older grouping: Solana and Ethereum m/44'/60'/1'/0/n");
  assert.equal(by.x3.chains.eth.path, "m/44'/60'/1'/0/2");
  assert.deepEqual(Object.keys(by.k1.chains), ['sol'], 'an imported Solana key stays a Solana wallet');
  // the vault now holds the new layout, under the same password
  const { vault: now } = await store.get('vault');
  const { data } = await unlockVault(now, PASSWORD);
  assert.deepEqual(Object.keys(data).sort(), ['keys', 'phrases', 'v']);
  assert.equal(data.phrases.a1, ABANDON);
  assert.equal(data.keys.k1.chain, 'sol');
  // and everything still works: the phrase, the key, a new wallet
  assert.equal(await ok('account.phrase', { id: 'a1', password: PASSWORD }), ABANDON);
  assert.equal((await ok('wallet.export', { id: 'k1', chain: 'sol', password: PASSWORD })).length > 80, true);
  const after = await ok('wallet.add', { account: 'a1' });
  assert.equal(after.wallets.at(-1).index, 2, 'the next free number of the phrase (3 is only taken on the older path)');
  assert.equal((await store.get('recents')).recents.length, 1);
});
