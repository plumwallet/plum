// Attack (threat 5): someone edits the Firefox profile on disk while plum is locked. storage.local holds the sealed
// vault and, in the clear, the account list, settings, connected sites and the password-try counter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVault } from '../../src/background/vault.js';
import { ME, PASSWORD, boot, pk } from './helpers.mjs';

const ctx = await boot();
const { fake, ok, err, rpcMod } = ctx;
const store = fake.browser.storage.local;

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const BTC_ME = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ATTACKER_ETH = '0x000000000000000000000000000000000000dEaD';
const ATTACKER_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

test('disk edit: swapping your address for the attacker\'s, on any chain, is undone at unlock', async () => {
  await ctx.setup();
  await ok('lock');
  const { wallets } = await store.get('wallets');
  wallets[0].chains.sol.address = pk().toBase58();
  wallets[0].chains.eth.address = ATTACKER_ETH;
  wallets[0].chains.btc.address = ATTACKER_BTC;
  await store.set({ wallets });
  assert.notEqual((await ok('state')).wallets[0].chains.sol.address, ME, 'while locked the planted address shows');
  await ok('unlock', { password: PASSWORD });
  const w = (await ok('state')).wallets[0];
  assert.deepEqual([w.chains.sol.address, w.chains.eth.address, w.chains.btc.address], [ME, ETH_ME, BTC_ME]);
});

test('disk edit: a wallet moved to another number, or given a path, a chain or an account it does not have, is put right at unlock', async () => {
  const s = await ok('wallet.add', { account: (await ok('state')).accounts[0].id });
  await ok('lock');
  const { wallets } = await store.get('wallets');
  wallets[1].index = 5; // another wallet's number, same addresses kept
  wallets[0].chains.sol.path = "m/44'/501'/9'/0'"; // a path (paths are only shown: they're worked out from the number)
  wallets[0].chains.doge = { address: 'D-planted', path: null }; // a chain plum doesn't have
  await store.set({ wallets });
  await ok('unlock', { password: PASSWORD });
  const [w0, w1] = (await ok('state')).wallets;
  assert.notEqual(w1.chains.sol.address, s.wallets[1].chains.sol.address, "the addresses now follow the number (the attacker can't keep one and change the other)");
  assert.equal(w0.chains.sol.address, ME);
  assert.equal(w0.chains.sol.path, "m/44'/501'/0'/0'", 'the shown path is the real one again');
  assert.equal(w0.chains.doge, undefined, 'the planted chain is gone');
});

test('disk edit: an address planted on a wallet that can\'t be rebuilt (a key missing from the vault, an unknown derivation) is dropped, never shown', async () => {
  await ok('lock');
  const { wallets } = await store.get('wallets');
  const planted = { id: 'planted1', account: 'keys', name: 'free money', icon: null, scheme: null, index: null, chains: { eth: { address: ATTACKER_ETH, path: null } } };
  const weird = { ...wallets[0], id: 'planted2', scheme: 'm/0/0', chains: { btc: { address: ATTACKER_BTC, path: "m/84'/0'/0'/0/0" } } };
  await store.set({ wallets: [...wallets, planted, weird] });
  await ok('unlock', { password: PASSWORD });
  const shown = JSON.stringify((await ok('state')).wallets);
  assert.ok(!shown.includes(ATTACKER_ETH) && !shown.includes(ATTACKER_BTC), 'no planted address survives the unlock');
});

test('disk edit: a planted RPC URL that is not https is still used (no re-validation when read)', async () => {
  const { settings } = await store.get('settings');
  await store.set({ settings: { ...(settings ?? {}), rpc: { ...(settings?.rpc ?? {}), mainnet: 'http://evil.example/rpc' } } });
  const seen = [];
  const real = rpcMod.transport.post;
  rpcMod.transport.post = (url, body) => { seen.push(url); return real(url, body); };
  try {
    await ok('balances', { chain: 'sol' });
  } finally {
    rpcMod.transport.post = real;
    await store.set({ settings: { ...(settings ?? {}), rpc: { ...(settings?.rpc ?? {}), mainnet: '' } } });
  }
  assert.ok(seen.length);
  assert.ok(seen.every((u) => /^https:/.test(u)), `plum sent its requests to ${seen[0]}`);
});

test('disk edit: a vault from another install (another password) just fails to unlock; nothing leaks or crashes', async () => {
  const { vault: mine } = await store.get('vault');
  const { vault: theirs } = await createVault('attacker password 1', { mnemonic: 'abandon '.repeat(11) + 'about', keys: {} });
  await ok('lock');
  await store.set({ vault: theirs });
  assert.equal(await err('unlock', { password: PASSWORD }), 'wrong password');
  await store.set({ vault: mine });
  await store.remove('tries');
  await ok('unlock', { password: PASSWORD });
});

test('disk edit: a tampered data box is not counted as a wrong password (no throttle games), and the vault stays shut', async () => {
  const { vault } = await store.get('vault');
  await ok('lock');
  const ct = Buffer.from(vault.data.ct, 'base64');
  ct[10] ^= 0xff;
  await store.set({ vault: { ...vault, data: { ...vault.data, ct: ct.toString('base64') } } });
  const e = await err('unlock', { password: PASSWORD });
  assert.notEqual(e, 'wrong password');
  assert.equal((await store.get('tries')).tries, undefined);
  await store.set({ vault });
  await ok('unlock', { password: PASSWORD });
});

test('documented: planting a site in the connected list trusts it without any approval (disk access = site trust)', async () => {
  const s = await ok('state');
  await ok('wallet.select', { id: s.wallets[0].id });
  const { sites = {} } = await store.get('sites');
  sites['https://planted.example'] = { accounts: [ME], connectedAt: Date.now(), lastUsed: Date.now() };
  await store.set({ sites });
  const page = fake.page('https://planted.example/');
  assert.deepEqual((await page.request('accounts')).result, [ME]);
});
