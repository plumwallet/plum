// The background end to end, in Node: setting up (a new phrase, a phrase brought along, a key), accounts and their
// wallets, a Solana site and an Ethereum site connecting, every kind of request approved or refused, locking,
// phishing, and sends on Solana, Ethereum and Bitcoin. The browser's APIs and the chains are stand-ins
// (fake-browser.mjs, fake-net.mjs); the code under test is plum's own, unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction as BtcTx, address as btcAddress } from 'bitcoinjs-lib';
import { encodeFunctionData, keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress } from 'viem';
import { base58Decode } from '../src/shared/base58.js';
import { b64decode, b64encode, utf8 } from '../src/shared/bytes.js';
import { readTx } from '../src/shared/tx.js';
import { addressOf, schemePaths, secretAt, seedOf } from '../src/background/keys.js';
import { fakeBrowser, fakeChain } from './fake-browser.mjs';
import { fakeNet } from './fake-net.mjs';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const BTC_ME = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const PASSWORD = 'plum password 1';
/** wallet n of the "abandon" phrase on a chain, worked out here for setting up the stand-in chains */
const abandonAt = (chain, n) => addressOf(chain, secretAt(seedOf(ABANDON), chain, schemePaths('bip44change', n)[chain]));

const fake = fakeBrowser();
globalThis.browser = fake.browser;
const chain = fakeChain({ [ME]: 10_000_000_000n });
const net = fakeNet();
const { transport } = await import('../src/background/rpc.js');
transport.post = (url, body) => chain.post(url, body);
globalThis.fetch = net.fetch;
// the phishing list as if it had been fetched
await fake.browser.storage.local.set({ phish: { block: ['evil-drainer.com'], allow: [], at: Date.now() } });
const { start, _test } = await import('../src/background/main.js');
start();

const ok = async (method, params) => {
  const r = await fake.ui(method, params);
  assert.ok(r?.ok, `${method}: ${r?.error}`);
  return r.result;
};
const err = async (method, params) => {
  const r = await fake.ui(method, params);
  assert.ok(r && !r.ok, `${method} should fail`);
  return r.error;
};
const nextApproval = async () => {
  for (let i = 0; i < 100 && !_test.pending.size; i++) await new Promise((r) => setTimeout(r, 5));
  return ok('approval.get');
};
const legacyTx = (payer, to, lamports = 1000) => b64encode(new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' }).add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports })).serialize({ requireAllSignatures: false, verifySignatures: false }));
const PK = async (s) => new (await import('@solana/web3.js')).PublicKey(s);
const stored = async () => JSON.stringify(await fake.browser.storage.local.get());

/* ------------------------------------------------------------ setting up */

test('a new wallet, made right in the popup: a fresh phrase sealed at once, its words back once, a wallet on every chain', async () => {
  assert.equal((await ok('state')).hasVault, false);
  assert.equal(await err('create', { password: 42, words: 12 }), 'a password has to be text');
  const { state, phrase } = await ok('create', { password: PASSWORD, words: 24, name: 'main', icon: 'frog' });
  assert.equal(phrase.split(' ').length, 24);
  assert.ok(state.hasVault && state.unlocked);
  assert.equal(state.accounts.length, 1);
  assert.deepEqual([state.accounts[0].kind, state.accounts[0].words, state.accounts[0].backedUp], ['phrase', 24, false]);
  const [w] = state.wallets;
  assert.deepEqual([w.name, w.icon, w.scheme, w.index], ['main', 'frog', 'bip44change', 0]);
  const seed = seedOf(phrase);
  for (const c of ['sol', 'eth', 'btc']) assert.equal(w.chains[c].address, addressOf(c, secretAt(seed, c, schemePaths('bip44change', 0)[c])), c);
  assert.match(w.chains.eth.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(w.chains.btc.address, /^bc1q/);
  assert.ok(fake.alarms.has('plum-autolock'), 'the auto-lock timer runs');
  assert.ok(!(await stored()).includes(phrase.split(' ').slice(0, 3).join(' ')), 'the phrase is never stored in the clear');
  assert.equal((await ok('account.backedUp', { id: state.accounts[0].id })).accounts[0].backedUp, true);
  assert.equal(await ok('account.phrase', { id: state.accounts[0].id, password: PASSWORD }), phrase);
  await ok('reset', { confirm: 'reset' });
});

test('restoring a phrase: wallet 1 is the same on every chain as Phantom shows it', async () => {
  const s = await ok('restore', { password: PASSWORD, mnemonic: ABANDON });
  assert.equal(s.wallets.length, 1);
  const w = s.wallets[0];
  assert.deepEqual([w.chains.sol.address, w.chains.eth.address, w.chains.btc.address], [ME, ETH_ME, BTC_ME]);
  assert.deepEqual([w.chains.sol.path, w.chains.eth.path, w.chains.btc.path], ["m/44'/501'/0'/0'", "m/44'/60'/0'/0/0", "m/84'/0'/0'/0/0"]);
  assert.equal(s.accounts[0].backedUp, true, 'a phrase you brought is already written down');
  assert.equal(await err('restore', { password: PASSWORD, mnemonic: ABANDON }), 'plum already has a wallet: reset it in settings first');
});

test("only plum's own pages can use its controls", async () => {
  assert.equal(await fake.ui('state', {}, 'https://evil.example/'), undefined);
  assert.equal(await fake.ui('wallet.export', { id: 'x', chain: 'sol', password: PASSWORD }, 'https://evil.example/'), undefined);
});

test('pages: https and this computer only, top frame only', async () => {
  assert.ok(fake.page('http://evil.example/').port.disconnected, 'plain http is refused');
  assert.ok(fake.page('https://site.example/', { frameId: 3 }).port.disconnected, 'iframes are refused');
  assert.ok(fake.page('https://site.example/', { id: 'other@ext' }).port.disconnected, 'other extensions are refused');
  assert.ok(!fake.page('http://localhost:3000/').port.disconnected, 'your own dev server works');
  assert.ok(!fake.page('https://site.example/').port.disconnected);
});

/* ------------------------------------------------------------ a Solana site */

const app = fake.page('https://app.example.com/trade');

test('a Solana site connects only after you approve it', async () => {
  assert.deepEqual((await app.request('accounts')).result, []);
  assert.deepEqual((await app.request('connect', { silent: true })).result, [], 'a silent connect never opens a window');
  const answer = app.request('connect');
  const view = await nextApproval();
  assert.equal(view.kind, 'connect');
  assert.equal(view.chain, 'sol');
  assert.equal(view.host, 'app.example.com');
  assert.equal(view.connected, false);
  assert.equal(fake.created.at(-1).type, 'popup');
  await ok('approval.resolve', { id: view.id, approve: true });
  assert.deepEqual((await answer).result, [ME]);
  assert.deepEqual((await app.request('connect')).result, [ME], 'a connected site gets in without asking again');
  assert.equal((await ok('sites'))[0].origin, 'https://app.example.com');
});

test('a site that is not connected can ask for nothing', async () => {
  const other = fake.page('https://other.example/');
  const r = await other.request('signMessage', { account: ME, message: b64encode(utf8('hi')) });
  assert.match(r.error.message, /connect to Plum first/);
});

test('signing a message: shown as text, signed by the right key', async () => {
  const answer = app.request('signMessage', { account: ME, message: b64encode(utf8('Sign in to app.example.com\nnonce 42')) });
  const view = await nextApproval();
  assert.equal(view.kind, 'message');
  assert.equal(view.message.text, 'Sign in to app.example.com\nnonce 42');
  await ok('approval.resolve', { id: view.id, approve: true });
  const { result } = await answer;
  assert.ok(ed25519.verify(b64decode(result.signature), utf8('Sign in to app.example.com\nnonce 42'), base58Decode(ME)));
});

test('a "message" that is really a transaction is refused before you even see it', async () => {
  const tx = legacyTx(Keypair.generate().publicKey, Keypair.generate().publicKey);
  const r = await app.request('signMessage', { account: ME, message: tx });
  assert.match(r.error.message, /its bytes are/);
  assert.equal(_test.pending.size, 0);
});

test('signing a transaction: previewed, then signed in your slot', async () => {
  const b64 = legacyTx(await PK(ME), Keypair.generate().publicKey, 250_000_000);
  const answer = app.request('signTransaction', { account: ME, chain: 'solana:mainnet', transactions: [b64] });
  const view = await nextApproval();
  assert.equal(view.kind, 'sign');
  assert.equal(view.txCount, 1);
  const [p] = await ok('approval.preview', { id: view.id });
  assert.equal(p.sol, String(-250_000_000 - 5000));
  assert.deepEqual(p.warnings, []);
  await ok('approval.resolve', { id: view.id, approve: true });
  const { result } = await answer;
  const signed = Transaction.from(Buffer.from(b64decode(result[0])));
  assert.ok(signed.verifySignatures(), 'web3.js verifies the signature');
});

test("transactions that don't need you, the wrong account, or junk are refused at once", async () => {
  const notMine = legacyTx(Keypair.generate().publicKey, Keypair.generate().publicKey);
  assert.match((await app.request('signTransaction', { account: ME, transactions: [notMine] })).error.message, /doesn't ask for the connected account/);
  assert.match((await app.request('signTransaction', { account: Keypair.generate().publicKey.toBase58(), transactions: [notMine] })).error.message, /isn't the one connected/);
  assert.match((await app.request('signTransaction', { account: ME, transactions: ['AAAA'] })).error.message, /can't read this transaction/);
  assert.match((await app.request('signTransaction', { account: ME, transactions: [] })).error.message, /between 1 and 20/);
  assert.match((await app.request('signTransaction', { account: ME, chain: 'solana:moon', transactions: [legacyTx(await PK(ME), Keypair.generate().publicKey)] })).error.message, /doesn't know the chain/);
});

test("the network is plum's: a site asking on another one is refused, and a switch mid-request voids it", async () => {
  const tx = legacyTx(await PK(ME), Keypair.generate().publicKey);
  const r = await app.request('signTransaction', { account: ME, chain: 'solana:devnet', transactions: [tx] });
  assert.match(r.error.message, /wants devnet, but plum is on mainnet/);
  const answer = app.request('signTransaction', { account: ME, transactions: [tx] });
  const v = await nextApproval();
  await ok('settings.set', { patch: { network: 'devnet' } });
  assert.match(await err('approval.resolve', { id: v.id, approve: true }), /network changed/);
  await ok('approval.reject', { id: v.id });
  assert.equal((await answer).error.code, 4001);
  await ok('settings.set', { patch: { network: 'mainnet' } });
});

test('saying no, or closing the window, tells the site "rejected"', async () => {
  const a = app.request('signMessage', { account: ME, message: b64encode(utf8('one')) });
  const v = await nextApproval();
  await ok('approval.reject', { id: v.id });
  assert.equal((await a).error.code, 4001);
  const b = app.request('signMessage', { account: ME, message: b64encode(utf8('two')) });
  await nextApproval();
  const [winId] = [...fake.windows.keys()].slice(-1);
  fake.closeWindow(winId);
  assert.equal((await b).error.code, 4001);
});

test("sign in with Solana: the standard's text, and a mismatched domain needs your say-so", async () => {
  const a = app.request('signIn', { account: ME, input: { domain: 'app.example.com', statement: 'welcome back', nonce: 'abc12345', uri: 'https://app.example.com/login' } });
  const v = await nextApproval();
  assert.equal(v.signIn.text, `app.example.com wants you to sign in with your Solana account:\n${ME}\n\nwelcome back\n\nURI: https://app.example.com/login\nNonce: abc12345`);
  assert.deepEqual(v.signIn.problems, []);
  await ok('approval.resolve', { id: v.id, approve: true });
  const r = (await a).result;
  assert.ok(ed25519.verify(b64decode(r.signature), b64decode(r.signedMessage), base58Decode(ME)));

  const b = app.request('signIn', { account: ME, input: { domain: 'phantom.app' } });
  const v2 = await nextApproval();
  assert.match(v2.signIn.problems[0], /phantom\.app, but the site asking is app\.example\.com/);
  assert.match(await err('approval.resolve', { id: v2.id, approve: true }), /doesn't match/);
  await ok('approval.reject', { id: v2.id });
  await b;
  assert.match((await app.request('signIn', { account: ME, input: { statement: 'line one\nURI: https://evil' } })).error.message, /malformed/);
});

test('a blocklisted site is stopped unless you insist', async () => {
  const evil = fake.page('https://claim.evil-drainer.com/');
  const a = evil.request('connect');
  const v = await nextApproval();
  assert.equal(v.risk.level, 'blocked');
  assert.match(await err('approval.resolve', { id: v.id, approve: true }), /phishing blocklist/);
  await ok('approval.reject', { id: v.id });
  assert.equal((await a).error.code, 4001);
  const look = fake.page('https://phantom-wallet-claim.com/');
  const b = look.request('connect');
  const v2 = await nextApproval();
  assert.deepEqual(v2.risk, { level: 'lookalike', match: 'phantom.app' });
  await ok('approval.reject', { id: v2.id });
  await b;
});

test('locked: connected sites still see the address, but nothing gets signed until you unlock', async () => {
  await ok('lock');
  assert.equal((await ok('state')).unlocked, false);
  assert.equal(await err('balances', { chain: 'sol' }), 'plum is locked');
  assert.deepEqual((await app.request('connect')).result, [ME]);
  const a = app.request('signMessage', { account: ME, message: b64encode(utf8('locked?')) });
  const v = await nextApproval();
  assert.equal(v.unlocked, false);
  assert.equal(await err('approval.resolve', { id: v.id, approve: true }), 'plum is locked');
  assert.equal(await err('unlock', { password: 'wrong password' }), 'wrong password');
  await ok('unlock', { password: PASSWORD });
  await ok('approval.resolve', { id: v.id, approve: true });
  assert.ok((await a).result.signature);
});

test('wrong passwords slow down after the third', async () => {
  await ok('lock');
  for (let i = 0; i < 3; i++) assert.equal(await err('unlock', { password: `nope nope ${i}` }), 'wrong password');
  assert.match(await err('unlock', { password: PASSWORD }), /try again in/);
  await fake.browser.storage.local.remove('tries');
  await ok('unlock', { password: PASSWORD });
});

test('the auto-lock alarm and the computer locking both lock plum', async () => {
  fake.fireAlarm('plum-autolock');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ok('state')).unlocked, false);
  await ok('unlock', { password: PASSWORD });
  fake.fireIdle('idle');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ok('state')).unlocked, true, 'only idle: stays open');
  fake.fireIdle('locked');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ok('state')).unlocked, false);
  await ok('unlock', { password: PASSWORD });
});

test('sending SOL: one signer (you), previewed, signed, sent', async () => {
  const to = Keypair.generate().publicKey.toBase58();
  const prep = await ok('send.prepare', { chain: 'sol', token: null, to, amount: '1.25' });
  const t = readTx(_test.prepared.get(prep.id).bytes);
  assert.equal(t.required, 1, 'exactly one signer');
  assert.equal(t.keys[0], ME, 'you pay the fee');
  assert.equal(prep.preview.sol, String(-1_250_000_000 - 5000));
  assert.ok(prep.warnings.some((w) => /haven't sent to this address/.test(w.text)));
  const done = await ok('send.submit', { id: prep.id });
  const signed = Transaction.from(Buffer.from(b64decode(chain.sentTxs.at(-1))));
  assert.ok(signed.verifySignatures());
  assert.equal(signed.signatures.length, 1);
  assert.match(done.explorer, /^https:\/\/solscan\.io\/tx\//);
  assert.deepEqual((await fake.browser.storage.local.get('recents')).recents.sol, [to]);
  assert.match(await err('send.submit', { id: prep.id }), /expired/);
});

test('sending: lookalike addresses and bad amounts are caught', async () => {
  const past = (await fake.browser.storage.local.get('recents')).recents.sol[0];
  // a poisoned address: same first and last four characters as one you've used
  let twin;
  do {
    const a = Keypair.generate().publicKey.toBase58();
    twin = `${past.slice(0, 4)}${a.slice(4, past.length - 4)}${past.slice(-4)}`;
  } while (base58Decode(twin).length !== 32 || twin === past);
  const prep = await ok('send.prepare', { chain: 'sol', to: twin, amount: '0.01' });
  assert.ok(prep.warnings.some((w) => w.level === 'danger' && /different one/.test(w.text)));
  assert.match(await err('send.prepare', { chain: 'sol', to: 'not-an-address', amount: '1' }), /isn't a Solana address/);
  assert.match(await err('send.prepare', { chain: 'sol', to: Keypair.generate().publicKey.toBase58(), amount: '0.0001' }), /at least 0.00089088 SOL/);
  assert.match(await err('send.prepare', { chain: 'sol', to: Keypair.generate().publicKey.toBase58(), amount: 'lots' }), /type an amount/);
});

/* ------------------------------------------------------------ accounts and their wallets */

test("+ new wallet: the phrase's next wallet, on every chain; a site connected to the first sees nothing of it", async () => {
  const before = fake.tabMessages.length;
  const acct = (await ok('state')).accounts[0];
  const s = await ok('wallet.add', { account: acct.id });
  assert.equal(s.wallets.length, 2);
  const w2 = s.wallets[1];
  assert.deepEqual([w2.name, w2.index, w2.account], ['wallet 2', 1, acct.id]);
  assert.deepEqual([w2.chains.sol.address, w2.chains.eth.address, w2.chains.btc.address], [abandonAt('sol', 1), abandonAt('eth', 1), abandonAt('btc', 1)]);
  assert.notEqual(w2.icon, s.wallets[0].icon, 'a new wallet wears an icon of its own');
  assert.equal(s.active, w2.id, 'the new wallet is the one you are in');
  assert.ok(fake.tabMessages.length > before, 'tabs were told');
  assert.deepEqual((await app.request('accounts')).result, [], "the site doesn't get the new wallet: you connected another one there");
  const ask = app.request('connect');
  const v = await nextApproval();
  assert.equal(v.account.address, w2.chains.sol.address);
  await ok('approval.resolve', { id: v.id, approve: true });
  assert.deepEqual((await ask).result, [w2.chains.sol.address], 'until you connect it too');
  await ok('wallet.select', { id: s.wallets[0].id });
});

test('+ new account: a second recovery phrase with its own wallets; the same phrase twice is refused', async () => {
  const made = await ok('account.new', { words: 12, name: 'savings', icon: 'whale' });
  assert.equal(made.phrase.split(' ').length, 12);
  const acct = made.state.accounts.find((a) => a.id === made.account);
  assert.deepEqual([acct.name, acct.kind, acct.words, acct.backedUp], ['savings', 'phrase', 12, false]);
  const w = made.state.wallets.find((x) => x.account === made.account);
  assert.deepEqual([w.name, w.icon], ['wallet 1', 'whale']);
  assert.equal(w.chains.sol.address, addressOf('sol', secretAt(seedOf(made.phrase), 'sol', "m/44'/501'/0'/0'")));
  assert.equal(made.state.active, w.id);
  assert.equal(await ok('account.phrase', { id: made.account, password: PASSWORD }), made.phrase);
  assert.equal(await err('account.phrase', { id: made.account, password: 'nope nope nope' }), 'wrong password');
  await fake.browser.storage.local.remove('tries');
  assert.match(await err('account.import', { mnemonic: ABANDON, picks: [{ scheme: 'bip44change', index: 0 }] }), /already in plum, as account 1/);
  assert.match(await err('account.import', { mnemonic: made.phrase.toUpperCase().replace(/ /g, '   '), picks: [{ scheme: 'bip44change', index: 0 }] }), /already in plum, as savings/);
  await ok('account.rename', { id: made.account, name: 'cold' });
  assert.equal((await ok('state')).accounts.find((a) => a.id === made.account).name, 'cold');
  // an account's last wallet goes with the account, not on its own
  assert.match(await err('wallet.remove', { id: w.id }), /remove the account instead/);
  const after = await ok('account.remove', { id: made.account });
  assert.ok(!after.accounts.some((a) => a.id === made.account));
  assert.ok(!after.wallets.some((x) => x.account === made.account));
  assert.notEqual(after.active, w.id, 'you are moved to a wallet that still exists');
  assert.match(await err('account.phrase', { id: made.account, password: PASSWORD }), /no recovery phrase/);
  await ok('wallet.select', { id: after.wallets[0].id });
});

test('import an account: the wallets you pick from a phrase, the first named after nothing you typed', async () => {
  const { phrase } = await ok('account.new', { words: 24 });
  const made = (await ok('state')).accounts.at(-1);
  await ok('account.remove', { id: made.id });
  const s = await ok('account.import', { mnemonic: phrase, picks: [{ scheme: 'bip44change', index: 0 }, { scheme: 'bip44change', index: 2 }, { scheme: 'bip44', index: 0 }], name: 'brought', icon: 'cat' });
  const acct = s.accounts.find((a) => a.name === 'brought');
  const mine = s.wallets.filter((w) => w.account === acct.id);
  assert.deepEqual(mine.map((w) => [w.name, w.scheme, w.index, w.icon]), [['wallet 1', 'bip44change', 0, 'cat'], ['wallet 3', 'bip44change', 2, 'cat'], ['old wallet 1', 'bip44', 0, 'cat']]);
  assert.deepEqual(Object.keys(mine[2].chains), ['sol', 'eth'], "Phantom's older grouping has Solana and Ethereum only");
  assert.equal(mine[2].chains.eth.path, "m/44'/60'/1'/0/0");
  assert.match(await err('account.import', { mnemonic: phrase, picks: [] }), /already in plum|pick at least one/);
  await ok('account.remove', { id: acct.id });
  await ok('wallet.select', { id: (await ok('state')).wallets[0].id });
});

test('private keys: Solana, Ethereum and Bitcoin, told apart by their shape, each a wallet of its own in "imported keys"', async () => {
  const sol = Keypair.generate();
  const ethKey = secp256k1.utils.randomSecretKey();
  const ethHex = `0x${Buffer.from(ethKey).toString('hex')}`;
  const btcKey = secp256k1.utils.randomSecretKey();
  const { createBase58check } = await import('@scure/base');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const wif = createBase58check(sha256).encode(Uint8Array.from([0x80, ...btcKey, 1]));
  assert.deepEqual(await ok('checkKey', { secret: JSON.stringify([...sol.secretKey]) }), { chain: 'sol', address: sol.publicKey.toBase58() });
  const ethInfo = await ok('checkKey', { secret: ethHex });
  assert.equal(ethInfo.chain, 'eth');
  assert.equal(ethInfo.address, addressOf('eth', ethKey));
  assert.deepEqual(await ok('checkKey', { secret: wif }), { chain: 'btc', address: addressOf('btc', btcKey) });
  assert.match(await err('checkKey', { secret: 'not a key at all' }), /paste a Solana key/);

  await ok('importKey', { secret: JSON.stringify([...sol.secretKey]), name: 'hot', icon: 'frog' });
  await ok('importKey', { secret: ethHex.slice(2), name: 'metamask' });
  const s = await ok('importKey', { secret: wif, name: 'electrum' });
  const keysAcct = s.accounts.find((a) => a.kind === 'keys');
  assert.equal(keysAcct.name, 'imported keys');
  const byName = Object.fromEntries(s.wallets.filter((w) => w.account === keysAcct.id).map((w) => [w.name, w]));
  assert.deepEqual(Object.keys(byName.hot.chains), ['sol']);
  assert.deepEqual(Object.keys(byName.metamask.chains), ['eth']);
  assert.deepEqual(Object.keys(byName.electrum.chains), ['btc']);
  assert.equal(byName.hot.icon, 'frog');
  assert.equal(await err('checkKey', { secret: ethHex }), 'that wallet is already in plum');
  // exports give each key back in its chain's own format, after the password
  assert.equal(await err('wallet.export', { id: byName.hot.id, chain: 'sol', password: 'nope nope nope' }), 'wrong password');
  await fake.browser.storage.local.remove('tries');
  assert.deepEqual([...base58Decode(await ok('wallet.export', { id: byName.hot.id, chain: 'sol', password: PASSWORD }))], [...sol.secretKey]);
  assert.equal(await ok('wallet.export', { id: byName.metamask.id, chain: 'eth', password: PASSWORD }), ethHex);
  assert.equal(await ok('wallet.export', { id: byName.electrum.id, chain: 'btc', password: PASSWORD }), wif);
  assert.match(await err('wallet.export', { id: byName.metamask.id, chain: 'sol', password: PASSWORD }), /no sol address/);
  // a phrase wallet exports each chain's key too
  const first = s.wallets[0];
  assert.equal(await ok('wallet.export', { id: first.id, chain: 'eth', password: PASSWORD }), `0x${Buffer.from(secretAt(seedOf(ABANDON), 'eth', "m/44'/60'/0'/0/0")).toString('hex')}`);
  // names and icons
  assert.equal((await ok('wallet.icon', { id: byName.hot.id, icon: 'heart' })).wallets.find((x) => x.id === byName.hot.id).icon, 'heart');
  assert.equal(await err('wallet.icon', { id: byName.hot.id, icon: '<img src=x>' }), 'pick one of the icons');
  assert.equal((await ok('wallet.rename', { id: byName.hot.id, name: '  hot   2 ' })).wallets.find((x) => x.id === byName.hot.id).name, 'hot 2');
  // a key's wallet is erased with its key; when the last one goes, so does "imported keys"
  for (const w of Object.values(byName)) await ok('wallet.remove', { id: w.id });
  const after = await ok('state');
  assert.ok(!after.accounts.some((a) => a.kind === 'keys'));
  await ok('wallet.select', { id: after.wallets[0].id });
});

test('revoking a site, or the site disconnecting: it sees no account any more', async () => {
  assert.deepEqual((await app.request('accounts')).result, [ME]);
  await ok('sites.revoke', { origin: 'https://app.example.com' });
  assert.deepEqual((await app.request('accounts')).result, []);
  const again = app.request('connect');
  await ok('approval.resolve', { id: (await nextApproval()).id, approve: true });
  assert.deepEqual((await again).result, [ME]);
  assert.equal((await app.request('disconnect')).result, true);
  assert.deepEqual((await app.request('accounts')).result, [], 'disconnect forgets the site');
  assert.deepEqual((await app.request('connect', { silent: true })).result, []);
});

/* ------------------------------------------------------------ an Ethereum site (EIP-1193) */

const dex = fake.page('https://app.uniswap.example/');
const evm = (method, params) => dex.request('evm', { method, params });

test('an Ethereum site: chain 1 only, connects after you approve, and its connection is its own', async () => {
  assert.equal((await evm('eth_chainId')).result, '0x1');
  assert.equal((await evm('net_version')).result, '1');
  assert.deepEqual((await evm('eth_accounts')).result, []);
  const answer = evm('eth_requestAccounts');
  const v = await nextApproval();
  assert.deepEqual([v.kind, v.chain, v.account.address], ['evmConnect', 'eth', ETH_ME]);
  await ok('approval.resolve', { id: v.id, approve: true });
  assert.deepEqual((await answer).result, [ETH_ME]);
  assert.deepEqual((await evm('eth_accounts')).result, [ETH_ME]);
  assert.deepEqual((await evm('eth_requestAccounts')).result, [ETH_ME], 'connected: no second prompt');
  // the Solana side of the same site knows nothing
  assert.deepEqual((await dex.request('accounts')).result, []);
  assert.equal((await evm('wallet_switchEthereumChain', [{ chainId: '0x1' }])).result, null);
  assert.equal((await evm('wallet_switchEthereumChain', [{ chainId: '0x89' }])).error.code, 4902);
  assert.match((await evm('eth_sign', [ETH_ME, '0x' + '11'.repeat(32)])).error.message, /never signs eth_sign/);
  assert.match((await evm('eth_signTransaction', [{ from: ETH_ME }])).error.message, /only to send them itself/);
  assert.match((await evm('wallet_doSomethingElse')).error.message, /doesn't support/);
});

test('personal_sign: the message as text, signed with Ethereum\'s prefix by your key', async () => {
  const answer = evm('personal_sign', [`0x${Buffer.from('log in to uniswap\nnonce 9').toString('hex')}`, ETH_ME]);
  const v = await nextApproval();
  assert.equal(v.kind, 'evmMessage');
  assert.equal(v.message.text, 'log in to uniswap\nnonce 9');
  await ok('approval.resolve', { id: v.id, approve: true });
  const sig = (await answer).result;
  assert.equal(await recoverMessageAddress({ message: 'log in to uniswap\nnonce 9', signature: sig }), ETH_ME);
  // the other order of params some sites use, and another address refused
  const flipped = evm('personal_sign', [ETH_ME, 'plain text']);
  await ok('approval.resolve', { id: (await nextApproval()).id, approve: true });
  assert.equal(await recoverMessageAddress({ message: 'plain text', signature: (await flipped).result }), ETH_ME);
  assert.match((await evm('personal_sign', ['0x00', '0x000000000000000000000000000000000000dEaD'])).error.message, /isn't the one connected/);
});

const MAIL = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
    Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
  },
  primaryType: 'Mail',
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  message: { from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' }, to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }, contents: 'Hello, Bob!' },
};

test('typed data (EIP-712): read field by field, signed so the site recovers your address', async () => {
  const answer = evm('eth_signTypedData_v4', [ETH_ME, JSON.stringify(MAIL)]);
  const v = await nextApproval();
  assert.equal(v.kind, 'evmTyped');
  assert.equal(v.typed.primaryType, 'Mail');
  assert.equal(v.typed.domain.name, 'Ether Mail');
  assert.deepEqual(v.typed.lines.map((l) => l.path), ['from.name', 'from.wallet', 'to.name', 'to.wallet', 'contents']);
  assert.deepEqual(v.typed.warnings, []);
  await ok('approval.resolve', { id: v.id, approve: true });
  const sig = (await answer).result;
  assert.equal(await recoverTypedDataAddress({ ...MAIL, signature: sig }), ETH_ME);
});

test('a permit, or typed data for another chain, is a danger that needs your "i understand"', async () => {
  const permit = {
    types: { EIP712Domain: MAIL.types.EIP712Domain, Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit',
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    message: { owner: ETH_ME, spender: '0x000000000000000000000000000000000000dEaD', value: ((1n << 256n) - 1n).toString(), nonce: '0', deadline: '9999999999' },
  };
  const answer = evm('eth_signTypedData_v4', [ETH_ME, JSON.stringify(permit)]);
  const v = await nextApproval();
  assert.ok(v.typed.warnings.some((w) => w.level === 'danger' && /permit: signing lets 0x000000000000000000000000000000000000dEaD spend all of your USD Coin/.test(w.text)));
  assert.match(await err('approval.resolve', { id: v.id, approve: true }), /i understand/);
  await ok('approval.resolve', { id: v.id, approve: true, ignoreRisk: true });
  assert.equal(await recoverTypedDataAddress({ ...permit, message: { ...permit.message, value: BigInt(permit.message.value), nonce: 0n, deadline: 9999999999n }, signature: (await answer).result }), ETH_ME);

  const other = evm('eth_signTypedData_v4', [ETH_ME, { ...MAIL, domain: { ...MAIL.domain, chainId: 56 } }]);
  const v2 = await nextApproval();
  assert.ok(v2.typed.warnings.some((w) => w.level === 'danger' && /another chain \(id 56\)/.test(w.text)));
  await ok('approval.reject', { id: v2.id });
  assert.equal((await other).error.code, 4001);
  assert.match((await evm('eth_signTypedData_v4', [ETH_ME, '{"types":{},"primaryType":"Nope","message":{}}'])).error.message, /no type Nope/);
});

test('eth_sendTransaction: simulated, plum sets the nonce and fee, your key alone signs, MEV Blocker first', async () => {
  const to = '0x1111111111111111111111111111111111111111';
  net.eth.balances.set(ETH_ME.toLowerCase(), 10n ** 18n);
  net.eth.nonces.set(ETH_ME.toLowerCase(), 7n);
  net.eth.simulate = (call) => ({ status: '0x1', returnData: '0x', gasUsed: '0x5208', logs: [{ address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(24)}${call.from.slice(2).toLowerCase()}`, `0x${'0'.repeat(24)}${call.to.slice(2).toLowerCase()}`], data: call.value }] });
  const answer = evm('eth_sendTransaction', [{ from: ETH_ME, to, value: '0x2386f26fc10000', nonce: '0x0', gasPrice: '0x1' }]);
  const v = await nextApproval();
  assert.equal(v.kind, 'evmTx');
  const [p] = await ok('approval.preview', { id: v.id });
  assert.equal(p.sim.ok, true);
  assert.deepEqual(p.changes.map((c) => [c.symbol, c.delta]), [['ETH', '-10000000000000000']]);
  assert.deepEqual(p.warnings, []);
  const sentBefore = net.eth.sent.length;
  await ok('approval.resolve', { id: v.id, approve: true });
  const hash = (await answer).result;
  const raw = net.eth.sent.at(-1);
  assert.equal(net.eth.sent.length, sentBefore + 1, 'sent once');
  assert.equal(net.eth.calls.filter(([, m]) => m === 'eth_sendRawTransaction').at(-1)[0], 'rpc.mevblocker.io', 'MEV Blocker first');
  assert.equal(hash, keccak256(raw));
  const tx = parseTransaction(raw);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, 1);
  assert.equal(tx.nonce, 7, "plum's nonce, not the site's");
  assert.equal(tx.to, to);
  assert.equal(tx.value, 10n ** 16n);
  assert.equal(tx.maxPriorityFeePerGas, net.eth.tip);
  assert.equal(tx.maxFeePerGas, net.eth.baseFee * 2n + net.eth.tip, "plum's fee, not the site's gas price");
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME, 'one signer: your wallet');
});

test('an unlimited token approval is named as a danger and needs your "i understand"', async () => {
  const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], args: ['0x000000000000000000000000000000000000dEaD', (1n << 256n) - 1n] });
  net.eth.simulate = null; // this RPC can't simulate: plum reads the call itself
  const answer = evm('eth_sendTransaction', [{ from: ETH_ME, to: token, data }]);
  const v = await nextApproval();
  const [p] = await ok('approval.preview', { id: v.id });
  assert.equal(p.sim.ok, null);
  assert.ok(p.warnings.some((w) => w.level === 'warn' && /can't simulate/.test(w.text)));
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /spend all of your tokens/.test(w.text)));
  assert.equal(p.call.name, 'approve');
  assert.match(await err('approval.resolve', { id: v.id, approve: true }), /i understand/);
  await ok('approval.reject', { id: v.id });
  assert.equal((await answer).error.code, 4001);
});

/* ------------------------------------------------------------ your own Ethereum and Bitcoin sends */

test('sending ETH and an ERC-20 token: one signer (you), your nonce, the fee shown, sent', async () => {
  const to = '0x2222222222222222222222222222222222222222';
  net.eth.balances.set(ETH_ME.toLowerCase(), 2n * 10n ** 18n);
  net.eth.nonces.set(ETH_ME.toLowerCase(), 3n);
  const prep = await ok('send.prepare', { chain: 'eth', token: null, to, amount: '0.5' });
  assert.equal(prep.chain, 'eth');
  assert.deepEqual(prep.preview.changes, [{ symbol: 'ETH', decimals: 18, delta: String(-(5n * 10n ** 17n)), verified: true }]);
  assert.equal(BigInt(prep.preview.fee.max), 21_000n * (net.eth.baseFee * 2n + net.eth.tip));
  assert.ok(prep.warnings.some((w) => /haven't sent to this address/.test(w.text)));
  const done = await ok('send.submit', { id: prep.id });
  const raw = net.eth.sent.at(-1);
  assert.equal(done.signature, keccak256(raw));
  assert.match(done.explorer, /^https:\/\/etherscan\.io\/tx\/0x/);
  const tx = parseTransaction(raw);
  assert.deepEqual([tx.to, tx.value, tx.nonce, tx.gas], [to, 5n * 10n ** 17n, 3, 21_000n]);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME);
  // a token
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  net.eth.tokens.set(usdc, { decimals: 6, symbol: 'USDC', name: 'USD Coin', price: 1, balances: new Map([[ETH_ME.toLowerCase(), 250_000_000n]]) });
  const t = await ok('send.prepare', { chain: 'eth', token: usdc, to, amount: '12.5' });
  assert.deepEqual(t.preview.changes, [{ symbol: 'USDC', decimals: 6, delta: '-12500000', verified: true }]);
  await ok('send.submit', { id: t.id });
  const ttx = parseTransaction(net.eth.sent.at(-1));
  assert.equal(ttx.to.toLowerCase(), usdc);
  assert.equal(ttx.value ?? 0n, 0n);
  assert.equal(ttx.data, encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], args: [to, 12_500_000n] }));
  assert.equal(await recoverTransactionAddress({ serializedTransaction: net.eth.sent.at(-1) }), ETH_ME);
  assert.match(await err('send.prepare', { chain: 'eth', token: usdc, to, amount: '1000' }), /you have 250 of it/);
  assert.match(await err('send.prepare', { chain: 'eth', to, amount: '5' }), /not enough ETH/);
  assert.match(await err('send.prepare', { chain: 'eth', to: '0x9858efFD232B4033E47d90003D41EC34EcaEda94', amount: '0.1' }), /typo/);
  // everything but the most a plain transfer's fee can cost: 2 ETH - 21,000 gas x 3.5 gwei
  assert.equal(await ok('send.max', { chain: 'eth' }), '1.9999265');
});

test('sending BTC: coins picked, change back to you, every input signed by your key alone, the fee exact', async () => {
  net.btc.utxos.set(BTC_ME, [
    { txid: 'aa'.repeat(32), vout: 0, value: 60_000 },
    { txid: 'bb'.repeat(32), vout: 1, value: 25_000 },
    { txid: 'cc'.repeat(32), vout: 2, value: 1_000, confirmed: false },
  ]);
  const to = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const prep = await ok('send.prepare', { chain: 'btc', to, amount: '0.0007', speed: 'normal' });
  assert.equal(prep.preview.feeRate, 10);
  assert.equal(prep.preview.inputs, 2, 'the two biggest coins');
  const done = await ok('send.submit', { id: prep.id });
  const raw = net.btc.broadcast.at(-1);
  const tx = BtcTx.fromHex(raw);
  assert.equal(done.signature, tx.getId());
  assert.match(done.explorer, /^https:\/\/mempool\.space\/tx\//);
  assert.equal(tx.ins.length, 2);
  const outs = tx.outs.map((o) => [btcAddress.fromOutputScript(o.script), BigInt(o.value)]);
  assert.deepEqual(outs[0], [to, 70_000n]);
  assert.equal(outs[1][0], BTC_ME, 'the change comes back to you');
  const fee = 85_000n - outs.reduce((n, [, v]) => n + v, 0n);
  assert.equal(String(fee), prep.preview.fee);
  const myHash = btcAddress.fromBech32(BTC_ME).data;
  for (const [i, input] of tx.ins.entries()) {
    const [sig, pub] = input.witness;
    const { hash160 } = await import('../src/background/keys.js');
    assert.equal(Buffer.from(hash160(pub)).toString('hex'), Buffer.from(myHash).toString('hex'), `input ${i} is signed by your key`);
    const script = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(myHash), Buffer.from([0x88, 0xac])]);
    const value = [60_000, 25_000][i];
    const digest = tx.hashForWitnessV0(i, script, BigInt(value), BtcTx.SIGHASH_ALL);
    assert.ok(secp256k1.verify(sig.subarray(0, -1), digest, pub, { prehash: false, format: 'der' }), `input ${i}'s signature verifies`);
    assert.equal(input.sequence, 0xfffffffd, 'replace-by-fee is on');
  }
  assert.match(await err('send.prepare', { chain: 'btc', to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: '0.0001' }), /testnet/);
  assert.match(await err('send.prepare', { chain: 'btc', to, amount: '0.00000100' }), /at least 546 sats/);
  assert.match(await err('send.prepare', { chain: 'btc', to, amount: '1' }), /more than this wallet holds/);
});

/* ------------------------------------------------------------ what a phrase holds */

test('scanning a phrase finds every used wallet, on any chain, and offers the first three', async () => {
  net.eth.nonces.set(abandonAt('eth', 1).toLowerCase(), 4n); // wallet 2 used on Ethereum
  net.btc.stats.set(abandonAt('btc', 3), { funded: 5000, spent: 0, txs: 1 }); // wallet 4 holds bitcoin
  net.btc.stats.set(abandonAt('btc', 9), { funded: 0, spent: 0, txs: 2 }); // wallet 10 has history: the scan goes on past it
  net.btc.stats.set(abandonAt('btc', 14), { funded: 0, spent: 0, txs: 1 }); // and finds wallet 15
  const found = await ok('scanPhrase', { mnemonic: ABANDON });
  const used = found.filter((f) => f.used).map((f) => `${f.scheme}:${f.index}`);
  assert.deepEqual(used, ['bip44change:0', 'bip44change:1', 'bip44change:3', 'bip44change:9', 'bip44change:14']);
  assert.deepEqual(found.filter((f) => !f.used).map((f) => `${f.scheme}:${f.index}`), ['bip44change:2'], "the first three are offered even when they're empty");
  const w1 = found[0];
  assert.deepEqual([w1.chains.sol.used, w1.chains.sol.amount], [true, '10000000000']);
  assert.equal(found.find((f) => f.index === 3).chains.btc.amount, '5000');
  assert.match(await err('scanPhrase', { mnemonic: 'abandon abandon' }), /isn't valid/);
});

test('a closed tab takes its waiting requests with it', async () => {
  const page = fake.page('https://short.example/');
  const a = page.request('connect');
  await nextApproval();
  page.close();
  assert.match((await a).error?.message ?? '', /page closed/);
  assert.equal(_test.pending.size, 0);
});

test('reset forgets everything of yours (the phishing list stays, so plum is never left unguarded)', async () => {
  assert.equal(await err('reset', { confirm: 'yes' }), 'type reset to confirm');
  const s = await ok('reset', { confirm: 'reset' });
  assert.equal(s.hasVault, false);
  assert.deepEqual(Object.keys(await fake.browser.storage.local.get()), ['phish']);
});

test('a wallet restored with a name and an icon: the first wallet takes the name, the rest are numbered, all wear the icon', async () => {
  const s = await ok('restore', { password: PASSWORD, mnemonic: ABANDON, picks: [{ scheme: 'bip44change', index: 0 }, { scheme: 'bip44change', index: 1 }], name: 'main', icon: 'cat' });
  assert.deepEqual(s.wallets.map((w) => w.name), ['main', 'main 2']);
  assert.deepEqual(s.wallets.map((w) => w.icon), ['cat', 'cat']);
  assert.equal(s.wallets[0].chains.sol.address, ME);
  await ok('reset', { confirm: 'reset' });
});
