// Attacks around NFTs: names that carry hidden text or links, an indexer that lies about a compressed NFT, and sites'
// transactions that take your NFTs on each standard (Metaplex, Core, compressed, ERC-1155) or hand someone the right to
// take them later. Every NFT that leaves must be named in the approval window, and no picture or link may reach plum's
// pages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { TransactionInstruction } from '@solana/web3.js';
import { createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { base58Decode } from '../../src/shared/base58.js';
import { b64encode, concat, u32le, u64le, utf8 } from '../../src/shared/bytes.js';
import { BUBBLEGUM, CORE, SPL_COMPRESSION, TOKEN_METADATA, compressedAssetId, metadataAddress, nftIx } from '../../src/background/nfts.js';
import { fakeNet } from '../fake-net.mjs';
import { ME, PK, boot, legacyB64, pk } from './helpers.mjs';

const FX = JSON.parse(readFileSync(new URL('../fixtures/nfts-mainnet.json', import.meta.url), 'utf8'));
const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ctx = await boot({ balance: 5_000_000_000n });
const net = fakeNet();
globalThis.fetch = net.fetch;
await ctx.setup();
const page = await ctx.connectSite('https://nft-claim.example/');
const THIEF = pk().toBase58();

/** The approval window's preview of a site's Solana transaction (rejected afterwards). */
async function previewOf(ixs, signers = []) {
  const answer = page.request('signTransaction', { account: ME, transactions: [legacyB64(PK(ME), ixs, { signers })] });
  const view = await ctx.nextApproval();
  const [p] = await ctx.ok('approval.preview', { id: view.id });
  await ctx.rejectAll();
  await answer;
  return p;
}
const said = (p) => p.warnings.map((w) => `${w.level}: ${w.text}`).join('\n');
const str = (s) => concat(u32le(utf8(s).length), utf8(s));

/** Token Metadata's account for an NFT (MetadataV1), as the chain keeps it. */
function metadataAccount(mint, name) {
  const d = concat(Uint8Array.of(4), base58Decode(pk().toBase58()), base58Decode(mint), str(name), str('NFT'), str('https://evil.example/x.json'),
    Uint8Array.of(0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0));
  return { lamports: 5_616_720, owner: TOKEN_METADATA, data: [b64encode(d), 'base64'], executable: false };
}

/** A Core asset (AssetV1), with delegate plugins: [{ type, address }] (3 transfer, 2 burn, 1 freeze). */
function coreAsset(owner, name, delegates = []) {
  const base = concat(Uint8Array.of(1), base58Decode(owner), Uint8Array.of(0), str(name), str('https://evil.example/a.json'), Uint8Array.of(0));
  if (!delegates.length) return { lamports: 3_000_000, owner: CORE, data: [b64encode(base), 'base64'], executable: false };
  const registryAt = base.length + 9;
  const records = delegates.map((d) => concat(Uint8Array.of(d.type, 3), base58Decode(d.address), u64le(0n)));
  const d = concat(base, Uint8Array.of(3), u64le(BigInt(registryAt)), Uint8Array.of(4), u32le(records.length), ...records, u32le(0));
  return { lamports: 3_000_000, owner: CORE, data: [b64encode(d), 'base64'], executable: false };
}

test("the NFT list carries names and ids only: no picture, no link, no hidden text", async () => {
  const sneaky = structuredClone(FX.das.programmable);
  sneaky.ownership.owner = ME;
  sneaky.content.metadata.name = 'Mad Lads ‮9686# claim at evil.example‬';
  ctx.chain.handlers.getAssetsByOwner = () => ({ total: 2, items: [sneaky, { ...structuredClone(FX.das.core), ownership: { ...FX.das.core.ownership, owner: ME } }] });
  const r = await ctx.ok('nfts.list', { chain: 'sol' });
  assert.equal(r.via, 'das');
  assert.equal(r.items.length, 2);
  const all = JSON.stringify(r);
  assert.doesNotMatch(all, /https?:|ipfs:|arweave|\.png|\.json|data:image/i);
  assert.doesNotMatch(all, /[‪-‮⁦-⁩]/u, 'no bidirectional marks');
  assert.ok(r.items.some((n) => n.name === 'Mad Lads 9686# claim at evil.example'), 'shown as plain text, never a link');
  delete ctx.chain.handlers.getAssetsByOwner;
});

test('an Ethereum NFT list from Blockscout: no picture, no link, and Blockscout\'s scams left out', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (/\/addresses\/0x[0-9a-fA-F]{40}\/nft\?/.test(String(url))) {
      const items = [
        { id: '1', token_type: 'ERC-721', value: '1', image_url: 'https://tracker.example/p.png', metadata: { name: 'Gift', image: 'ipfs://x' }, token: { address_hash: '0x1111111111111111111111111111111111111111', name: 'Gifts', symbol: 'G', type: 'ERC-721', reputation: 'ok', icon_url: 'https://tracker.example/i.png' } },
        { id: '2', token_type: 'ERC-1155', value: '3', metadata: { name: 'Claim your airdrop' }, token: { address_hash: '0x2222222222222222222222222222222222222222', name: 'Airdrop', type: 'ERC-1155', reputation: 'scam' } },
      ];
      return { ok: true, status: 200, text: async () => JSON.stringify({ items, next_page_params: null }) };
    }
    return orig(url, opts);
  };
  try {
    const r = await ctx.ok('nfts.list', { chain: 'eth' });
    assert.deepEqual(r.items.map((n) => n.name), ['Gift']);
    assert.doesNotMatch(JSON.stringify(r), /https?:|ipfs:|\.png/i);
  } finally {
    globalThis.fetch = orig;
  }
});

test('a Metaplex NFT leaving in a site\'s transaction is named by its metadata', async () => {
  const mint = pk().toBase58();
  const src = pk();
  ctx.chain.accounts.set(metadataAddress(mint), metadataAccount(mint, 'Mad Lads #6867'));
  ctx.chain.simExtra = (v) => ({
    ...v,
    preTokenBalances: [{ accountIndex: 1, mint, owner: ME, uiTokenAmount: { amount: '1', decimals: 0 } }],
    postTokenBalances: [{ accountIndex: 1, mint, owner: ME, uiTokenAmount: { amount: '0', decimals: 0 } }, { accountIndex: 2, mint, owner: THIEF, uiTokenAmount: { amount: '1', decimals: 0 } }],
  });
  try {
    const p = await previewOf([createTransferCheckedInstruction(src, PK(mint), pk(), PK(ME), 1n, 0, [], TOKEN_PROGRAM_ID)]);
    assert.match(said(p), /warn: an NFT leaves your wallet: Mad Lads #6867/);
    const t = p.tokens.find((x) => x.mint === mint);
    assert.equal(t.delta, '-1');
    assert.equal(t.nft.name, 'Mad Lads #6867', 'the change is labelled with its name too');
  } finally {
    ctx.chain.simExtra = null;
  }
});

test("a Core asset taken by a site (even from inside another program) is named; a new delegate on it is a danger", async () => {
  const asset = pk().toBase58();
  ctx.chain.accounts.set(asset, coreAsset(ME, 'Lucky Emmy'));
  const touch = (program) => new TransactionInstruction({ programId: program, keys: [{ pubkey: PK(ME), isSigner: true, isWritable: true }, { pubkey: PK(asset), isSigner: false, isWritable: true }], data: Buffer.from([9]) });
  // moved to the thief by a "claim" program
  ctx.chain.afterSim.set(asset, coreAsset(THIEF, 'Lucky Emmy'));
  let p = await previewOf([touch(pk())]);
  assert.match(said(p), new RegExp(`warn: an NFT leaves your wallet: Lucky Emmy, to ${THIEF.slice(0, 4)}`));
  assert.doesNotMatch(said(p), /danger: it takes you off/, "named for what it is, not as an account you've been taken off");
  // still yours, but the thief may now transfer it
  ctx.chain.afterSim.set(asset, coreAsset(ME, 'Lucky Emmy', [{ type: 3, address: THIEF }]));
  p = await previewOf([touch(PK(CORE))]);
  assert.match(said(p), /danger: it lets .* transfer your NFT Lucky Emmy without asking you again/);
  // burnt
  ctx.chain.afterSim.set(asset, null);
  p = await previewOf([touch(PK(CORE))]);
  assert.match(said(p), /warn: it burns your NFT Lucky Emmy/);
  ctx.chain.afterSim.clear();
});

test('a compressed NFT moved, burned or delegated by a site is named from Bubblegum\'s instruction', async () => {
  const tree = pk().toBase58();
  const id = compressedAssetId(tree, 41n);
  ctx.chain.handlers.getAssetBatch = ({ ids }) => (ids.includes(id) ? [{ ...structuredClone(FX.das.compressed), id }] : []);
  const transfer = nftIx.compressedTransfer({ owner: ME, to: THIEF, delegate: ME, tree, root: pk().toBase58(), dataHash: pk().toBase58(), creatorHash: pk().toBase58(), nonce: 41n, index: 41, proof: [pk().toBase58()] });
  const asWeb3 = (i) => new TransactionInstruction({ programId: PK(i.programId), keys: i.keys.map((k) => ({ pubkey: PK(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(i.data) });
  let p = await previewOf([asWeb3(transfer)]);
  assert.match(said(p), new RegExp(`warn: an NFT leaves your wallet: Muffin Pass, to ${THIEF.slice(0, 4)}`));
  // with no DAS, by its id
  delete ctx.chain.handlers.getAssetBatch;
  p = await previewOf([asWeb3(transfer)]);
  assert.match(said(p), new RegExp(`an NFT leaves your wallet: ${id.slice(0, 4)}\\.\\.${id.slice(-4)} \\(compressed NFT\\)`));
  // delegate (v1): [config, owner, previous delegate, new delegate, tree, ...]
  const data = concat(Uint8Array.of(90, 147, 75, 178, 85, 88, 4, 137), new Uint8Array(96), u64le(41n), u32le(41));
  const delegate = { programId: BUBBLEGUM, keys: [pk().toBase58(), ME, ME, THIEF, tree].map((k, i) => ({ pubkey: k, isSigner: i === 1, isWritable: i === 4 })), data };
  p = await previewOf([asWeb3(delegate)]);
  assert.match(said(p), /danger: it lets .* move your NFT .* without asking you again/);
  // burn (v1): [config, owner, delegate, tree, ...]
  const burn = { programId: BUBBLEGUM, keys: [pk().toBase58(), ME, ME, tree].map((k, i) => ({ pubkey: k, isSigner: i === 1, isWritable: i === 3 })), data: concat(Uint8Array.of(116, 110, 29, 56, 107, 219, 42, 93), new Uint8Array(96), u64le(41n), u32le(41)) };
  p = await previewOf([asWeb3(burn)]);
  assert.match(said(p), /warn: it burns your NFT/);
});

test('a compressed-NFT tree changed from inside another program is a warning: which NFT moves can\'t be read', async () => {
  const tree = pk().toBase58();
  ctx.chain.accounts.set(tree, { lamports: 1, owner: SPL_COMPRESSION, data: [b64encode(new Uint8Array(64)), 'base64'], executable: false });
  const p = await previewOf([new TransactionInstruction({ programId: pk(), keys: [{ pubkey: PK(ME), isSigner: true, isWritable: true }, { pubkey: PK(tree), isSigner: false, isWritable: true }], data: Buffer.from([1]) })]);
  assert.match(said(p), /warn: it changes the compressed-NFT tree .* from inside another program/);
});

test("an indexer's lie about a compressed NFT is refused, and nothing is left to sign", async () => {
  const a = structuredClone(FX.das.compressed);
  a.ownership.owner = ME;
  a.ownership.delegate = null;
  ctx.chain.accounts.set(a.compression.tree, (() => { const d = Buffer.alloc(FX.tree.length); Buffer.from(FX.tree.header, 'hex').copy(d); return { lamports: 1, owner: FX.tree.owner, data: [d.toString('base64'), 'base64'], executable: false }; })());
  ctx.chain.handlers.getAsset = ({ id }) => (id === a.id ? a : null);
  // DAS's proof is for the real owner's leaf: with you as owner, it can't add up
  ctx.chain.handlers.getAssetProof = () => FX.proof;
  const before = ctx._test.prepared.size;
  assert.match(await ctx.err('nfts.prepare', { chain: 'sol', id: a.id, to: THIEF }), /doesn't add up/);
  assert.equal(ctx._test.prepared.size, before);
  delete ctx.chain.handlers.getAsset;
  delete ctx.chain.handlers.getAssetProof;
});

test('an ERC-1155 item leaving in a site\'s Ethereum transaction is named with its amount', async () => {
  net.eth.balances.set(ETH_ME.toLowerCase(), 10n ** 18n);
  const evm = (method, params) => page.request('evm', { method, params });
  const answer0 = evm('eth_requestAccounts');
  const v0 = await ctx.nextApproval();
  await ctx.ok('approval.resolve', { id: v0.id, approve: true });
  await answer0;
  const topic = (sig) => `0x${Buffer.from(keccak_256(utf8(sig))).toString('hex')}`;
  const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const ITEMS = '0x3333333333333333333333333333333333333333';
  const THIEF_ETH = '0x000000000000000000000000000000000000dEaD';
  net.eth.simulate = () => ({
    status: '0x1', gasUsed: '0x10000',
    logs: [
      { address: ITEMS, topics: [topic('TransferSingle(address,address,address,uint256,uint256)'), pad(THIEF_ETH), pad(ETH_ME), pad(THIEF_ETH)], data: `0x${word(7)}${word(25)}` },
      { address: ITEMS, topics: [topic('TransferBatch(address,address,address,uint256[],uint256[])'), pad(THIEF_ETH), pad(ETH_ME), pad(THIEF_ETH)], data: `0x${word(64)}${word(160)}${word(2)}${word(8)}${word(9)}${word(2)}${word(1)}${word(4)}` },
    ],
  });
  try {
    const answer = evm('eth_sendTransaction', [{ from: ETH_ME, to: ITEMS, data: '0xf242432a' }]);
    const view = await ctx.nextApproval(1000);
    const [p] = await ctx.ok('approval.preview', { id: view.id });
    await ctx.rejectAll();
    await answer;
    const text = said(p);
    assert.match(text, /warn: an NFT leaves your wallet: 25 of #7 of/);
    assert.match(text, /warn: an NFT leaves your wallet: #8 of/, 'a batch item of one');
    assert.match(text, /warn: an NFT leaves your wallet: 4 of #9 of/);
  } finally {
    net.eth.simulate = null;
  }
});

