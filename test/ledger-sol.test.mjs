// A Ledger wallet staking SOL and sending NFTs: what plum builds needs one signature, the Ledger's (which also pays the
// fee), and goes out with that one signature, made on the device. A transaction only Solana's v1 format can hold (a
// compressed NFT deep in a tree with no canopy) is turned down before anything is shown: a Ledger's Solana app can't
// sign v1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '../src/shared/base58.js';
import { b64decode, b64encode, u32le, u64le } from '../src/shared/bytes.js';
import { isSigned, readTx } from '../src/shared/tx.js';
import { addressOf, secretAt, seedOf } from '../src/background/keys.js';
import { compressedAssetId, leafHash, rootOf } from '../src/background/nfts.js';
import { STAKE_PROGRAM, VOTE_PROGRAM, addressWithSeed, stakeSeed } from '../src/background/stake.js';
import { fakeLedger } from './fake-ledger.mjs';
import { fakeNet } from './fake-net.mjs';
import { boot, pk } from './redteam/helpers.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/nfts-mainnet.json', import.meta.url), 'utf8'));
const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ME = addressOf('sol', secretAt(seedOf(LEGAL), 'sol', "m/44'/501'/0'/0'"));
const T = await boot({ balances: { [ME]: 50_000_000_000n } });
const net = fakeNet();
globalThis.fetch = net.fetch;
await T.setup();
const D = await import('../src/background/ledger/device.js');
const dev = fakeLedger({ mnemonic: LEGAL, app: 'Solana' });
D._setOpener(dev.opener);
D._setWait(1500);
const scan = await T.ok('ledger.scan', { chains: ['sol'] });
const added = await T.ok('ledger.add', { id: scan.id, keys: ['plum:0'] });
await T.ok('wallet.select', { id: added.wallets.find((w) => w.scheme === 'ledger').id });
const TO = pk().toBase58();

/** Prepare through plum's own door, count the signers of what was built, send it, and check the one signature the
 * device made. */
async function onLedger(what, method, params, submit) {
  const prep = await T.ok(method, params);
  const built = readTx(T._test.prepared.get(prep.id).bytes);
  assert.equal(built.required, 1, `${what}: ${built.required} signers`);
  assert.equal(built.keys[0], ME, `${what}: the Ledger signs it and pays for it`);
  assert.ok(!built.signatures.some(isSigned), `${what}: nothing signed before the device`);
  const before = T.chain.sentTxs.length;
  const reviews = dev.reviews;
  await T.ok(submit, { id: prep.id });
  assert.equal(dev.reviews - reviews, 1, `${what}: confirmed on the device`);
  const sent = readTx(b64decode(T.chain.sentTxs[before]));
  assert.deepEqual(sent.message, built.message, `${what}: sent as reviewed`);
  assert.equal(sent.signatures.length, 1);
  assert.ok(ed25519.verify(sent.signatures[0], sent.message, base58Decode(ME)), `${what}: the Ledger's signature`);
  return built;
}

const VOTE = pk().toBase58();
T.chain.accounts.set(VOTE, { lamports: 27_074_400, owner: VOTE_PROGRAM, data: [b64encode(new Uint8Array(3762)), 'base64'], executable: false });
const stakeAccount = ({ deact }) => {
  const d = new Uint8Array(200);
  d.set(u32le(2), 0);
  d.set(u64le(2_282_880n), 4);
  d.set(base58Decode(ME), 12);
  d.set(base58Decode(ME), 44);
  d.set(base58Decode(VOTE), 124);
  d.set(u64le(3_000_000_000n), 156);
  d.set(u64le(2n), 164);
  d.set(u64le(deact), 172);
  return { lamports: 3_002_282_880, owner: STAKE_PROGRAM, data: [b64encode(d), 'base64'], executable: false };
};

test('staking with a Ledger: stake, unstake and withdraw, each signed on the device alone', async () => {
  const built = await onLedger('stake', 'stake.prepare', { action: 'stake', vote: VOTE, amount: '3' }, 'stake.submit');
  assert.ok(built.keys.includes(addressWithSeed(ME, stakeSeed(0), STAKE_PROGRAM)), 'the stake account is derived from the Ledger\'s address, not a key of its own');
  const active = pk().toBase58();
  T.chain.accounts.set(active, stakeAccount({ deact: (1n << 64n) - 1n }));
  await onLedger('unstake', 'stake.prepare', { action: 'unstake', account: active }, 'stake.submit');
  const done = pk().toBase58();
  T.chain.accounts.set(done, stakeAccount({ deact: 5n }));
  await onLedger('withdraw', 'stake.prepare', { action: 'withdraw', account: done }, 'stake.submit');
});

const held = new Map();
T.chain.handlers.getTokenAccountsByOwner = ([owner, filter]) => ({
  value: owner === ME && held.has(filter?.mint) ? [{ pubkey: held.get(filter.mint), account: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { mint: filter.mint, tokenAmount: { amount: '1', decimals: 0 } } } } } }] : [],
});
const assets = new Map();
const proofs = new Map();
T.chain.handlers.getAsset = ({ id }) => assets.get(id) ?? null;
T.chain.handlers.getAssetProof = ({ id }) => proofs.get(id) ?? null;
const mine = (a) => ({ ...structuredClone(a), ownership: { ...a.ownership, owner: ME, delegate: null, delegated: false, frozen: false } });

test('an NFT sent from a Ledger: one signature, made on the device', async () => {
  const legacy = mine(FX.das.legacy);
  assets.set(legacy.id, legacy);
  held.set(legacy.id, pk().toBase58());
  await onLedger('legacy NFT', 'nfts.prepare', { chain: 'sol', id: legacy.id, to: TO }, 'nfts.submit');
});

test("a transaction only v1 can hold is turned down for a Ledger before any review, in plain words", async () => {
  // a compressed NFT of the Ledger's in a 30-deep tree with no canopy, with a proof that adds up: too long for 1232 bytes
  const depth = 30;
  const tree = pk().toBase58();
  const nonce = 7n;
  const id = compressedAssetId(tree, nonce);
  const dataHash = pk().toBase58(), creatorHash = pk().toBase58();
  const proof = Array.from({ length: depth }, () => pk().toBase58());
  const leaf = leafHash({ id, owner: ME, delegate: ME, nonce, dataHash, creatorHash, version: 1, collectionHash: null, assetDataHash: null, flags: 0 });
  const header = new Uint8Array(56);
  header[0] = 1;
  header.set(u32le(64), 2);
  header.set(u32le(depth), 6);
  const data = new Uint8Array(56 + 24 + 64 * (40 + 32 * depth) + 32 * depth + 40);
  data.set(header);
  T.chain.accounts.set(tree, { lamports: 1, owner: 'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK', data: [b64encode(data), 'base64'], executable: false });
  assets.set(id, mine({ ...FX.das.compressed, id, compression: { ...FX.das.compressed.compression, tree, leaf_id: Number(nonce), data_hash: dataHash, creator_hash: creatorHash } }));
  proofs.set(id, { root: base58Encode(rootOf(leaf, proof, 7)), proof, leaf: base58Encode(leaf), tree_id: tree, node_index: 2 ** depth + 7 });
  const reviews = dev.reviews;
  const before = T.chain.sentTxs.length;
  const message = await T.err('nfts.prepare', { chain: 'sol', id, to: TO });
  assert.match(message, /too big for a Ledger.*v1/);
  assert.equal(dev.reviews, reviews, 'the device was never asked');
  assert.equal(T.chain.sentTxs.length, before);
  D._setOpener(null);
});
