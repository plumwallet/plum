// Attack: someone edits the browser profile's storage while plum is locked. The vault is sealed, but the
// account and wallet lists, settings and connected sites are in the clear, and the new account model reads more from
// them: ids, accounts, schemes, numbers, chains. Unlock checks every address against the vault (verifyWallets). What
// can a planted entry still do?
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import * as E from '../../src/background/eth.js';
import * as W from '../../src/background/wallet.js';
import { fakeNet } from '../fake-net.mjs';
import { ABANDON, PASSWORD, boot, sleep } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ATTACKER_ETH = '0x000000000000000000000000000000000000dEaD';
const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { fake, ok, _test } = ctx;
const store = fake.browser.storage.local;
const plantWallets = async (fn) => { const { wallets } = await store.get('wallets'); await store.set({ wallets: fn(structuredClone(wallets)) }); };

async function connectEvm(url) {
  const page = fake.page(url);
  const evm = (method, params) => page.request('evm', { method, params });
  const answer = evm('eth_requestAccounts');
  const v = await ctx.nextApproval();
  await ok('approval.resolve', { id: v.id, approve: true });
  return { page, evm, accounts: (await answer).result };
}

// FINDING (low): derived keys are cached per `${wallet.id}:${chain}` and a cache hit skips the address check, but
// nothing makes wallet ids unique: verifyWallets re-derives each planted wallet's addresses and keeps it, twin id and
// all. Plant a second wallet with the id of your wallet 1 (here pointing at index 7), and once either has signed, the
// other signs with *its* key. End to end: a request a site made for wallet 1 before plum locked is approved after an
// ETH send from the twin, and the site, connected to wallet 1 only, receives a signature by the other wallet's key.
// (Transactions are saved by the recovered-signer checks: Ethereum's signerOf, Bitcoin's hash160; messages and typed
// data have no such check.)
test('FINDING (low): a planted wallet sharing an id with yours makes plum sign with the wrong key', async () => {
  await ctx.setup();
  const { evm } = await connectEvm('https://site-for-wallet-1.example/');
  const answer = evm('personal_sign', ['0x6869', ETH_ME]); // waits in the window while plum locks
  await ctx.nextApproval();
  await ok('lock');
  await plantWallets((ws) => [{ ...ws[0], index: 7, name: 'savings', chains: {} }, ...ws]); // first, so it's the active one
  await ok('unlock', { password: PASSWORD });
  const s = await ok('state');
  const twin = s.wallets.find((w) => w.index === 7);
  const twinEth = twin.chains.eth.address;
  assert.notEqual(twinEth, ETH_ME, 'verifyWallets gave the twin its own (index 7) addresses');
  // you send a little ETH from the twin (the active wallet: it's first under that id)
  await ok('wallet.select', { id: twin.id });
  net.eth.balances.set(twinEth.toLowerCase(), 10n ** 18n);
  const prep = await ok('send.prepare', { chain: 'eth', to: '0x2222222222222222222222222222222222222222', amount: '0.01' });
  await ok('send.submit', { id: prep.id });
  // then answer the request that was waiting for wallet 1
  const v = await ok('approval.get');
  assert.equal(v.account.address, ETH_ME, 'the window says wallet 1 signs');
  await fake.ui('approval.resolve', { id: v.id, approve: true });
  const sig = (await answer).result;
  const signer = sig ? await recoverMessageAddress({ message: { raw: '0x6869' }, signature: sig }) : null;
  // and the bare primitive, for the record
  const digest = new Uint8Array(32).fill(9);
  let direct = null;
  try { direct = E.signerOf(digest, await W.signEthAs(ETH_ME, digest)); } catch { /* refusing is fine */ }
  assert.ok([null, ETH_ME].includes(signer) && [null, ETH_ME].includes(direct), `asked for wallet 1 (${ETH_ME}), plum signed with ${signer} / ${direct} (the planted twin's key)`);
});

// FINDING (low, pre-existing): settings are read from disk unchecked. autolockMin planted as a million minutes keeps
// plum unlocked for two years after the next unlock; the settings screen still offers only 5/15/60/240.
test('FINDING (low, pre-existing): a planted auto-lock time turns auto-lock off', async () => {
  await ok('reset', { confirm: 'reset' });
  await ctx.setup();
  await ok('lock');
  const { settings = {} } = await store.get('settings');
  await store.set({ settings: { ...settings, autolockMin: 1_000_000 } });
  await ok('unlock', { password: PASSWORD });
  const alarm = fake.alarms.get(W.LOCK_ALARM);
  assert.ok([5, 15, 60, 240].includes(alarm?.delayInMinutes), `auto-lock set to ${alarm?.delayInMinutes} minutes`);
});

// FINDING (low): unlock trusts the shape of the clear-text lists and never rebuilds them from the vault. One `null` in
// the wallet list makes unlock fail with a TypeError *after* the vault is open (plum is unlocked, every screen errors,
// only "reset" gets out). Re-running the 0.1.5 migration (schema set back to 1 with an old-style account list, run at
// the next browser start) hides your phrase account: no wallets after unlock, and importing the phrase again is
// refused because the vault still holds it. Both leave reset (which wipes everything else too) as the only way back.
test('FINDING (low): a malformed wallet list breaks unlock, and a re-run migration hides an account for good', async () => {
  await ok('reset', { confirm: 'reset' });
  await ctx.setup();
  await ok('lock');
  await plantWallets((ws) => [null, ...ws]);
  const r = await fake.ui('unlock', { password: PASSWORD });
  const s = await fake.ui('state');
  const problems = [];
  if (!r.ok) problems.push(`unlock: ${r.error}`);
  if (!s.ok) problems.push(`state afterwards: ${s.error} (unlocked: ${JSON.stringify(await fake.browser.storage.session.get('dataKey')) !== '{}'})`);

  await ok('reset', { confirm: 'reset' });
  await ctx.setup();
  await ok('lock');
  await store.set({ schema: 1, accounts: [{ id: 'z1', name: 'account 1', address: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', kind: 'phrase', path: [44, 501, 0, 0] }] });
  await W._test.migrate(); // what the next browser start does
  await ok('unlock', { password: PASSWORD });
  const after = await ok('state');
  if (!after.wallets.length) {
    const again = await fake.ui('account.import', { mnemonic: ABANDON });
    problems.push(`after a re-run migration: no wallets; importing the phrase again: ${again.ok ? 'ok' : again.error}`);
  }
  await ok('reset', { confirm: 'reset' });
  await ctx.setup();
  assert.deepEqual(problems, []);
});

// FINDING (low): names (and icons) on disk reach plum's own approval window as they are: verifyWallets rebuilds
// addresses but never cleans the rest, so a planted name with bidi controls (or a whole fake warning) is drawn in the
// trusted window, beside the wallet that signs.
test('FINDING (low): a planted wallet name with hidden characters is shown in the approval window as written', async () => {
  const { evm } = await connectEvm('https://names.example/');
  await ok('lock');
  await plantWallets((ws) => { ws[0].name = 'main ‮detrevnoc kcab: SAFE'; ws[0].icon = { evil: true }; return ws; });
  await ok('unlock', { password: PASSWORD });
  const answer = evm('personal_sign', ['0x6869', ETH_ME]);
  const v = await ctx.nextApproval();
  await ctx.rejectAll();
  await answer;
  const { hasHidden } = await import('../../src/shared/text.js');
  assert.ok(!hasHidden(v.account.name) && (v.account.icon == null || typeof v.account.icon === 'string'), `the window draws ${JSON.stringify(v.account)}`);
});

/* ------------------------------------------------------------ what plum withstood */

test('withstood: wallets planted under inherited names (__proto__, constructor, toString) or a key the vault holds for another chain are dropped at unlock', async () => {
  await ok('reset', { confirm: 'reset' });
  await ctx.setup();
  await ok('importKey', { password: '', secret: `0x${'42'.repeat(32)}`, name: 'eth key' });
  await ok('lock');
  const { wallets } = await store.get('wallets');
  const ethKey = wallets.find((w) => w.account === 'keys');
  const planted = [
    ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((account, i) => ({ id: `p${i}`, account, name: 'free money', icon: null, scheme: 'bip44change', index: 0, chains: { eth: { address: ATTACKER_ETH, path: "m/44'/60'/0'/0/0" } } })),
    { id: '__proto__', account: 'keys', name: 'x', icon: null, scheme: null, index: null, chains: { eth: { address: ATTACKER_ETH, path: null } } },
    { ...ethKey, id: ethKey.id, chains: { btc: { address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', path: null } } }, // the vault holds an Ethereum key for this id
  ];
  await store.set({ wallets: [...wallets, ...planted] });
  await ok('unlock', { password: PASSWORD });
  const shown = JSON.stringify((await ok('state')).wallets);
  assert.ok(!shown.includes(ATTACKER_ETH) && !shown.includes('bc1qar0'), shown);
  assert.equal((await ok('state')).wallets.length, wallets.length);
});

test('withstood: a wallet planted in your own account at any number only ever holds your own keys', async () => {
  await ok('lock');
  const { wallets } = await store.get('wallets');
  const accountId = wallets.find((w) => w.account !== 'keys').account;
  await store.set({ wallets: [...wallets, { id: 'deep', account: accountId, name: 'deep', icon: null, scheme: 'bip44change', index: 9999, chains: { eth: { address: ATTACKER_ETH, path: "m/44'/60'/0'/0/9999" } } }] });
  await ok('unlock', { password: PASSWORD });
  const deep = (await ok('state')).wallets.find((w) => w.id === 'deep');
  const K = await import('../../src/background/keys.js');
  assert.equal(deep.chains.eth.address, K.addressOf('eth', K.secretAt(K.seedOf(ABANDON), 'eth', "m/44'/60'/0'/0/9999")));
});

test('documented: a site planted in the connected list is trusted on Ethereum without any approval (disk access = site trust)', async () => {
  await ok('wallet.select', { id: (await ok('state')).wallets[0].id });
  const { sites = {} } = await store.get('sites');
  sites['https://planted-evm.example'] = { accounts: [], evm: [ETH_ME], connectedAt: Date.now(), lastUsed: Date.now() };
  await store.set({ sites });
  const page = fake.page('https://planted-evm.example/');
  assert.deepEqual((await page.request('evm', { method: 'eth_accounts', params: [] })).result, [ETH_ME]);
  assert.deepEqual((await page.request('accounts')).result, [], 'and nothing on Solana');
  // a malformed planted entry trusts nothing
  sites['https://planted-bad.example'] = { evm: ETH_ME, accounts: 'x' };
  await store.set({ sites });
  const bad = fake.page('https://planted-bad.example/');
  assert.deepEqual((await bad.request('evm', { method: 'eth_accounts', params: [] })).result, []);
  await sleep(5);
  assert.equal(_test.pending.size, 0);
});
