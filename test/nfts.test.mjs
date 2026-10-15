// NFTs: real mainnet answers (DAS, metadata, a Core asset, a compressed NFT's proof and tree) read as plum reads them,
// the transfer each standard takes, built for your wallet alone and refused when the indexer's data doesn't add up,
// and Ethereum's ERC-721 / ERC-1155 transfers checked against viem.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { encodeFunctionData, parseAbi } from 'viem';
import { base58Encode } from '../src/shared/base58.js';
import { compileLegacy, readMessage } from '../src/shared/tx.js';
import {
  BUBBLEGUM, CORE, MPL_COMPRESSION, SPL_COMPRESSION, TOKEN_METADATA, compressedAssetId, editionAddress, erc1155TransferData, erc721TransferData, fromBlockscout,
  fromDas, leafHash, metadataAddress, nftIx, planSolSend, readBubblegum, readCoreAsset, readCoreCollection, readMetadata, readTree, rootOf, tokenRecordAddress,
  treeConfigAddress,
} from '../src/background/nfts.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/nfts-mainnet.json', import.meta.url), 'utf8'));
const key = () => Keypair.generate().publicKey.toBase58();
const treeAccount = (owner = FX.tree.owner, length = FX.tree.length, header = FX.tree.header) => {
  const d = Buffer.alloc(length);
  Buffer.from(header, 'hex').copy(d);
  return { lamports: 1, owner, data: [d.toString('base64'), 'base64'], executable: false };
};

test('DAS answers from mainnet, one of each kind, as plum keeps them: names and ids, never a picture or a link', () => {
  const kept = Object.fromEntries(Object.entries(FX.das).map(([k, a]) => [k, fromDas(a)]));
  assert.deepEqual(Object.values(kept).map((n) => n.standard), ['programmable', 'compressed', 'core', 'legacy']);
  assert.equal(kept.programmable.name, 'Mad Lads #6867');
  assert.deepEqual(kept.programmable.collection, { id: 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w', name: 'Mad Lads', verified: true });
  assert.equal(kept.core.name, FX.das.core.content.metadata.name);
  const all = JSON.stringify(kept);
  assert.doesNotMatch(all, /https?:|ipfs|arweave|\.png|\.json|data:/i, 'nothing that could load a picture');
  // fungibles, collections and burnt assets aren't NFTs you hold
  assert.equal(fromDas({ ...FX.das.legacy, burnt: true }), null);
  assert.equal(fromDas({ ...FX.das.legacy, interface: 'FungibleToken' }), null);
  assert.equal(fromDas({ ...FX.das.core, interface: 'MplCoreCollection' }), null);
  // a name drawn in plum's type: hidden characters and pictographs gone
  const odd = fromDas({ ...FX.das.legacy, content: { metadata: { name: 'Free ‮mint‬ 🎁 claim' } } });
  assert.equal(odd.name, 'Free mint claim');
});

test("Metaplex metadata from mainnet: a programmable NFT's standard, collection and rule set", () => {
  const m = readMetadata(FX.accounts.programmableMetadata);
  assert.equal(FX.accounts.programmableMetadata.address, metadataAddress(FX.das.programmable.id));
  assert.deepEqual([m.mint, m.name, m.symbol, m.tokenStandard], [FX.das.programmable.id, 'Mad Lads #6867', 'MAD', 4]);
  assert.deepEqual(m.collection, { verified: true, key: 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w' });
  assert.equal(m.ruleSet, 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9');
  const l = readMetadata(FX.accounts.legacyMetadata);
  assert.deepEqual([l.tokenStandard, l.ruleSet, l.collection], [0, null, null]);
  assert.equal(readMetadata({ ...FX.accounts.legacyMetadata, owner: key() }), null, "another program's account isn't metadata");
});

test('a Core asset from mainnet: its owner and name from the account itself, its collection', () => {
  const a = readCoreAsset(FX.accounts.core);
  assert.equal(a.owner, FX.das.core.ownership.owner);
  assert.equal(a.name, FX.das.core.content.metadata.name);
  assert.deepEqual(a.updateAuthority, { kind: 'collection', key: FX.accounts.coreCollection.address });
  assert.equal(readCoreCollection(FX.accounts.coreCollection).name, 'Lucky Emmy');
  assert.equal(readCoreAsset({ ...FX.accounts.core, owner: key() }), null);
});

test("a compressed NFT from mainnet: its id is its tree and leaf, its leaf and proof add up to DAS's root", () => {
  const a = FX.das.compressed;
  const c = a.compression;
  assert.equal(compressedAssetId(c.tree, BigInt(c.leaf_id)), a.id);
  const leaf = leafHash({ id: a.id, owner: a.ownership.owner, delegate: a.ownership.delegate ?? a.ownership.owner, nonce: BigInt(c.leaf_id), dataHash: c.data_hash, creatorHash: c.creator_hash });
  assert.equal(base58Encode(leaf), FX.proof.leaf);
  assert.equal(base58Encode(rootOf(leaf, FX.proof.proof, c.leaf_id)), FX.proof.root);
  assert.deepEqual(readTree(treeAccount()), { program: SPL_COMPRESSION, depth: 14, canopy: 0 });
  // a canopy of depth 3 keeps 14 nodes (2 + 4 + 8) on chain
  assert.deepEqual(readTree(treeAccount(MPL_COMPRESSION, FX.tree.length + 14 * 32)), { program: MPL_COMPRESSION, depth: 14, canopy: 3 });
  assert.equal(readTree(treeAccount(key())), null);
});

/* ------------------------------------------------------------ transfers */

const OWNER = FX.das.compressed.ownership.owner;
const TO = key();

/** A stand-in RPC: accounts by address, DAS answers by id, token accounts by mint. */
function nftRpc({ accounts = {}, assets = {}, proofs = {}, held = {} } = {}) {
  return {
    async accounts(addrs) { return addrs.map((a) => accounts[a] ?? null); },
    async call(method, params) {
      if (method === 'getAsset') { if (!assets[params.id]) throw new Error('Asset not found'); return structuredClone(assets[params.id]); }
      if (method === 'getAssetProof') return structuredClone(proofs[params.id]);
      if (method === 'getTokenAccountsByOwner') return { value: held[params[1].mint] ?? [] };
      throw new Error(`no ${method}`);
    },
  };
}
const withOwner = (a, owner) => ({ ...a, ownership: { ...a.ownership, owner, delegate: null, delegated: false, frozen: false } });

test('a compressed NFT is sent with Bubblegum transfer, its proof cut by the canopy, signed by you alone', async () => {
  const a = FX.das.compressed;
  const rpc = nftRpc({ accounts: { [a.compression.tree]: treeAccount() }, assets: { [a.id]: a }, proofs: { [a.id]: FX.proof } });
  const p = await planSolSend(rpc, OWNER, { id: a.id, to: TO });
  const [ixn] = p.instructions;
  assert.equal(ixn.programId, BUBBLEGUM);
  assert.deepEqual([...ixn.data.subarray(0, 8)], [163, 52, 200, 231, 140, 3, 69, 186]);
  assert.deepEqual(ixn.keys.slice(0, 8).map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
    [treeConfigAddress(a.compression.tree), false, false], [OWNER, true, false], [OWNER, false, false], [TO, false, false],
    [a.compression.tree, false, true], ['noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', false, false], [SPL_COMPRESSION, false, false], ['11111111111111111111111111111111', false, false],
  ]);
  assert.deepEqual(ixn.keys.slice(8).map((k) => k.pubkey), FX.proof.proof, 'all 14 proof nodes: this tree keeps no canopy');
  assert.equal(base58Encode(ixn.data.subarray(8, 40)), FX.proof.root);
  assert.equal(readBubblegum(ixn.data, (k) => ixn.keys[k].pubkey).id, a.id, 'plum reads back the same NFT');
  const m = readMessage(compileLegacy({ payer: OWNER, blockhash: OWNER, instructions: p.instructions }));
  assert.equal(m.required, 1);
  assert.equal(p.summary.name, 'Muffin Pass');
  // a tree with a canopy needs fewer proof nodes
  const canopied = nftRpc({ accounts: { [a.compression.tree]: treeAccount(SPL_COMPRESSION, FX.tree.length + 14 * 32) }, assets: { [a.id]: a }, proofs: { [a.id]: FX.proof } });
  assert.equal((await planSolSend(canopied, OWNER, { id: a.id, to: TO })).instructions[0].keys.length, 8 + 11);
});

test("an indexer's compressed-NFT data that doesn't add up is refused before anything is built", async () => {
  const a = FX.das.compressed;
  const at = (asset, proof = FX.proof) => planSolSend(nftRpc({ accounts: { [a.compression.tree]: treeAccount() }, assets: { [a.id]: asset }, proofs: { [a.id]: proof } }), OWNER, { id: a.id, to: TO });
  await assert.rejects(at(a, { ...FX.proof, root: key() }), /doesn't add up/);
  await assert.rejects(at(a, { ...FX.proof, proof: [...FX.proof.proof.slice(0, 13), key()] }), /doesn't add up/);
  await assert.rejects(at(a, { ...FX.proof, proof: FX.proof.proof.slice(1) }), /doesn't fit/);
  await assert.rejects(at({ ...a, compression: { ...a.compression, leaf_id: a.compression.leaf_id + 1 } }), /isn't its tree and leaf/);
  await assert.rejects(at({ ...a, compression: { ...a.compression, data_hash: key() } }), /doesn't add up/);
  // not yours, or nowhere to send it
  await assert.rejects(at(withOwner(a, key())), /isn't in this wallet/);
  await assert.rejects(planSolSend(nftRpc({ accounts: { [TO]: { lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: ['', 'base64'], executable: true } }, assets: { [a.id]: a } }), OWNER, { id: a.id, to: TO }), /is a program/);
  await assert.rejects(planSolSend(nftRpc(), OWNER, { id: a.id, to: OWNER }), /already/);
  await assert.rejects(planSolSend(nftRpc(), OWNER, { id: a.id, to: 'nope' }), /isn't a Solana address/);
});

test('a Core asset is sent with Core TransferV1, naming its collection; one that is not yours on chain is refused', async () => {
  const a = withOwner(FX.das.core, readCoreAsset(FX.accounts.core).owner);
  const me = a.ownership.owner;
  const rpc = nftRpc({ accounts: { [a.id]: FX.accounts.core }, assets: { [a.id]: a } });
  const p = await planSolSend(rpc, me, { id: a.id, to: TO });
  const [ixn] = p.instructions;
  assert.equal(ixn.programId, CORE);
  assert.deepEqual([...ixn.data], [14, 0]);
  assert.deepEqual(ixn.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
    [a.id, false, true], [FX.accounts.coreCollection.address, false, false], [me, true, true], [me, true, false], [TO, false, false], [CORE, false, false], [CORE, false, false],
  ]);
  // DAS says it's yours, the chain says it isn't: refused
  await assert.rejects(planSolSend(rpc, key(), { id: a.id, to: TO }), /isn't in this wallet/);
  const lying = nftRpc({ accounts: { [a.id]: FX.accounts.core }, assets: { [a.id]: withOwner(a, OWNER) } });
  await assert.rejects(planSolSend(lying, OWNER, { id: a.id, to: TO }), /isn't owned by this wallet on chain/);
});

test('a programmable NFT is sent with Token Metadata TransferV1: token records, edition and its rule set', async () => {
  const a = withOwner(FX.das.programmable, OWNER);
  const mint = a.id;
  const source = key();
  const rpc = nftRpc({
    accounts: { [metadataAddress(mint)]: FX.accounts.programmableMetadata },
    assets: { [mint]: a },
    held: { [mint]: [{ pubkey: source, account: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { tokenAmount: { amount: '1', decimals: 0 } } } } } }] },
  });
  const p = await planSolSend(rpc, OWNER, { id: mint, to: TO });
  const [ixn] = p.instructions;
  const dest = getAssociatedTokenAddressSync(new (await import('@solana/web3.js')).PublicKey(mint), new (await import('@solana/web3.js')).PublicKey(TO), false, TOKEN_PROGRAM_ID).toBase58();
  assert.equal(ixn.programId, TOKEN_METADATA);
  assert.deepEqual([...ixn.data], [49, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ixn.keys.map((k) => k.pubkey), [
    source, OWNER, dest, TO, mint, metadataAddress(mint), editionAddress(mint), tokenRecordAddress(mint, source), tokenRecordAddress(mint, dest), OWNER, OWNER,
    '11111111111111111111111111111111', 'Sysvar1nstructions1111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg', 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9',
  ]);
  assert.deepEqual(ixn.keys.filter((k) => k.isSigner).map((k) => k.pubkey), [OWNER, OWNER]);
  assert.deepEqual(p.warnings, [], 'not frozen any more');
  // without a rule set, the two optional accounts are the program itself
  const free = nftIx.programmableTransfer({ owner: OWNER, to: TO, mint, source });
  assert.deepEqual(free.keys.slice(15).map((k) => k.pubkey), [TOKEN_METADATA, TOKEN_METADATA]);
});

test("a Metaplex NFT is sent with the token program's own transfer, exactly as spl-token builds it", async () => {
  const a = withOwner(FX.das.legacy, OWNER);
  const mint = a.id;
  const source = key();
  const rpc = nftRpc({ assets: { [mint]: a }, held: { [mint]: [{ pubkey: source, account: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { tokenAmount: { amount: '1', decimals: 0 } } } } } }] } });
  const p = await planSolSend(rpc, OWNER, { id: mint, to: TO });
  const { PublicKey } = await import('@solana/web3.js');
  const dest = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(TO), false, TOKEN_PROGRAM_ID);
  const theirs = [
    createAssociatedTokenAccountIdempotentInstruction(new PublicKey(OWNER), dest, new PublicKey(TO), new PublicKey(mint), TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(new PublicKey(source), new PublicKey(mint), dest, new PublicKey(OWNER), 1n, 0, [], TOKEN_PROGRAM_ID),
  ];
  p.instructions.forEach((ours, i) => {
    assert.equal(ours.programId, theirs[i].programId.toBase58());
    assert.deepEqual(Buffer.from(ours.data), theirs[i].data);
    assert.deepEqual(ours.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), theirs[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  });
  await assert.rejects(planSolSend(nftRpc({ assets: { [mint]: a } }), OWNER, { id: mint, to: TO }), /isn't in this wallet's token accounts/);
});

test("a Bubblegum v2 tree: the leaf hashes Bubblegum's default collection and asset data, and the send is transferV2", async () => {
  // Bubblegum's DEFAULT_COLLECTION_HASH (keccak of 32 zero bytes) and DEFAULT_ASSET_DATA_HASH (keccak of nothing)
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  assert.deepEqual([...keccak_256(new Uint8Array(32))], [41, 13, 236, 217, 84, 139, 98, 168, 214, 3, 69, 169, 136, 56, 111, 200, 75, 166, 188, 149, 72, 64, 8, 246, 54, 47, 147, 22, 14, 243, 229, 99]);
  assert.deepEqual([...keccak_256(new Uint8Array(0))], [197, 210, 70, 1, 134, 247, 35, 60, 146, 126, 125, 178, 220, 199, 3, 192, 229, 0, 182, 83, 202, 130, 39, 59, 123, 250, 216, 4, 93, 133, 164, 112]);
  const tree = key(), owner = key(), nonce = 3n;
  const id = compressedAssetId(tree, nonce);
  const dataHash = key(), creatorHash = key();
  const proof = Array.from({ length: 14 }, key);
  const asset = { ...structuredClone(FX.das.compressed), id, grouping: [], compression: { compressed: true, tree, leaf_id: 3, data_hash: dataHash, creator_hash: creatorHash }, ownership: { owner, delegate: null } };
  const answer = (leaf) => ({ root: base58Encode(rootOf(leaf, proof, 3)), proof, leaf: base58Encode(leaf), tree_id: tree });
  const rpcWith = (leaf) => nftRpc({ accounts: { [tree]: treeAccount(MPL_COMPRESSION) }, assets: { [id]: asset }, proofs: { [id]: answer(leaf) } });
  const good = leafHash({ version: 2, id, owner, delegate: owner, nonce, dataHash, creatorHash, collectionHash: base58Encode(keccak_256(new Uint8Array(32))), assetDataHash: base58Encode(keccak_256(new Uint8Array(0))), flags: 0 });
  const p = await planSolSend(rpcWith(good), owner, { id, to: TO });
  assert.deepEqual([...p.instructions[0].data.subarray(0, 8)], [119, 40, 6, 235, 234, 221, 248, 49]);
  assert.equal(p.instructions[0].keys[9].pubkey, MPL_COMPRESSION);
  // a leaf made with zeros where Bubblegum hashes its defaults doesn't add up
  const zeros = leafHash({ version: 2, id, owner, delegate: owner, nonce, dataHash, creatorHash, collectionHash: base58Encode(new Uint8Array(32)), assetDataHash: base58Encode(new Uint8Array(32)), flags: 0 });
  await assert.rejects(planSolSend(rpcWith(zeros), owner, { id, to: TO }), /doesn't add up/);
});

test("Bubblegum's instructions are read back for previews: v1 and v2 transfers, burns and delegates", () => {
  const tree = key(), owner = key(), to = key();
  const v1 = nftIx.compressedTransfer({ owner, to, delegate: owner, tree, root: key(), dataHash: key(), creatorHash: key(), nonce: 77n, index: 77, proof: [key()] });
  assert.deepEqual(readBubblegum(v1.data, (k) => v1.keys[k].pubkey), { act: 'transfer', owner, to, tree, nonce: 77n, id: compressedAssetId(tree, 77n) });
  for (const opts of [{ assetDataHash: null, flags: null }, { assetDataHash: key(), flags: 3 }, { assetDataHash: key(), flags: null }]) {
    const v2 = nftIx.compressedTransfer({ owner, to, delegate: owner, tree, root: key(), dataHash: key(), creatorHash: key(), nonce: 5n, index: 5, proof: [], v2: { collection: null, ...opts } });
    assert.deepEqual(readBubblegum(v2.data, (k) => v2.keys[k].pubkey), { act: 'transfer', owner, to, tree, nonce: 5n, id: compressedAssetId(tree, 5n) });
    assert.equal(v2.keys[7].pubkey, BUBBLEGUM, 'no collection: the program stands in');
  }
  // burn (v1): [config, owner, delegate, tree, ...]; delegate (v1): [config, owner, previous, new, tree, ...]
  const body = (disc, nonce) => Uint8Array.from([...disc, ...new Uint8Array(96), ...new Uint8Array(new BigUint64Array([nonce]).buffer), 0, 0, 0, 0]);
  const accts = [key(), owner, owner, tree, key()];
  assert.deepEqual(readBubblegum(body([116, 110, 29, 56, 107, 219, 42, 93], 9n), (k) => accts[k]), { act: 'burn', owner, to: null, tree, nonce: 9n, id: compressedAssetId(tree, 9n) });
  const thief = key();
  const del = [key(), owner, owner, thief, tree];
  assert.equal(readBubblegum(body([90, 147, 75, 178, 85, 88, 4, 137], 9n), (k) => del[k]).to, thief);
  assert.equal(readBubblegum(Uint8Array.of(1, 2, 3), () => null), null);
  assert.equal(readBubblegum(body([116, 110, 29, 56, 107, 219, 42, 93], 9n).subarray(0, 100), (k) => accts[k]), null, 'cut short');
});

/* ------------------------------------------------------------ Ethereum */

test("Ethereum NFTs from Blockscout: names and ids, Blockscout's scams left out; safeTransferFrom as viem encodes it", () => {
  const item = {
    id: '6867', token_type: 'ERC-721', value: '1', image_url: 'https://evil.example/pixel.png', animation_url: null,
    metadata: { name: 'Mad Lad ⁦six⁩', image: 'ipfs://x' },
    token: { address_hash: '0x0000000000696760E15f265e828DB644A0c242EB', name: 'Wei Name Service', symbol: 'WEI', type: 'ERC-721', reputation: 'ok', icon_url: 'https://x/y.png' },
  };
  const kept = fromBlockscout(item);
  assert.deepEqual(kept, { chain: 'eth', network: 'eth', id: '6867', contract: '0x0000000000696760E15f265e828DB644A0c242EB', standard: 'erc721', name: 'Mad Lad six', symbol: 'WEI', collection: { id: '0x0000000000696760E15f265e828DB644A0c242EB', name: 'Wei Name Service', verified: true }, amount: '1' });
  assert.doesNotMatch(JSON.stringify(kept), /https?:|ipfs|png/);
  assert.equal(fromBlockscout({ ...item, token: { ...item.token, reputation: 'scam' } }), null);
  assert.equal(fromBlockscout({ ...item, token_type: 'ERC-20', token: { ...item.token, type: 'ERC-20' } }), null);
  assert.equal(fromBlockscout({ ...item, token_type: 'ERC-1155', value: '12', token: { ...item.token, type: 'ERC-1155' } }).amount, '12');
  const from = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', to = '0x0000000000696760E15f265e828DB644A0c242EB';
  const abi = parseAbi(['function safeTransferFrom(address from, address to, uint256 id)', 'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)']);
  assert.equal(erc721TransferData(from, to, 6867n), encodeFunctionData({ abi: [abi[0]], functionName: 'safeTransferFrom', args: [from, to, 6867n] }));
  assert.equal(erc1155TransferData(from, to, 5n, 3n), encodeFunctionData({ abi: [abi[1]], functionName: 'safeTransferFrom', args: [from, to, 5n, 3n, '0x'] }));
});
