// A Ledger in plum, end to end: plum's real background on a fake browser and fake chains, with a software Ledger
// (test/fake-ledger.mjs) on another recovery phrase behind it. Adding one (the background reads the addresses, the page
// only picks), the vault keeping them true across unlocks, and every kind of signature a site or plum itself asks for:
// approved in plum's window first, then on the device, and checked before it goes anywhere. Every transaction plum
// builds for a Ledger wallet has exactly one signer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Transaction as BtcTx } from 'bitcoinjs-lib';
import { Transaction } from '@solana/web3.js';
import { parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress } from 'viem';
import { base58Encode } from '../src/shared/base58.js';
import { b64decode, concat, hex, u32le, u64le } from '../src/shared/bytes.js';
import { readTx } from '../src/shared/tx.js';
import * as B from '../src/background/btc.js';
import * as E from '../src/background/eth.js';
import { addressOf, hash160, secretAt, seedOf } from '../src/background/keys.js';
import { PASSWORD, PK, boot, legacyB64, pk, sleep, transferIx } from './redteam/helpers.mjs';
import { fakeLedger } from './fake-ledger.mjs';
import { fakeNet } from './fake-net.mjs';

export const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const seed = seedOf(LEGAL);
const L = { sol: addressOf('sol', secretAt(seed, 'sol', "m/44'/501'/0'/0'")), eth: addressOf('eth', secretAt(seed, 'eth', "m/44'/60'/0'/0/0")), btc: addressOf('btc', secretAt(seed, 'btc', "m/84'/0'/0'/0/0")) };

const T = await boot({ balances: { [L.sol]: 5_000_000_000n } });
const net = fakeNet();
globalThis.fetch = net.fetch;
await T.setup();
const D = await import('../src/background/ledger/device.js');
const dev = fakeLedger({ mnemonic: LEGAL, app: 'Solana' });
D._setOpener(dev.opener);
D._setWait(2000);

let ledgerWallet = null;

test('adding a Ledger: plum reads its addresses on each chain itself, opening each app, and the page only picks', async () => {
  const scan = await T.ok('ledger.scan', { chains: ['sol', 'eth', 'btc'] });
  const row = scan.rows.find((r) => r.key === 'plum:0');
  assert.equal(row.chains.sol.address, L.sol);
  assert.equal(row.chains.eth.address, L.eth);
  assert.equal(row.chains.btc.address, L.btc);
  assert.equal(row.chains.sol.path, "m/44'/501'/0'/0'");
  assert.deepEqual(scan.rows.map((r) => r.key), ['plum:0', 'plum:1', 'plum:2']);
  // Solana was open; plum closed it and opened Ethereum, then Bitcoin
  assert.equal(dev.openRequests, 2);
  // the page can't name an address, only pick what the device gave
  assert.match(await T.err('ledger.add', { id: scan.id, keys: ['plum:9'] }), /malformed/);
  assert.match(await T.err('ledger.add', { id: 'made-up', keys: ['plum:0'] }), /old/);
  const s = await T.ok('ledger.add', { id: scan.id, keys: ['plum:0', 'plum:1'], name: '' });
  const acct = s.accounts.find((a) => a.kind === 'ledger');
  assert.equal(acct.name, 'ledger');
  const mine = s.wallets.filter((w) => w.account === acct.id);
  assert.deepEqual(mine.map((w) => [w.name, w.scheme]), [['wallet 1', 'ledger'], ['wallet 2', 'ledger']]);
  assert.equal(s.active, mine[0].id);
  ledgerWallet = mine[0];
  // the same wallets again: already in plum
  const again = await T.ok('ledger.scan', { chains: ['sol'] });
  assert.ok(again.rows.find((r) => r.key === 'plum:0').added);
  assert.match(await T.err('ledger.add', { id: again.id, keys: ['plum:0'] }), /already in plum/);
});

test("a Ledger wallet's addresses are the vault's: one swapped on disk is put back at the next unlock", async () => {
  const store = T.fake.browser.storage.local;
  const { wallets } = await store.get('wallets');
  const w = wallets.find((x) => x.id === ledgerWallet.id);
  w.chains.sol.address = base58Encode(new Uint8Array(32).fill(66));
  w.chains.eth.address = '0x000000000000000000000000000000000000dEaD';
  // and a "Ledger" wallet the vault never had
  wallets.push({ ...w, id: 'planted', name: 'planted', chains: { sol: { address: base58Encode(new Uint8Array(32).fill(67)), path: "m/44'/501'/5'/0'" } } });
  await store.set({ wallets });
  await T.ok('lock');
  await T.ok('unlock', { password: PASSWORD });
  const s = await T.ok('state');
  const back = s.wallets.find((x) => x.id === ledgerWallet.id);
  assert.equal(back.chains.sol.address, L.sol);
  assert.equal(back.chains.eth.address, L.eth);
  assert.ok(!s.wallets.some((x) => x.id === 'planted'));
  // and its keys are never plum's to export
  assert.match(await T.err('wallet.export', { id: ledgerWallet.id, chain: 'sol', password: PASSWORD }), /on your Ledger/);
});

test("a site's Solana transaction is signed on the Ledger only after plum's approval, and checked", async () => {
  await T.ok('wallet.select', { id: ledgerWallet.id });
  const page = await T.connectSite('https://app.example.org');
  const reviews = dev.reviews;
  const b64 = legacyB64(PK(L.sol), [transferIx(PK(L.sol), pk(), 1234)]);
  const answer = page.request('signTransaction', { account: L.sol, transactions: [b64] });
  const v = await T.nextApproval();
  assert.equal(v.ledger.app, 'Solana');
  assert.match(v.ledger.note, /approve it there too/);
  // nothing reached the device before you approved
  await sleep(50);
  assert.equal(dev.reviews, reviews);
  await T.ok('approval.resolve', { id: v.id, approve: true });
  const r = await answer;
  const signed = Transaction.from(Buffer.from(r.result[0], 'base64'));
  assert.ok(signed.verifySignatures());
  assert.equal(dev.reviews, reviews + 1);
});

test('turned down on the Ledger: the site gets a no (4001), and nothing is left waiting', async () => {
  const page = await T.connectSite('https://app2.example.org');
  dev.decide = 'reject';
  const answer = page.request('signTransaction', { account: L.sol, transactions: [legacyB64(PK(L.sol), [transferIx(PK(L.sol), pk(), 5)])] });
  const v = await T.nextApproval();
  const e = await T.ui('approval.resolve', { id: v.id, approve: true });
  assert.equal(e.code, 'ledger-rejected');
  assert.equal((await answer).error.code, 4001);
  assert.equal(T._test.pending.size, 0);
  dev.decide = 'approve';
});

test("a Ledger that isn't ready keeps the request in the window, to try again once it is", async () => {
  const page = await T.connectSite('https://app3.example.org');
  dev.connected = false;
  const answer = page.request('signTransaction', { account: L.sol, transactions: [legacyB64(PK(L.sol), [transferIx(PK(L.sol), pk(), 6)])] });
  const v = await T.nextApproval();
  const first = await T.ui('approval.resolve', { id: v.id, approve: true });
  assert.equal(first.code, 'ledger-connect');
  assert.ok(T._test.pending.has(v.id), 'the request is still there');
  dev.connected = true;
  dev.locked = true;
  const second = await T.ui('approval.resolve', { id: v.id, approve: true });
  assert.equal(second.code, 'ledger-locked');
  dev.locked = false;
  await T.ok('approval.resolve', { id: v.id, approve: true });
  assert.ok((await answer).result);
});

test('rejecting in plum while the Ledger waits stops the device, and the site gets a no', async () => {
  const page = await T.connectSite('https://app4.example.org');
  dev.decide = 'wait';
  const answer = page.request('signTransaction', { account: L.sol, transactions: [legacyB64(PK(L.sol), [transferIx(PK(L.sol), pk(), 7)])] });
  const v = await T.nextApproval();
  const working = T.ui('approval.resolve', { id: v.id, approve: true });
  while (!dev.waiting) await sleep(5);
  assert.equal((await T.ok('ledger.status')).state, 'confirm');
  await T.ok('approval.reject', { id: v.id });
  assert.equal((await answer).error.code, 4001);
  assert.match((await working).error, /rejected it in plum/);
  dev.decide = 'approve';
});

test('a Solana message is signed on the Ledger as an off-chain message; Sign In With Solana is refused plainly', async () => {
  const page = await T.connectSite('https://app5.example.org');
  const text = Buffer.from('hello from a site');
  const answer = page.request('signMessage', { account: L.sol, message: text.toString('base64') });
  const v = await T.nextApproval();
  assert.match(v.ledger.note, /off-chain message/);
  await T.ok('approval.resolve', { id: v.id, approve: true });
  const r = (await answer).result;
  const signed = b64decode(r.signedMessage);
  assert.equal(hex(signed.subarray(signed.length - text.length)), text.toString('hex'));
  assert.ok(signed[0] === 0xff);
  const no = await page.request('signIn', { account: L.sol, input: { domain: 'app5.example.org' } });
  assert.match(no.error.message, /can't sign Sign In With Solana/);
  const binary = await page.request('signMessage', { account: L.sol, message: Buffer.from([1, 2, 3, 0xff]).toString('base64') });
  assert.match(binary.error.message, /only when they're text/);
});

test('Ethereum: personal_sign, typed data and a transaction from a site, each signed on the Ledger', async () => {
  const page = await T.connectSite('https://eth.example.org');
  const connect = page.request('evm', { method: 'eth_requestAccounts', params: [] });
  await T.approveNext();
  assert.deepEqual((await connect).result, [L.eth]);
  // personal_sign
  const msg = page.request('evm', { method: 'personal_sign', params: ['0x68656c6c6f', L.eth] });
  await T.approveNext();
  assert.equal(await recoverMessageAddress({ message: { raw: '0x68656c6c6f' }, signature: (await msg).result }), L.eth);
  // typed data: the device hashes it field by field (the fake signs plum's own digest)
  const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Note: [{ name: 'text', type: 'string' }] }, primaryType: 'Note', domain: { name: 'plum test', chainId: 1 }, message: { text: 'hi' } };
  dev.typedDigest = E.typedDigest(E.parseTypedData(typed));
  const sig = page.request('evm', { method: 'eth_signTypedData_v4', params: [L.eth, JSON.stringify(typed)] });
  const v = await T.nextApproval();
  assert.ok(v.ledger.hashes.domain.startsWith('0x'));
  await T.ok('approval.resolve', { id: v.id, approve: true });
  assert.equal(await recoverTypedDataAddress({ ...typed, signature: (await sig).result }), L.eth);
  assert.ok(dev.typedApdus.length > 4, 'definitions and values went field by field');
  // a transaction
  net.eth.balances.set(L.eth.toLowerCase(), 10n ** 18n);
  const send = page.request('evm', { method: 'eth_sendTransaction', params: [{ from: L.eth, to: '0x000000000000000000000000000000000000dEaD', value: '0x2386f26fc10000' }] });
  const tv = await T.nextApproval();
  await T.ok('approval.preview', { id: tv.id });
  await T.ok('approval.resolve', { id: tv.id, approve: true, ignoreRisk: true });
  assert.ok((await send).result);
  const raw = net.eth.sent.at(-1);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), L.eth);
  assert.equal(parseTransaction(raw).type, 'eip1559');
});

test('every transaction plum builds for a Ledger wallet has exactly one signer: the wallet', async () => {
  // Solana: plum's own send
  const solPrep = await T.ok('send.prepare', { chain: 'sol', to: base58Encode(new Uint8Array(32).fill(44)), amount: '0.01' });
  const t = readTx(T._test.prepared.get(solPrep.id).bytes);
  assert.equal(t.required, 1);
  assert.equal(t.keys[0], L.sol);
  const sent = await T.ok('send.submit', { id: solPrep.id });
  const onChain = readTx(b64decode(T.chain.sentTxs.at(-1)));
  assert.equal(onChain.required, 1);
  assert.equal(base58Encode(onChain.signatures[0]), sent.signature);

  // Ethereum: plum's own send, signed once, by the wallet
  const ethPrep = await T.ok('send.prepare', { chain: 'eth', to: '0x000000000000000000000000000000000000dEaD', amount: '0.001' });
  await T.ok('send.submit', { id: ethPrep.id });
  assert.equal(await recoverTransactionAddress({ serializedTransaction: net.eth.sent.at(-1) }), L.eth);

  // Bitcoin: two coins of the wallet's, each input signed by its one key
  const own = concat(Uint8Array.of(0x00, 0x14), hash160(secp256k1.getPublicKey(secretAt(seed, 'btc', "m/84'/0'/0'/0/0"), true)));
  const prev = [30_000n, 50_000n].map((value, i) => {
    const raw = concat(u32le(2), Uint8Array.of(1), new Uint8Array(32).fill(10 + i), u32le(0), Uint8Array.of(0), u32le(0xffffffff), Uint8Array.of(1), u64le(value), Uint8Array.of(own.length), own, u32le(0));
    const txid = hex(sha256(sha256(raw)).reverse());
    net.btc.raw.set(txid, hex(raw));
    return { txid, vout: 0, value: Number(value), confirmed: true };
  });
  net.btc.utxos.set(L.btc, prev);
  net.btc.stats.set(L.btc, { funded: 80_000, spent: 0, txs: 2 });
  const btcPrep = await T.ok('send.prepare', { chain: 'btc', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0006', speed: 'normal' });
  const plan = T._test.prepared.get(btcPrep.id).plan;
  dev.btcPlan = { index: 0, digests: B.sighashes({ inputs: plan.inputs, outputs: plan.outputs, locktime: 0 }, own.subarray(2)) };
  await T.ok('send.submit', { id: btcPrep.id });
  const tx = BtcTx.fromHex(net.btc.broadcast.at(-1));
  assert.equal(tx.ins.length, 2);
  const keys = new Set(tx.ins.map((i) => hex(i.witness[1])));
  assert.deepEqual([...keys], [hex(secp256k1.getPublicKey(secretAt(seed, 'btc', "m/84'/0'/0'/0/0"), true))]);
});

test('showing an address on the device: it must be the same one', async () => {
  dev.decide = 'approve';
  assert.equal(await T.ok('ledger.show', { chain: 'eth', address: L.eth }), true);
  dev.lie.ethPub = () => secp256k1.getPublicKey(secretAt(seedOf('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), 'eth', "m/44'/60'/0'/0/0"), false);
  dev.lie.ethAddressText = () => '9858effd232b4033e47d90003d41ec34ecaeda94';
  const e = await T.ui('ledger.show', { chain: 'eth', address: L.eth });
  assert.equal(e.code, 'ledger-mismatch');
  dev.lie = {};
});

test('a Ledger account comes out of plum whole: its wallets and their sealed records', async () => {
  const s = await T.ok('state');
  const acct = s.accounts.find((a) => a.kind === 'ledger');
  const two = s.wallets.filter((w) => w.account === acct.id);
  await T.ok('wallet.remove', { id: two[1].id });
  const after = await T.ok('account.remove', { id: acct.id });
  assert.ok(!after.accounts.some((a) => a.kind === 'ledger'));
  assert.ok(!after.wallets.some((w) => w.scheme === 'ledger'));
  // and it doesn't come back at the next unlock
  await T.ok('lock');
  await T.ok('unlock', { password: PASSWORD });
  assert.ok(!(await T.ok('state')).wallets.some((w) => w.scheme === 'ledger'));
  D._setOpener(null);
});
