// NFTs. On Solana: Metaplex NFTs (legacy and programmable), Core assets and compressed NFTs, listed through the RPC's
// DAS methods (or, on an RPC without them, from your token accounts and their Metaplex metadata), and the transfer each
// standard takes, built here for your wallet alone to sign. On Ethereum: ERC-721 and ERC-1155 tokens from Blockscout,
// sent with safeTransferFrom. Only names and ids are ever read out of them: no picture and no link reaches plum's
// pages (a picture would tell its host your IP), and every name is cleaned before it's shown.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58Encode, isAddress } from '../shared/base58.js';
import { b64decode, concat, readU32, readU64, u64le, utf8 } from '../shared/bytes.js';
import { short } from '../shared/format.js';
import { associatedTokenAddress, findProgramAddress } from '../shared/pda.js';
import { plainName } from '../shared/text.js';
import { ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, base58Decode32, ix } from '../shared/tx.js';
import { ethRpc, sameAddress } from './eth.js';
import { getJson } from './net.js';

export const TOKEN_METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const BUBBLEGUM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
export const SPL_COMPRESSION = 'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK';
export const SPL_NOOP = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';
export const MPL_COMPRESSION = 'mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW';
export const MPL_NOOP = 'mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3';
export const AUTH_RULES = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
/** The standards, as plum names them. */
export const STANDARDS = { legacy: 'Metaplex NFT', programmable: 'programmable NFT', core: 'Core asset', compressed: 'compressed NFT', erc721: 'ERC-721', erc1155: 'ERC-1155' };

const fail = (message) => new Error(message);
const dataOf = (acc) => (typeof acc?.data?.[0] === 'string' ? b64decode(acc.data[0]) : acc?.data instanceof Uint8Array ? acc.data : new Uint8Array(0));
const b58 = (bytes) => base58Encode(bytes);
const text = new TextDecoder('utf-8', { fatal: false });

/* ------------------------------------------------------------ addresses */

export const metadataAddress = (mint) => findProgramAddress([utf8('metadata'), base58Decode32(TOKEN_METADATA), base58Decode32(mint)], TOKEN_METADATA)[0];
export const editionAddress = (mint) => findProgramAddress([utf8('metadata'), base58Decode32(TOKEN_METADATA), base58Decode32(mint), utf8('edition')], TOKEN_METADATA)[0];
export const tokenRecordAddress = (mint, token) => findProgramAddress([utf8('metadata'), base58Decode32(TOKEN_METADATA), base58Decode32(mint), utf8('token_record'), base58Decode32(token)], TOKEN_METADATA)[0];
export const treeConfigAddress = (tree) => findProgramAddress([base58Decode32(tree)], BUBBLEGUM)[0];
/** A compressed NFT's id: from its tree and its leaf's nonce. */
export const compressedAssetId = (tree, nonce) => findProgramAddress([utf8('asset'), base58Decode32(tree), u64le(nonce)], BUBBLEGUM)[0];

/* ------------------------------------------------------------ reading accounts */

/** A cursor over account bytes that refuses to read past the end. */
function cursor(d, at = 0) {
  const take = (n) => {
    if (n < 0 || at + n > d.length) throw fail('it ends too early');
    const out = d.subarray(at, at + n);
    at += n;
    return out;
  };
  const str = () => {
    const n = readU32(take(4), 0);
    if (n > 4096) throw fail('a string is too long');
    return text.decode(take(n)).replace(/\0+$/, '');
  };
  return { take, str, u8: () => take(1)[0], key: () => b58(take(32)), get at() { return at; }, get left() { return d.length - at; } };
}

/**
 * Metaplex metadata (Token Metadata's MetadataV1), the fields plum uses: { mint, name, symbol, tokenStandard,
 * collection: { key, verified } | null, ruleSet }. Older accounts end early: what isn't there counts as none.
 */
export function readMetadata(acc) {
  if (!acc || acc.owner !== TOKEN_METADATA) return null;
  const d = dataOf(acc);
  if (d[0] !== 4) return null;
  try {
    const c = cursor(d, 1);
    const updateAuthority = c.key();
    const mint = c.key();
    const name = c.str(), symbol = c.str();
    c.str(); // uri: never used
    c.take(2); // seller fee basis points
    if (c.u8()) c.take(34 * readU32(c.take(4), 0)); // creators: address, verified, share
    c.take(2); // primary sale happened, is mutable
    const some = () => c.left > 0 && c.u8() !== 0;
    if (some()) c.take(1); // edition nonce
    const tokenStandard = some() ? c.u8() : null;
    const collection = some() ? { verified: c.u8() !== 0, key: c.key() } : null;
    if (some()) c.take(17); // uses
    if (some()) c.take(9); // collection details
    let ruleSet = null;
    if (some()) { c.take(1); if (c.left > 0 && c.u8()) ruleSet = c.key(); }
    return { updateAuthority, mint, name, symbol, tokenStandard, collection, ruleSet };
  } catch {
    return null;
  }
}

/** A Core asset (AssetV1): { owner, updateAuthority: { kind, key }, name, delegates }, or null. `delegates` are the
 * plugins that let another address transfer, burn or freeze it: [{ type, address }]. */
export function readCoreAsset(acc) {
  if (!acc || acc.owner !== CORE) return null;
  const d = dataOf(acc);
  if (d[0] !== 1) return null;
  try {
    const c = cursor(d, 1);
    const owner = c.key();
    const kind = c.u8();
    const updateAuthority = { kind: ['none', 'address', 'collection'][kind] ?? 'unknown', key: kind === 1 || kind === 2 ? c.key() : null };
    const name = c.str();
    c.str(); // uri
    if (c.u8()) c.take(8); // seq
    return { owner, updateAuthority, name, delegates: c.left > 0 ? corePluginDelegates(d, c.at) : [] };
  } catch {
    return null;
  }
}

/** A Core collection (CollectionV1): { name }, or null. */
export function readCoreCollection(acc) {
  if (!acc || acc.owner !== CORE) return null;
  const d = dataOf(acc);
  if (d[0] !== 5) return null;
  try {
    const c = cursor(d, 33);
    return { name: c.str() };
  } catch {
    return null;
  }
}

// Core's plugins that hand another address power over an asset: FreezeDelegate (1), BurnDelegate (2), TransferDelegate
// (3) and their permanent kinds (5, 8, 7)
const CORE_DELEGATES = { 1: 'freeze', 2: 'burn', 3: 'transfer', 5: 'freeze', 7: 'transfer', 8: 'burn' };

/** The delegate plugins in a Core asset's plugin registry: [{ type, address }] for those an address holds. */
function corePluginDelegates(d, at) {
  const out = [];
  try {
    const c = cursor(d, at);
    if (c.u8() !== 3) return out; // PluginHeaderV1
    const registry = Number(readU64(c.take(8), 0));
    const r = cursor(d, registry);
    if (r.u8() !== 4) return out; // PluginRegistryV1
    for (let n = readU32(r.take(4), 0); n > 0; n--) {
      const type = r.u8();
      const auth = r.u8();
      const address = auth === 3 ? r.key() : null;
      r.take(8); // offset
      if (CORE_DELEGATES[type] && address) out.push({ type: CORE_DELEGATES[type], address });
    }
  } catch { /* a registry plum can't read: none named */ }
  return out;
}

/* ------------------------------------------------------------ compressed NFTs: trees, leaves and proofs */

/** A concurrent Merkle tree's header and canopy: { program, depth, canopy } (canopy: how many proof levels the tree
 * keeps on chain itself, so a transfer passes only the rest). */
export function readTree(acc) {
  if (!acc || (acc.owner !== SPL_COMPRESSION && acc.owner !== MPL_COMPRESSION)) return null;
  const d = dataOf(acc);
  if (d.length < 56 || d[0] !== 1) return null;
  const buffer = readU32(d, 2);
  const depth = readU32(d, 6);
  if (!depth || depth > 30 || !buffer || buffer > 2048) return null;
  // header (56), then sequence, active index, buffer size (24), the change logs, the rightmost proof; the canopy is what's left
  const body = 24 + buffer * (40 + 32 * depth) + 32 * depth + 40;
  const canopyBytes = d.length - 56 - body;
  if (canopyBytes < 0) return null;
  const canopy = Math.max(0, Math.floor(Math.log2(canopyBytes / 32 + 2)) - 1);
  return { program: acc.owner, depth, canopy: Math.min(canopy, depth) };
}

/** keccak of a compressed NFT's leaf, as Bubblegum hashes it (version 1, or 2 with its extra fields). */
export function leafHash({ version = 1, id, owner, delegate, nonce, dataHash, creatorHash, collectionHash = null, assetDataHash = null, flags = 0 }) {
  const parts = [Uint8Array.of(version), base58Decode32(id), base58Decode32(owner), base58Decode32(delegate), u64le(nonce), base58Decode32(dataHash), base58Decode32(creatorHash)];
  if (version === 2) parts.push(base58Decode32(collectionHash), base58Decode32(assetDataHash), Uint8Array.of(flags));
  return keccak_256(concat(...parts));
}

/** The root a leaf and its proof (leaf to root) add up to, at leaf `index`. */
export function rootOf(leaf, proof, index) {
  let node = leaf;
  proof.forEach((p, level) => {
    const sibling = base58Decode32(p);
    node = (index >> level) & 1 ? keccak_256(concat(sibling, node)) : keccak_256(concat(node, sibling));
  });
  return node;
}

/* ------------------------------------------------------------ listing */

const SOL_INTERFACES = { V1_NFT: 'legacy', LEGACY_NFT: 'legacy', V1_PRINT: 'legacy', V2_NFT: 'legacy', ProgrammableNFT: 'programmable', MplCoreAsset: 'core' };

/** One DAS asset as plum keeps it, or null when it isn't an NFT you can hold (a fungible, a collection, burnt). */
export function fromDas(a) {
  if (!a || typeof a.id !== 'string' || !isAddress(a.id) || a.burnt) return null;
  const compressed = !!a.compression?.compressed;
  let standard = compressed ? 'compressed' : SOL_INTERFACES[a.interface] ?? null;
  if (!standard) return null;
  if (standard === 'legacy' && /^Programmable/.test(a.content?.metadata?.token_standard ?? '')) standard = 'programmable';
  const md = a.content?.metadata ?? {};
  const group = (a.grouping ?? []).find((g) => g?.group_key === 'collection' && isAddress(g.group_value));
  return {
    chain: 'sol',
    id: a.id,
    standard,
    name: plainName(md.name ?? '', 48) || null,
    symbol: plainName(md.symbol ?? '', 12) || null,
    collection: group ? { id: group.group_value, name: plainName(group.collection_metadata?.name ?? '', 40) || null, verified: group.verified !== false } : null,
    frozen: !!a.ownership?.frozen,
    owner: a.ownership?.owner ?? null,
  };
}

/** Group label and order: by collection, then by name. */
const byCollection = (a, b) => (a.collection?.name ?? a.collection?.id ?? '~').localeCompare(b.collection?.name ?? b.collection?.id ?? '~') || (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true });

/** What `owner` holds on Solana: { items, via: 'das' | 'accounts' }. */
export async function listSol(rpc, owner) {
  let items = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await rpc.call('getAssetsByOwner', { ownerAddress: owner, page, limit: 1000, displayOptions: { showCollectionMetadata: true } }, { timeout: 30_000, retries: 1 });
      const got = Array.isArray(r?.items) ? r.items : [];
      items.push(...got);
      if (got.length < 1000) break;
    }
  } catch (e) {
    // an RPC without DAS (method not found): your Metaplex NFTs from your token accounts instead
    if (/not found|not supported|unknown method|doesn't answer|-32601/i.test(`${e.message} ${e.code ?? ''}`)) return { items: await listFromAccounts(rpc, owner), via: 'accounts' };
    throw e;
  }
  items = items.map(fromDas).filter((x) => x && (!x.owner || x.owner === owner));
  // Core collections DAS leaves unnamed: their names from their own accounts
  const unnamed = [...new Set(items.filter((x) => x.standard === 'core' && x.collection && !x.collection.name).map((x) => x.collection.id))].slice(0, 100);
  if (unnamed.length) {
    const found = new Map((await rpc.accounts(unnamed).catch(() => [])).map((acc, i) => [unnamed[i], plainName(readCoreCollection(acc)?.name ?? '', 40) || null]));
    for (const x of items) if (x.collection && !x.collection.name && found.get(x.collection.id)) x.collection = { ...x.collection, name: found.get(x.collection.id) };
  }
  return { items: items.map(({ owner: _, ...x }) => x).sort(byCollection), via: 'das' };
}

/** Your Metaplex NFTs from your token accounts (a single token, no decimals) and their metadata. */
async function listFromAccounts(rpc, owner) {
  const [legacy, t22] = await Promise.all([rpc.tokenAccounts(owner, TOKEN_PROGRAM), rpc.tokenAccounts(owner, TOKEN_2022_PROGRAM).catch(() => [])]);
  const held = [...legacy, ...t22].map((v) => v.account?.data?.parsed?.info).filter((i) => i && i.tokenAmount?.decimals === 0 && i.tokenAmount?.amount === '1' && isAddress(i.mint));
  const mints = [...new Set(held.map((i) => i.mint))];
  if (!mints.length) return [];
  const metas = (await rpc.accounts(mints.map(metadataAddress))).map(readMetadata);
  const collections = [...new Set(metas.map((m) => m?.collection?.key).filter(Boolean))];
  const named = new Map(collections.length ? (await rpc.accounts(collections.map(metadataAddress))).map((m, i) => [collections[i], readMetadata(m)?.name ?? null]) : []);
  const frozen = new Set(held.filter((i) => i.state === 'frozen').map((i) => i.mint));
  return mints.map((mint, i) => {
    const m = metas[i];
    return {
      chain: 'sol', id: mint, standard: m?.tokenStandard === 4 || m?.tokenStandard === 5 ? 'programmable' : 'legacy',
      name: plainName(m?.name ?? '', 48) || null, symbol: plainName(m?.symbol ?? '', 12) || null,
      collection: m?.collection ? { id: m.collection.key, name: plainName(named.get(m.collection.key) ?? '', 40) || null, verified: m.collection.verified } : null,
      frozen: frozen.has(mint),
    };
  }).sort(byCollection);
}

/* ------------------------------------------------------------ sending, one standard at a time */

const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey, writable = false) => ({ pubkey, isSigner: true, isWritable: writable });

export const nftIx = {
  /** Token Metadata TransferV1 (49, 0): a programmable NFT, with its token records and any rule set. */
  programmableTransfer: ({ owner, to, mint, source, ruleSet = null }) => {
    const dest = associatedTokenAddress(to, mint, TOKEN_PROGRAM);
    return {
      programId: TOKEN_METADATA,
      keys: [
        w(source), r(owner), w(dest), r(to), r(mint), w(metadataAddress(mint)), r(editionAddress(mint)),
        w(tokenRecordAddress(mint, source)), w(tokenRecordAddress(mint, dest)), s(owner), s(owner, true),
        r(SYSTEM_PROGRAM), r(SYSVAR_INSTRUCTIONS), r(TOKEN_PROGRAM), r(ATA_PROGRAM),
        // optional accounts left out are the program itself
        r(ruleSet ? AUTH_RULES : TOKEN_METADATA), r(ruleSet ?? TOKEN_METADATA),
      ],
      data: concat(Uint8Array.of(49, 0), u64le(1n), Uint8Array.of(0)),
    };
  },
  /** Core TransferV1 (14): no compression proof. */
  coreTransfer: ({ owner, to, asset, collection = null }) => ({
    programId: CORE,
    keys: [w(asset), r(collection ?? CORE), s(owner, true), s(owner), r(to), r(CORE), r(CORE)],
    data: Uint8Array.of(14, 0),
  }),
  /** Bubblegum transfer (v1 trees) or transferV2 (v2 trees), with the proof levels the tree's canopy doesn't keep. */
  compressedTransfer: ({ owner, to, delegate, tree, root, dataHash, creatorHash, nonce, index, proof, v2 = null }) => {
    const config = treeConfigAddress(tree);
    const hashes = [base58Decode32(root), base58Decode32(dataHash), base58Decode32(creatorHash)];
    const tail = [u64le(nonce), Uint8Array.from([index & 0xff, (index >> 8) & 0xff, (index >> 16) & 0xff, (index >>> 24) & 0xff])];
    if (!v2) {
      return {
        programId: BUBBLEGUM,
        keys: [r(config), s(owner), r(delegate), r(to), w(tree), r(SPL_NOOP), r(SPL_COMPRESSION), r(SYSTEM_PROGRAM), ...proof.map(r)],
        data: concat(Uint8Array.of(163, 52, 200, 231, 140, 3, 69, 186), ...hashes, ...tail),
      };
    }
    const opt = (v, enc) => (v == null ? Uint8Array.of(0) : concat(Uint8Array.of(1), enc(v)));
    return {
      programId: BUBBLEGUM,
      keys: [w(config), s(owner, true), s(owner), r(owner), r(delegate), r(to), w(tree), r(v2.collection ?? BUBBLEGUM), r(MPL_NOOP), r(MPL_COMPRESSION), r(SYSTEM_PROGRAM), ...proof.map(r)],
      data: concat(Uint8Array.of(119, 40, 6, 235, 234, 221, 248, 49), ...hashes, opt(v2.assetDataHash, base58Decode32), opt(v2.flags, (f) => Uint8Array.of(f)), ...tail),
    };
  },
};

/**
 * The transfer of one of your Solana NFTs to `to`: { instructions, summary, warnings }. The asset is read fresh and must
 * be yours; a compressed one's proof must add up (its id from its tree and nonce, its leaf from its fields, the root
 * from the leaf and proof) before plum builds on it. The chain checks the rest.
 */
export async function planSolSend(rpc, owner, { id, to }) {
  if (!isAddress(id)) throw fail('pick an NFT');
  if (!isAddress(to)) throw fail("that isn't a Solana address");
  if (to === owner) throw fail("that's the wallet it's in already");
  const [dest] = await rpc.accounts([to]);
  if (dest?.executable) throw fail('that address is a program: an NFT sent to it would be lost');
  let asset = null;
  try { asset = await rpc.call('getAsset', { id, displayOptions: { showCollectionMetadata: true } }); } catch { /* no DAS: a Metaplex NFT by its mint */ }
  const nft = asset ? fromDas(asset) : await legacyByMint(rpc, owner, id);
  if (!nft) throw fail("plum can't send this kind of asset");
  const holder = asset ? asset.ownership?.owner : owner;
  if (holder !== owner) throw fail("this NFT isn't in this wallet any more");
  const warnings = [];
  if (nft.frozen && nft.standard !== 'compressed') warnings.push({ level: 'warn', text: 'this NFT is frozen (staked or listed somewhere): the transfer will fail until it is unfrozen' });
  const summary = { standard: nft.standard, id, name: nft.name, collection: nft.collection, to };
  if (nft.standard === 'compressed') return { instructions: [await compressedPlan(rpc, owner, to, asset)], summary, warnings };
  if (nft.standard === 'core') {
    const [acc] = await rpc.accounts([id]);
    const core = readCoreAsset(acc);
    if (!core || core.owner !== owner) throw fail("this Core asset isn't owned by this wallet on chain");
    return { instructions: [nftIx.coreTransfer({ owner, to, asset: id, collection: core.updateAuthority.kind === 'collection' ? core.updateAuthority.key : null })], summary, warnings };
  }
  // Metaplex NFTs live in a token account: the one holding it, whatever its address
  const held = await rpc.call('getTokenAccountsByOwner', [owner, { mint: id }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const src = (held?.value ?? []).find((v) => v.account?.data?.parsed?.info?.tokenAmount?.amount === '1');
  if (!src) throw fail("this NFT isn't in this wallet's token accounts");
  const program = src.account.owner;
  if (nft.standard === 'programmable') {
    const [meta] = await rpc.accounts([metadataAddress(id)]);
    const m = readMetadata(meta);
    if (!m) throw fail("plum can't read this NFT's metadata");
    if (program !== TOKEN_PROGRAM) throw fail("this programmable NFT isn't held the way Token Metadata expects");
    return { instructions: [nftIx.programmableTransfer({ owner, to, mint: id, source: src.pubkey, ruleSet: m.ruleSet })], summary, warnings };
  }
  const target = associatedTokenAddress(to, id, program);
  return {
    instructions: [ix.createAtaIdempotent(owner, target, to, id, program), ix.transferChecked(src.pubkey, id, target, owner, 1n, 0, program)],
    summary, warnings,
  };
}

/** A Metaplex NFT by its mint, from its metadata (an RPC without DAS). */
async function legacyByMint(rpc, owner, mint) {
  const [meta] = await rpc.accounts([metadataAddress(mint)]);
  const m = readMetadata(meta);
  if (!m) return null;
  return { chain: 'sol', id: mint, standard: m.tokenStandard === 4 || m.tokenStandard === 5 ? 'programmable' : 'legacy', name: plainName(m.name, 48) || null, collection: m.collection ? { id: m.collection.key, name: null, verified: m.collection.verified } : null, frozen: false };
}

/** A compressed NFT's transfer, from DAS's proof, checked to add up first. */
async function compressedPlan(rpc, owner, to, asset) {
  const c = asset.compression ?? {};
  const [proof, [treeAcc]] = await Promise.all([rpc.call('getAssetProof', { id: asset.id }), rpc.accounts([c.tree])]);
  const tree = readTree(treeAcc);
  if (!tree) throw fail("plum can't read this NFT's tree");
  const nonce = BigInt(c.leaf_id);
  if (compressedAssetId(c.tree, nonce) !== asset.id) throw fail("the NFT indexer's answer doesn't add up (its id isn't its tree and leaf): plum won't build on it");
  const delegate = asset.ownership?.delegate && isAddress(asset.ownership.delegate) ? asset.ownership.delegate : owner;
  const v2 = tree.program === MPL_COMPRESSION;
  const fields = { id: asset.id, owner, delegate, nonce, dataHash: c.data_hash, creatorHash: c.creator_hash };
  const group = (asset.grouping ?? []).find((g) => g?.group_key === 'collection' && isAddress(g.group_value));
  let extra = null;
  if (v2) {
    // a v2 leaf also hashes its collection (keccak of its key, or of 32 zero bytes for none), its asset data (keccak of
    // the data, empty for none) and its flags
    extra = {
      collectionHash: c.collection_hash || b58(keccak_256(group ? base58Decode32(group.group_value) : new Uint8Array(32))),
      assetDataHash: c.asset_data_hash || b58(keccak_256(new Uint8Array(0))),
      flags: Number(c.flags ?? 0),
    };
  }
  const leaf = leafHash({ ...fields, version: v2 ? 2 : 1, ...(extra ?? {}) });
  const nodes = Array.isArray(proof?.proof) ? proof.proof : [];
  if (nodes.length !== tree.depth || !nodes.every(isAddress)) throw fail("the NFT indexer's proof doesn't fit the NFT's tree: plum won't build on it");
  if (b58(leaf) !== proof.leaf || b58(rootOf(leaf, nodes, Number(c.leaf_id))) !== proof.root) throw fail("the NFT indexer's proof doesn't add up: plum won't build on it");
  return nftIx.compressedTransfer({
    owner, to, delegate, tree: c.tree, root: proof.root, dataHash: c.data_hash, creatorHash: c.creator_hash, nonce, index: Number(c.leaf_id),
    proof: nodes.slice(0, tree.depth - tree.canopy),
    v2: v2 ? { collection: group?.group_value ?? null, assetDataHash: c.asset_data_hash || null, flags: c.flags == null ? null : Number(c.flags) } : null,
  });
}

/* ------------------------------------------------------------ naming the NFTs a transaction moves (for previews) */

// Bubblegum's instructions that move, burn or hand over a compressed NFT: where the leaf's owner, new owner or new
// delegate and its tree sit among the accounts, and the optional fields before the nonce in the data
const BUBBLEGUM_IXS = [
  { disc: [163, 52, 200, 231, 140, 3, 69, 186], act: 'transfer', owner: 1, to: 3, tree: 4, opts: [] },
  { disc: [119, 40, 6, 235, 234, 221, 248, 49], act: 'transfer', owner: 3, to: 5, tree: 6, opts: [33, 2] },
  { disc: [116, 110, 29, 56, 107, 219, 42, 93], act: 'burn', owner: 1, tree: 3, opts: [] },
  { disc: [115, 210, 34, 240, 232, 143, 183, 16], act: 'burn', owner: 3, tree: 5, opts: [33, 2] },
  { disc: [90, 147, 75, 178, 85, 88, 4, 137], act: 'delegate', owner: 1, to: 3, tree: 4, opts: [] },
  { disc: [95, 87, 125, 140, 181, 131, 128, 227], act: 'delegate', owner: 2, to: 4, tree: 5, opts: [33, 33, 2] },
  { disc: [17, 229, 35, 218, 190, 241, 250, 123], act: 'delegate', owner: 2, to: 4, tree: 5, opts: [33, 33, 2] },
];

/** A Bubblegum instruction's compressed NFT and what happens to it: { act, owner, to, tree, nonce, id }, or null. */
export function readBubblegum(data, account) {
  const kind = BUBBLEGUM_IXS.find((k) => k.disc.every((b, i) => data[i] === b));
  if (!kind) return null;
  // the optional fields: a 0 tag is absent, a 1 tag is followed by the value (32 bytes, or a 1-byte flag)
  let at = 8 + 96;
  for (const size of kind.opts) {
    if (at >= data.length) return null;
    at += data[at] ? size : 1;
  }
  if (at + 12 > data.length) return null;
  const nonce = readU64(data, at);
  const tree = account(kind.tree);
  if (!tree) return null;
  return { act: kind.act, owner: account(kind.owner), to: kind.to != null ? account(kind.to) : null, tree, nonce, id: compressedAssetId(tree, nonce) };
}

/** Names for NFTs by id or mint, from DAS (empty when the RPC has none). */
export async function namesOf(rpc, ids) {
  const out = new Map();
  if (!ids.length || typeof rpc.call !== 'function') return out;
  try {
    const list = await rpc.call('getAssetBatch', { ids: ids.slice(0, 100), displayOptions: { showCollectionMetadata: true } }, { retries: 0 });
    for (const a of Array.isArray(list) ? list : []) {
      const n = fromDas(a);
      if (n) out.set(n.id, n);
    }
  } catch { /* no names: ids */ }
  return out;
}

/** An NFT in words for a warning: its name and collection, or its id. */
export const nftLabel = (n, id) => {
  const name = n?.name ?? null;
  const col = n?.collection?.name ?? null;
  if (name && col && !name.toLowerCase().startsWith(col.toLowerCase())) return `${name} (${col})`;
  return name ?? `${short(id, 4)}${n?.standard ? ` (${STANDARDS[n.standard]})` : ''}`;
};

/**
 * The NFTs a transaction moves, for its preview: { notes: [{ level, text, key }], labels: Map(mint -> { name, standard }) }.
 * Every NFT that leaves your wallet is named, on each standard: Metaplex NFTs from the token changes and their metadata,
 * Core assets from their accounts before and after, compressed NFTs from Bubblegum's own instructions (a simulation
 * can't show them). Burning one, or giving someone the right to move it, is said too.
 */
export async function nftNotes({ t, all, programOf, owner, ok, preMap, postMap, deltas, decimals, rpc }) {
  const notes = [];
  const labels = new Map();
  // Metaplex NFTs: a token with no decimals that has metadata
  const mints = [...deltas.keys()].filter((m) => decimals.get(m) === 0 && deltas.get(m) !== 0n);
  if (mints.length) {
    const metas = await rpc.accounts(mints.map(metadataAddress)).catch(() => []);
    mints.forEach((m, i) => {
      const md = readMetadata(metas[i]);
      if (!md) return;
      labels.set(m, { name: plainName(md.name, 48) || null, standard: md.tokenStandard === 4 || md.tokenStandard === 5 ? 'programmable' : 'legacy' });
      if (deltas.get(m) < 0n) notes.push({ level: 'warn', text: `an NFT leaves your wallet: ${nftLabel(labels.get(m), m)}`, key: `nft:${m}` });
    });
  }
  // Core assets: yours before, and after it someone else's, burnt, or with a new delegate
  if (ok) {
    for (const [addr, pre] of preMap) {
      const a = readCoreAsset(pre);
      if (!a || a.owner !== owner) continue;
      const after = postMap.get(addr);
      const b = readCoreAsset(after);
      const label = nftLabel({ name: plainName(a.name, 48) || null, standard: 'core' }, addr);
      if (!b) notes.push({ level: 'warn', text: `it burns your NFT ${label}`, key: `nft:${addr}` });
      else if (b.owner !== owner) notes.push({ level: 'warn', text: `an NFT leaves your wallet: ${label}, to ${short(b.owner)}`, key: `nft:${addr}` });
      for (const d of b?.delegates ?? []) {
        if (d.address !== owner && !a.delegates.some((x) => x.type === d.type && x.address === d.address)) {
          notes.push({ level: 'danger', text: `it lets ${short(d.address)} ${d.type} your NFT ${label} without asking you again`, key: `nft-delegate:${addr}:${d.type}` });
        }
      }
    }
  }
  // compressed NFTs: what Bubblegum's instructions do to leaves you own
  const moves = t.instructions.filter((x) => programOf(x) === BUBBLEGUM).map((x) => readBubblegum(x.data, (k) => all[x.accounts[k]])).filter((m) => m && m.owner === owner);
  const names = await namesOf(rpc, [...new Set(moves.map((m) => m.id))]);
  for (const m of moves) {
    const label = nftLabel(names.get(m.id) ?? { standard: 'compressed' }, m.id);
    if (m.act === 'transfer' && m.to !== owner) notes.push({ level: 'warn', text: `an NFT leaves your wallet: ${label}, to ${short(m.to)}`, key: `nft:${m.id}` });
    if (m.act === 'burn') notes.push({ level: 'warn', text: `it burns your NFT ${label}`, key: `nft:${m.id}` });
    if (m.act === 'delegate' && m.to !== owner) notes.push({ level: 'danger', text: `it lets ${short(m.to)} move your NFT ${label} without asking you again`, key: `nft-delegate:${m.id}` });
  }
  // a compressed-NFT tree written to from inside another program: which leaf moves can't be read
  const named = new Set(t.instructions.filter((x) => programOf(x) === BUBBLEGUM).map((x) => readBubblegum(x.data, (k) => all[x.accounts[k]])?.tree).filter(Boolean));
  for (const [addr, pre] of preMap) {
    if ((pre?.owner === SPL_COMPRESSION || pre?.owner === MPL_COMPRESSION) && !named.has(addr)) {
      notes.push({ level: 'warn', text: `it changes the compressed-NFT tree ${short(addr)} from inside another program: plum can't tell which NFT moves, and any of yours in that tree could`, key: `tree:${addr}` });
    }
  }
  return { notes, labels };
}

/* ------------------------------------------------------------ Ethereum */

const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
/** Blockscout pages read at most (50 NFTs each). */
const ETH_PAGES = 4;

/** What an address holds on Ethereum, ERC-721 and ERC-1155, by Blockscout's word (scams by its word left out). */
export async function listEth(address) {
  const items = [];
  let next = null;
  for (let page = 0; page < ETH_PAGES; page++) {
    const q = new URLSearchParams({ type: 'ERC-721,ERC-1155', ...(next ?? {}) });
    const r = await getJson(`${BLOCKSCOUT}/addresses/${address}/nft?${q}`, { timeout: 20_000 });
    items.push(...(Array.isArray(r?.items) ? r.items : []));
    next = r?.next_page_params && typeof r.next_page_params === 'object' ? Object.fromEntries(Object.entries(r.next_page_params).map(([k, v]) => [k, String(v)])) : null;
    if (!next) break;
  }
  return items.map((it) => fromBlockscout(it)).filter(Boolean).sort(byCollection);
}

/** Does `owner` hold this NFT now, by the contract's own word (ERC-721 ownerOf, ERC-1155 balanceOf)? */
export async function ethHolds(urls, { contract, id, standard, owner, amount = 1n }) {
  try {
    if (standard === 'erc721') {
      const r = await ethRpc(urls, 'eth_call', [{ to: contract, data: `0x6352211e${word(id)}` }, 'latest']);
      return typeof r === 'string' && r.length >= 42 && sameAddress(`0x${r.slice(-40)}`, owner);
    }
    const r = await ethRpc(urls, 'eth_call', [{ to: contract, data: `0x00fdd58e${word(BigInt(owner))}${word(id)}` }, 'latest']);
    return BigInt(r && r !== '0x' ? r : '0x0') >= BigInt(amount);
  } catch {
    return false;
  }
}

/** ERC-721 safeTransferFrom(from, to, id) and ERC-1155 safeTransferFrom(from, to, id, amount, ""). */
export function erc721TransferData(from, to, id) {
  return `0x42842e0e${word(from)}${word(to)}${word(id)}`;
}
export function erc1155TransferData(from, to, id, amount) {
  return `0xf242432a${word(from)}${word(to)}${word(id)}${word(amount)}${word(0xa0n)}${word(0n)}`;
}
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

/** One Blockscout NFT as plum keeps it, or null (a scam by Blockscout's word, a malformed one). */
export function fromBlockscout(item, network = 'eth') {
  const t = item?.token;
  const contract = t?.address_hash ?? t?.address;
  const type = item?.token_type ?? t?.type;
  if (typeof contract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contract) || (type !== 'ERC-721' && type !== 'ERC-1155')) return null;
  if (t.reputation === 'scam') return null;
  let id;
  try { id = BigInt(item.id).toString(); } catch { return null; }
  let amount = '1';
  try { amount = BigInt(item.value ?? 1).toString(); } catch { /* one */ }
  const collection = plainName(t.name ?? '', 40) || null;
  const name = plainName(typeof item.metadata?.name === 'string' ? item.metadata.name : '', 48) || null;
  return { chain: 'eth', network, id, contract, standard: type === 'ERC-721' ? 'erc721' : 'erc1155', name, symbol: plainName(t.symbol ?? '', 12) || null, collection: { id: contract, name: collection, verified: t.reputation === 'ok' }, amount };
}
