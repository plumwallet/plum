// One signer, always: every transaction staking and NFTs build is counted from its own bytes. Each must need exactly one
// signature, the wallet's, which also pays its fee, and arrive unsigned; once sent it carries that one signature and
// nothing else. On Ethereum the sender is recovered from the signed transaction itself.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { base58Decode, base58Encode } from '../src/shared/base58.js';
import { b64decode, b64encode, u32le, u64le } from '../src/shared/bytes.js';
import { isSigned, readTx } from '../src/shared/tx.js';
import { STAKE_PROGRAM, VOTE_PROGRAM, addressWithSeed, stakeSeed } from '../src/background/stake.js';
import { compressedAssetId, leafHash, metadataAddress, rootOf } from '../src/background/nfts.js';
import { fakeNet } from './fake-net.mjs';
import { ME, boot, pk } from './redteam/helpers.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/nfts-mainnet.json', import.meta.url), 'utf8'));
const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ctx = await boot({ balance: 50_000_000_000n });
const net = fakeNet();
globalThis.fetch = net.fetch;
await ctx.setup();
const TO = pk().toBase58();
const counted = [];

/** Prepare through plum's own door, count the signers of what was built, then send it and count again. */
async function oneSigner(what, method, params, submit) {
  const prep = await ctx.ok(method, params);
  const built = readTx(ctx._test.prepared.get(prep.id).bytes);
  assert.equal(built.required, 1, `${what}: ${built.required} signers`);
  assert.equal(built.signatures.length, 1, what);
  assert.equal(built.keys[0], ME, `${what}: you sign it and pay for it`);
  assert.ok(!built.signatures.some(isSigned), `${what}: nothing signed before you`);
  const before = ctx.chain.sentTxs.length;
  await ctx.ok(submit, { id: prep.id });
  const sent = readTx(b64decode(ctx.chain.sentTxs[before]));
  assert.deepEqual(sent.message, built.message, `${what}: sent as reviewed`);
  assert.equal(sent.signatures.length, 1);
  assert.ok(ed25519.verify(sent.signatures[0], sent.message, base58Decode(ME)), `${what}: your signature`);
  counted.push([what, built.version]);
  return built;
}

/* ------------------------------------------------------------ staking */

const VOTE = pk().toBase58();
ctx.chain.accounts.set(VOTE, { lamports: 27_074_400, owner: VOTE_PROGRAM, data: [b64encode(new Uint8Array(3762)), 'base64'], executable: false });
const stakeBytes = ({ deact }) => {
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

test('staking: stake, unstake and withdraw each need one signature, yours', async () => {
  const built = await oneSigner('stake', 'stake.prepare', { action: 'stake', vote: VOTE, amount: '3' }, 'stake.submit');
  assert.ok(built.keys.includes(addressWithSeed(ME, stakeSeed(0), STAKE_PROGRAM)), 'the stake account is derived, not a key of its own');
  const active = pk().toBase58();
  ctx.chain.accounts.set(active, stakeBytes({ deact: (1n << 64n) - 1n }));
  await oneSigner('unstake', 'stake.prepare', { action: 'unstake', account: active }, 'stake.submit');
  const done = pk().toBase58();
  ctx.chain.accounts.set(done, stakeBytes({ deact: 5n }));
  await oneSigner('withdraw', 'stake.prepare', { action: 'withdraw', account: done }, 'stake.submit');
});

/* ------------------------------------------------------------ NFTs on Solana */

const held = new Map(); // mint -> token account
ctx.chain.handlers.getTokenAccountsByOwner = ([owner, filter]) => ({
  value: owner === ME && held.has(filter?.mint) ? [{ pubkey: held.get(filter.mint), account: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { mint: filter.mint, tokenAmount: { amount: '1', decimals: 0 } } } } } }] : [],
});
const assets = new Map();
const proofs = new Map();
ctx.chain.handlers.getAsset = ({ id }) => assets.get(id) ?? null;
ctx.chain.handlers.getAssetProof = ({ id }) => proofs.get(id) ?? null;
const mine = (a) => ({ ...structuredClone(a), ownership: { ...a.ownership, owner: ME, delegate: null, delegated: false, frozen: false } });

test('Metaplex NFTs, legacy and programmable: one signature each', async () => {
  const legacy = mine(FX.das.legacy);
  assets.set(legacy.id, legacy);
  held.set(legacy.id, pk().toBase58());
  await oneSigner('legacy NFT', 'nfts.prepare', { chain: 'sol', id: legacy.id, to: TO }, 'nfts.submit');
  const pnft = mine(FX.das.programmable);
  assets.set(pnft.id, pnft);
  held.set(pnft.id, pk().toBase58());
  ctx.chain.accounts.set(metadataAddress(pnft.id), FX.accounts.programmableMetadata);
  await oneSigner('programmable NFT', 'nfts.prepare', { chain: 'sol', id: pnft.id, to: TO }, 'nfts.submit');
});

test('a Core asset: one signature', async () => {
  const core = mine(FX.das.core);
  assets.set(core.id, core);
  // its account, owned by you
  const d = Buffer.from(FX.accounts.core.data[0], 'base64');
  Buffer.from(base58Decode(ME)).copy(d, 1);
  ctx.chain.accounts.set(core.id, { ...FX.accounts.core, data: [d.toString('base64'), 'base64'] });
  await oneSigner('Core asset', 'nfts.prepare', { chain: 'sol', id: core.id, to: TO }, 'nfts.submit');
});

/** A compressed NFT of yours in a tree of `depth` with no canopy, with a proof that adds up. */
function compressed(depth, version = 'spl') {
  const tree = pk().toBase58();
  const nonce = 7n;
  const id = compressedAssetId(tree, nonce);
  const dataHash = pk().toBase58(), creatorHash = pk().toBase58();
  const proof = Array.from({ length: depth }, () => pk().toBase58());
  const leaf = leafHash({ id, owner: ME, delegate: ME, nonce, dataHash, creatorHash, version: version === 'spl' ? 1 : 2, collectionHash: base58Encode(new Uint8Array(32)), assetDataHash: base58Encode(new Uint8Array(32)), flags: 0 });
  const root = base58Encode(rootOf(leaf, proof, 7));
  const header = new Uint8Array(56);
  header[0] = 1;
  header.set(u32le(64), 2);
  header.set(u32le(depth), 6);
  const body = 24 + 64 * (40 + 32 * depth) + 32 * depth + 40;
  const data = new Uint8Array(56 + body);
  data.set(header);
  ctx.chain.accounts.set(tree, { lamports: 1, owner: version === 'spl' ? 'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK' : 'mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW', data: [b64encode(data), 'base64'], executable: false });
  const asset = mine({ ...FX.das.compressed, id, compression: { ...FX.das.compressed.compression, tree, leaf_id: Number(nonce), data_hash: dataHash, creator_hash: creatorHash } });
  assets.set(id, asset);
  proofs.set(id, { root, proof, leaf: base58Encode(leaf), tree_id: tree, node_index: 2 ** depth + 7 });
  return id;
}

test('compressed NFTs: one signature, in a legacy transaction, or a v1 one when the proof is too long for legacy', async () => {
  const small = await oneSigner('compressed NFT (depth 14)', 'nfts.prepare', { chain: 'sol', id: compressed(14), to: TO }, 'nfts.submit');
  assert.equal(small.version, 'legacy');
  const deep = await oneSigner('compressed NFT (depth 30, no canopy)', 'nfts.prepare', { chain: 'sol', id: compressed(30), to: TO }, 'nfts.submit');
  assert.equal(deep.version, 1, 'too long for 1232 bytes: built as v1');
  assert.ok(deep.size > 1232 && deep.size <= 4096);
  const v2 = await oneSigner('compressed NFT (Bubblegum v2 tree)', 'nfts.prepare', { chain: 'sol', id: compressed(20, 'mpl'), to: TO }, 'nfts.submit');
  assert.ok(v2.required === 1);
});

/* ------------------------------------------------------------ NFTs on Ethereum */

test('ERC-721 and ERC-1155 sends: signed by your key alone, recovered from the signed transaction', async () => {
  net.eth.balances.set(ETH_ME.toLowerCase(), 10n ** 18n);
  net.eth.simulate = () => ({ status: '0x1', gasUsed: '0x20000', logs: [] });
  const NFT721 = '0x4444444444444444444444444444444444444444';
  const NFT1155 = '0x5555555555555555555555555555555555555555';
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  // the contracts say the NFTs are yours: ownerOf(1) is you, balanceOf(you, 2) is 3
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (body?.method === 'eth_call' && [NFT721, NFT1155].includes(body.params?.[0]?.to)) {
      const result = body.params[0].to === NFT721 ? `0x${word(BigInt(ETH_ME))}` : `0x${word(3)}`;
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
    }
    return orig(url, opts);
  };
  try {
    for (const [what, params] of [['ERC-721', { contract: NFT721, id: '1', standard: 'erc721' }], ['ERC-1155', { contract: NFT1155, id: '2', standard: 'erc1155', amount: '3' }]]) {
      const before = net.eth.sent.length;
      const prep = await ctx.ok('nfts.prepare', { chain: 'eth', to: '0x000000000000000000000000000000000000dEaD', ...params });
      await ctx.ok('nfts.submit', { id: prep.id });
      const raw = net.eth.sent[before];
      assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ETH_ME, `${what}: your key, and only yours`);
      assert.equal(parseTransaction(raw).to.toLowerCase(), params.contract.toLowerCase());
      counted.push([what, 'eip1559']);
    }
  } finally {
    globalThis.fetch = orig;
    net.eth.simulate = null;
  }
});

test('everything counted', () => {
  assert.deepEqual(counted.map(([w]) => w), [
    'stake', 'unstake', 'withdraw', 'legacy NFT', 'programmable NFT', 'Core asset',
    'compressed NFT (depth 14)', 'compressed NFT (depth 30, no canopy)', 'compressed NFT (Bubblegum v2 tree)', 'ERC-721', 'ERC-1155',
  ]);
});
