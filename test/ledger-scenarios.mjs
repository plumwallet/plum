// What plum asks of a Ledger, scenario by scenario, with the answers it must get: run live against Ledger's Speculos
// emulator by scripts/ledger-speculos.mjs (which records every exchange), and replayed from that record by
// test/ledger-speculos.test.mjs (so every APDU plum sends is checked byte for byte against what the real apps took).
// Inputs are fixed, the device's seed is the "abandon ... about" test phrase, and every result is checked against
// plum's own keys for that phrase.
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { MessageV0, PublicKey, SystemProgram } from '@solana/web3.js';
import { base58Decode, base58Encode } from '../src/shared/base58.js';
import { concat, hex, u32le, u64le, utf8 } from '../src/shared/bytes.js';
import { associatedTokenAddress } from '../src/shared/pda.js';
import { TOKEN_PROGRAM, compileLegacy, ix } from '../src/shared/tx.js';
import * as B from '../src/background/btc.js';
import { SIGHASH, sighashV0, sighashV1 } from '../src/background/btc-tx.js';
import * as E from '../src/background/eth.js';
import { addressOf, hash160, secretAt, seedOf, signBtcDigest, verifySol } from '../src/background/keys.js';
import { appInfo } from '../src/background/ledger/apdu.js';
import * as LB from '../src/background/ledger/bitcoin.js';
import * as LE from '../src/background/ledger/ethereum.js';
import * as LS from '../src/background/ledger/solana.js';
import { STAKE_PROGRAM, addressWithSeed, stakeIx, stakeSeed } from '../src/background/stake.js';
import { internalKey, outputKey, taprootAddressOf, taprootScript, verifyKeyPath } from '../src/background/taproot.js';

export const SEED_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedOf(SEED_PHRASE);
const root = HDKey.fromMasterSeed(seed);
const SOL = "m/44'/501'/0'/0'";
const ETH = "m/44'/60'/0'/0/0";
const BTC = "m/84'/0'/0'/0/0";
export const ME = { sol: addressOf('sol', secretAt(seed, 'sol', SOL)), eth: addressOf('eth', secretAt(seed, 'eth', ETH)), btc: addressOf('btc', secretAt(seed, 'btc', BTC)) };

/* ------------------------------------------------------------ fixed inputs */

const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));
const TO = base58Encode(new Uint8Array(32).fill(9));
export const SOL_TRANSFER = compileLegacy({ payer: ME.sol, blockhash: BLOCKHASH, instructions: [ix.unitLimit(1000), ix.unitPrice(5000n), ix.transfer(ME.sol, TO, 12_345_678n)] });
// many transfers: a message longer than one APDU (the pieces' P2 flags)
export const SOL_LONG = compileLegacy({ payer: ME.sol, blockhash: BLOCKHASH, instructions: Array.from({ length: 9 }, (_, i) => ix.transfer(ME.sol, base58Encode(new Uint8Array(32).fill(20 + i)), 1000n + BigInt(i))) });
export const SOL_V0 = MessageV0.compile({ payerKey: new PublicKey(ME.sol), recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(ME.sol), toPubkey: new PublicKey(TO), lamports: 4242 })] }).serialize();
// staking as plum builds it: a stake account at an address derived from the wallet (createAccountWithSeed), so the
// wallet is its only signer; then unstaking and withdrawing it
const VOTE = base58Encode(new Uint8Array(32).fill(11));
const STAKE_ACCOUNT = addressWithSeed(ME.sol, stakeSeed(0), STAKE_PROGRAM);
const own = (instructions, units = 1000) => compileLegacy({ payer: ME.sol, blockhash: BLOCKHASH, instructions: [ix.unitLimit(units), ix.unitPrice(5000n), ...instructions] });
export const SOL_STAKE = own([stakeIx.createWithSeed(ME.sol, STAKE_ACCOUNT, stakeSeed(0), 1_002_282_880n), stakeIx.initialize(STAKE_ACCOUNT, ME.sol), stakeIx.delegate(STAKE_ACCOUNT, VOTE, ME.sol)], 1500);
export const SOL_UNSTAKE = own([stakeIx.deactivate(STAKE_ACCOUNT, ME.sol)]);
export const SOL_WITHDRAW = own([stakeIx.withdraw(STAKE_ACCOUNT, ME.sol, 1_002_282_880n)]);
// an NFT (a legacy Metaplex one) as plum sends it: the recipient's token account if it's missing, then TransferChecked
const NFT_MINT = base58Encode(new Uint8Array(32).fill(12));
export const SOL_NFT = own([
  ix.createAtaIdempotent(ME.sol, associatedTokenAddress(TO, NFT_MINT, TOKEN_PROGRAM), TO, NFT_MINT, TOKEN_PROGRAM),
  ix.transferChecked(associatedTokenAddress(ME.sol, NFT_MINT, TOKEN_PROGRAM), NFT_MINT, associatedTokenAddress(TO, NFT_MINT, TOKEN_PROGRAM), ME.sol, 1n, 0, TOKEN_PROGRAM),
], 30_000);
export const SOL_UNKNOWN = compileLegacy({ payer: ME.sol, blockhash: BLOCKHASH, instructions: [{ programId: base58Encode(new Uint8Array(32).fill(5)), keys: [{ pubkey: ME.sol, isSigner: true, isWritable: true }], data: Uint8Array.of(1, 2, 3) }] });

export const ETH_TX = { nonce: 7n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n, gas: 21_000n, to: '0x000000000000000000000000000000000000dEaD', value: 10n ** 16n, data: '0x' };
export const ETH_CALL = { nonce: 8n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n, gas: 60_000n, to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', value: 0n, data: E.transferData('0x000000000000000000000000000000000000dEaD', 1_000_000n) };
// the same transfer on Ethereum's other networks: only the chain id differs
export const onNetwork = (chainId) => ({ ...ETH_TX, chainId });
export const ETH_LONG_MESSAGE =utf8(`plum signs a long message: ${'abcdefghij'.repeat(40)}`);
export const MAIL = E.parseTypedData({
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
    Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }, { name: 'tags', type: 'string[]' }, { name: 'n', type: 'int16' }, { name: 'ok', type: 'bool' }, { name: 'ref', type: 'bytes32' }, { name: 'blob', type: 'bytes' }],
  },
  primaryType: 'Mail',
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  message: { from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' }, to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }, contents: 'Hello, Bob!', tags: ['a', 'bb'], n: -3, ok: true, ref: `0x${'ab'.repeat(32)}`, blob: '0x0102030405' },
});
// a bare "uint" (no size) can't go field by field exactly as hashed: plum sends the two hashes instead
export const BARE_UINT = E.parseTypedData({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Order: [{ name: 'amount', type: 'uint' }, { name: 'owner', type: 'address' }] },
  primaryType: 'Order',
  domain: { name: 'Plum Test', chainId: 1 },
  message: { amount: '1000', owner: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' },
});

/** A previous transaction paying `value` sats to wallet 1 (its bc1q address, or `script`), made unique by `tag`. */
function prevTx(value, tag, script = null) {
  const own = concat(Uint8Array.of(0x00, 0x14), hash160(secp256k1.getPublicKey(secretAt(seed, 'btc', BTC), true)));
  const to = script ?? own;
  const raw = concat(u32le(2), Uint8Array.of(1), new Uint8Array(32).fill(tag), u32le(0), Uint8Array.of(0), u32le(0xffffffff), Uint8Array.of(1), u64le(value), Uint8Array.of(to.length), to, u32le(0));
  return { raw, txid: hex(sha256(sha256(raw)).reverse()), own };
}
const P1 = prevTx(100_000n, 3);
const P2 = prevTx(25_000n, 4);
const DEST = B.addressScript('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
export const BTC_PLAN = {
  inputs: [{ txid: P1.txid, vout: 0, value: 100_000n, confirmed: true }, { txid: P2.txid, vout: 0, value: 25_000n, confirmed: true }],
  outputs: [{ script: DEST.script, value: 110_000n, kind: 'p2wpkh', mine: false }, { script: P1.own, value: 13_000n, kind: 'p2wpkh', mine: true }],
  fee: 2_000n,
};
export const BTC_PREV = new Map([[P1.txid, LB.stripWitness(hex(P1.raw), P1.txid)], [P2.txid, LB.stripWitness(hex(P2.raw), P2.txid)]]);
export const btcDigests = () => B.sighashes({ inputs: BTC_PLAN.inputs, outputs: BTC_PLAN.outputs, locktime: 0 }, hash160(secp256k1.getPublicKey(secretAt(seed, 'btc', BTC), true)));

// taproot: wallet 1's bc1p address (m/86'), its coins spent alone and beside a bc1q one
const TR = "m/86'/0'/0'/0/0";
export const TAPROOT = taprootAddressOf(secretAt(seed, 'btc', TR));
const TR_OUTPUT = outputKey(internalKey(secretAt(seed, 'btc', TR))).x;
const FPR = root.fingerprint.toString(16).padStart(8, '0');
const XPUB84 = root.derive("m/84'/0'/0'").publicExtendedKey;
const XPUB86 = root.derive("m/86'/0'/0'").publicExtendedKey;
const T1 = prevTx(60_000n, 5, taprootScript(TR_OUTPUT));
const T2 = prevTx(15_000n, 6, taprootScript(TR_OUTPUT));
const P3 = prevTx(20_000n, 7);
export const TR_PLAN = {
  inputs: [{ txid: T1.txid, vout: 0, value: 60_000n, kind: 'p2tr', confirmed: true }, { txid: T2.txid, vout: 0, value: 15_000n, kind: 'p2tr', confirmed: true }],
  outputs: [{ script: DEST.script, value: 70_000n, kind: 'p2wpkh', mine: false }, { script: P1.own, value: 3_400n, kind: 'p2wpkh', mine: true }],
  fee: 1_600n,
};
export const MIXED_PLAN = {
  inputs: [{ txid: P3.txid, vout: 0, value: 20_000n, kind: 'p2wpkh', confirmed: true }, { txid: T1.txid, vout: 0, value: 60_000n, kind: 'p2tr', confirmed: true }],
  outputs: [{ script: DEST.script, value: 75_000n, kind: 'p2wpkh', mine: false }, { script: P1.own, value: 3_300n, kind: 'p2wpkh', mine: true }],
  fee: 1_700n,
};
const TR_PREV = new Map([T1, T2, P3].map((p) => [p.txid, LB.stripWitness(hex(p.raw), p.txid)]));
const btcKeys = () => ({ fingerprint: FPR, segwit: { publicKey: LB.derive(XPUB84, 0).publicKey, path: BTC }, taproot: { ...LB.deriveTaproot(XPUB86, 0), path: TR } });
const trMaps = (plan) => LB.psbtMaps({ inputs: plan.inputs, outputs: plan.outputs, sequence: 0xfffffffd }, btcKeys(), TR_PREV);

/** What each coin of a plan signs, as plum's signSpend works it out: BIP-143 for bc1q coins, BIP-341 for bc1p ones. */
function planDigests(plan) {
  const keyHash = hash160(secp256k1.getPublicKey(secretAt(seed, 'btc', BTC), true));
  const tx = { version: 2, locktime: 0, inputs: plan.inputs.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffd, scriptSig: new Uint8Array(0), witness: [] })), outputs: plan.outputs };
  const prevouts = plan.inputs.map((c) => ({ value: c.value, script: c.kind === 'p2tr' ? taprootScript(TR_OUTPUT) : P1.own }));
  return plan.inputs.map((c, i) => (c.kind === 'p2tr' ? sighashV1(tx, i, prevouts, SIGHASH.DEFAULT) : sighashV0(tx, i, B.p2pkhCode(keyHash), c.value, SIGHASH.ALL)));
}
/** The device's taproot signatures: one per bc1p coin, each a BIP-340 signature by the tweaked key over plum's sighash. */
function checkTaproot(yields, plan, digests = planDigests(plan)) {
  assert.deepEqual(yields.map((y) => y.index), plan.inputs.flatMap((c, i) => (c.kind === 'p2tr' ? [i] : [])));
  for (const y of yields) {
    assert.equal(y.signature.length, 64, 'SIGHASH_DEFAULT: no sighash byte');
    assert.ok(verifyKeyPath(y.signature, digests[y.index], TR_OUTPUT), `input ${y.index}'s signature verifies`);
  }
}

/* ------------------------------------------------------------ the scenarios */

const rejects = async (p, state) => {
  try { await p; } catch (e) { assert.equal(e.state, state, `${e.state}: ${e.message}`); return e; }
  throw new Error(`expected a ${state} error`);
};

/**
 * { name, app, device: 'approve' | 'reject' | null (no review), settings: what must be on in the app first, run(link),
 *   check(result) }.
 */
export const SCENARIOS = [
  // Solana
  { name: 'sol app info', app: 'Solana', run: (l) => appInfo(l), check: (r) => assert.equal(r.name, 'Solana') },
  { name: 'sol settings', app: 'Solana', run: (l) => LS.config(l), check: (r) => assert.equal(typeof r.blindSigning, 'boolean') },
  { name: 'sol address', app: 'Solana', run: (l) => LS.address(l, SOL), check: (r) => assert.equal(r, ME.sol) },
  { name: 'sol address, ledger live path', app: 'Solana', run: (l) => LS.address(l, "m/44'/501'/0'"), check: (r) => assert.equal(r, addressOf('sol', secretAt(seed, 'sol', "m/44'/501'/0'"))) },
  { name: 'sol sign a transfer', app: 'Solana', device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_TRANSFER), check: (r) => assert.ok(verifySol(r, SOL_TRANSFER, base58Decode(ME.sol))) },
  { name: 'sol sign a v0 transaction', app: 'Solana', device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_V0), check: (r) => assert.ok(verifySol(r, SOL_V0, base58Decode(ME.sol))) },
  { name: 'sol turned down on the device', app: 'Solana', device: 'reject', run: (l) => rejects(LS.signTransaction(l, SOL, SOL_TRANSFER), 'rejected'), check: () => {} },
  { name: 'sol unknown program needs blind signing', app: 'Solana', run: (l) => rejects(LS.signTransaction(l, SOL, SOL_UNKNOWN), 'blind-sign'), check: () => {} },
  { name: 'sol a long transaction (pieces) needs blind signing', app: 'Solana', run: (l) => rejects(LS.signTransaction(l, SOL, SOL_LONG), 'blind-sign'), check: () => {} },
  { name: 'sol sign a message (ascii)', app: 'Solana', device: 'approve', run: (l) => LS.signOffchain(l, SOL, utf8('hello from plum, sign me'), base58Decode(ME.sol)), check: (r) => { assert.equal(r.signed.length, 85 + 24); assert.ok(verifySol(r.signature, r.signed, base58Decode(ME.sol))); } },
  { name: 'sol a message that is not ascii needs blind signing', app: 'Solana', run: (l) => rejects(LS.signOffchain(l, SOL, utf8('plum dit bonjour, ça va'), base58Decode(ME.sol)), 'blind-sign'), check: () => {} },
  { name: 'sol sign a stake (create with seed, initialize, delegate)', app: 'Solana', device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_STAKE), check: (r) => assert.ok(verifySol(r, SOL_STAKE, base58Decode(ME.sol))) },
  { name: 'sol sign an unstake', app: 'Solana', device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_UNSTAKE), check: (r) => assert.ok(verifySol(r, SOL_UNSTAKE, base58Decode(ME.sol))) },
  { name: 'sol sign a stake withdrawal', app: 'Solana', device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_WITHDRAW), check: (r) => assert.ok(verifySol(r, SOL_WITHDRAW, base58Decode(ME.sol))) },
  { name: 'sol an NFT send needs blind signing', app: 'Solana', run: (l) => rejects(LS.signTransaction(l, SOL, SOL_NFT), 'blind-sign'), check: () => {} },
  { name: 'sol sign a long transaction (pieces), blind signing on', app: 'Solana', settings: ['blind'], device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_LONG), check: (r) => assert.ok(SOL_LONG.length > 255 && verifySol(r, SOL_LONG, base58Decode(ME.sol))) },
  { name: 'sol sign an unknown program, blind signing on', app: 'Solana', settings: ['blind'], device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_UNKNOWN), check: (r) => assert.ok(verifySol(r, SOL_UNKNOWN, base58Decode(ME.sol))) },
  { name: 'sol sign a message that is not ascii, blind signing on', app: 'Solana', settings: ['blind'], device: 'approve', run: (l) => LS.signOffchain(l, SOL, utf8('plum dit bonjour, ça va'), base58Decode(ME.sol)), check: (r) => { assert.equal(r.signed[16 + 1 + 32], 1); assert.ok(verifySol(r.signature, r.signed, base58Decode(ME.sol))); } },
  { name: 'sol sign an NFT send (its token account, then TransferChecked), blind signing on', app: 'Solana', settings: ['blind'], device: 'approve', run: (l) => LS.signTransaction(l, SOL, SOL_NFT), check: (r) => assert.ok(verifySol(r, SOL_NFT, base58Decode(ME.sol))) },
  // Ethereum
  { name: 'eth app info', app: 'Ethereum', run: (l) => appInfo(l), check: (r) => assert.equal(r.name, 'Ethereum') },
  { name: 'eth settings', app: 'Ethereum', run: (l) => LE.config(l), check: (r) => assert.equal(typeof r.blindSigning, 'boolean') },
  { name: 'eth address', app: 'Ethereum', run: (l) => LE.address(l, ETH), check: (r) => assert.equal(r, ME.eth) },
  { name: 'eth address, ledger live path', app: 'Ethereum', run: (l) => LE.address(l, "m/44'/60'/1'/0/0"), check: (r) => assert.equal(r, addressOf('eth', root.derive("m/44'/60'/1'/0/0").privateKey)) },
  { name: 'eth sign a transfer', app: 'Ethereum', device: 'approve', run: (l) => LE.signTransaction(l, ETH, E.unsignedTx(ETH_TX)), check: (r) => assert.equal(E.signerOf(E.txDigest(ETH_TX), r), ME.eth) },
  { name: 'eth a contract call needs blind signing', app: 'Ethereum', run: (l) => rejects(LE.signTransaction(l, ETH, E.unsignedTx(ETH_CALL)), 'blind-sign'), check: () => {} },
  { name: 'eth personal_sign', app: 'Ethereum', device: 'approve', run: (l) => LE.signPersonal(l, ETH, utf8('Sign in to example.org with plum')), check: (r) => assert.equal(E.signerOf(E.personalDigest(utf8('Sign in to example.org with plum')), r), ME.eth) },
  { name: 'eth personal_sign, a long one (pieces)', app: 'Ethereum', device: 'approve', run: (l) => LE.signPersonal(l, ETH, ETH_LONG_MESSAGE), check: (r) => assert.equal(E.signerOf(E.personalDigest(ETH_LONG_MESSAGE), r), ME.eth) },
  { name: 'eth sign a transfer on Base', app: 'Ethereum', device: 'approve', run: (l) => LE.signTransaction(l, ETH, E.unsignedTx(onNetwork(8453))), check: (r) => assert.equal(E.signerOf(E.txDigest(onNetwork(8453)), r), ME.eth) },
  { name: 'eth sign a transfer on Polygon', app: 'Ethereum', device: 'approve', run: (l) => LE.signTransaction(l, ETH, E.unsignedTx(onNetwork(137))), check: (r) => assert.equal(E.signerOf(E.txDigest(onNetwork(137)), r), ME.eth) },
  { name: 'eth sign a transfer on Arbitrum', app: 'Ethereum', device: 'approve', run: (l) => LE.signTransaction(l, ETH, E.unsignedTx(onNetwork(42161))), check: (r) => assert.equal(E.signerOf(E.txDigest(onNetwork(42161)), r), ME.eth) },
  { name: 'eth typed data without raw messages on', app: 'Ethereum', run: (l) => rejects(LE.signTyped(l, ETH, MAIL, E.typedHashes(MAIL), { version: '1.23.0' }), 'blind-sign'), check: () => {} },
  { name: 'eth typed data, field by field', app: 'Ethereum', settings: ['raw'], device: 'approve', run: (l) => LE.signTyped(l, ETH, MAIL, E.typedHashes(MAIL), { version: '1.23.0' }), check: (r) => { assert.equal(r.mode, 'fields'); assert.equal(E.signerOf(E.typedDigest(MAIL), r.sig), ME.eth); } },
  { name: 'eth a contract call with blind signing on', app: 'Ethereum', settings: ['blind'], device: 'approve', run: (l) => LE.signTransaction(l, ETH, E.unsignedTx(ETH_CALL)), check: (r) => assert.equal(E.signerOf(E.txDigest(ETH_CALL), r), ME.eth) },
  { name: 'eth typed data as its two hashes', app: 'Ethereum', settings: ['blind'], device: 'approve', run: (l) => LE.signTyped(l, ETH, BARE_UINT, E.typedHashes(BARE_UINT), { version: '1.23.0' }), check: (r) => { assert.equal(r.mode, 'hashes'); assert.equal(E.signerOf(E.typedDigest(BARE_UINT), r.sig), ME.eth); } },
  // Bitcoin
  { name: 'btc app info', app: 'Bitcoin', run: (l) => appInfo(l), check: (r) => { assert.equal(r.name, 'Bitcoin'); LB.checkApp(r); } },
  { name: 'btc fingerprint', app: 'Bitcoin', run: (l) => LB.fingerprint(l), check: (r) => assert.equal(r, root.fingerprint.toString(16).padStart(8, '0')) },
  { name: 'btc account key', app: 'Bitcoin', run: (l) => LB.xpub(l, "m/84'/0'/0'"), check: (r) => assert.equal(r, root.derive("m/84'/0'/0'").publicExtendedKey) },
  { name: 'btc address from the policy', app: 'Bitcoin', run: (l) => LB.walletAddress(l, LB.segwitPolicy(root.fingerprint.toString(16).padStart(8, '0'), root.derive("m/84'/0'/0'").publicExtendedKey), { index: 0 }), check: (r) => assert.equal(r, ME.btc) },
  { name: 'btc address shown on the device', app: 'Bitcoin', device: 'approve', run: (l) => LB.walletAddress(l, LB.segwitPolicy(root.fingerprint.toString(16).padStart(8, '0'), root.derive("m/84'/0'/0'").publicExtendedKey), { index: 3, display: true }), check: (r) => assert.equal(r, addressOf('btc', secretAt(seed, 'btc', "m/84'/0'/0'/0/3"))) },
  {
    name: 'btc sign a send (two coins, change back)', app: 'Bitcoin', device: 'approve',
    run: (l) => {
      const fpr = root.fingerprint.toString(16).padStart(8, '0');
      const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
      const { publicKey } = LB.derive(xpub, 0);
      const maps = LB.psbtMaps({ inputs: BTC_PLAN.inputs, outputs: BTC_PLAN.outputs, sequence: 0xfffffffd }, { fingerprint: fpr, segwit: { publicKey, path: BTC } }, BTC_PREV);
      return LB.signPsbt(l, maps, LB.segwitPolicy(fpr, xpub));
    },
    check: (r) => {
      const digests = btcDigests();
      const key = secretAt(seed, 'btc', BTC);
      assert.equal(r.length, 2);
      for (const y of r) {
        assert.equal(hex(y.publicKey), hex(secp256k1.getPublicKey(key, true)));
        assert.equal(y.signature.at(-1), 1);
        // RFC 6979 on both sides: the device's signature is plum's own, byte for byte
        assert.equal(hex(y.signature.slice(0, -1)), hex(signBtcDigest(digests[y.index], key)));
      }
    },
  },
  { name: 'btc sign a message', app: 'Bitcoin', device: 'approve', run: (l) => LB.signMessage(l, BTC, utf8('hello from plum')), check: (r) => assert.ok(r[0] >= 31 && r[0] <= 34) },
  // Bitcoin, taproot
  { name: 'btc taproot account key', app: 'Bitcoin', run: (l) => LB.xpub(l, "m/86'/0'/0'"), check: (r) => assert.equal(r, XPUB86) },
  { name: 'btc taproot address from the policy', app: 'Bitcoin', run: (l) => LB.walletAddress(l, LB.taprootPolicy(FPR, XPUB86), { index: 0 }), check: (r) => { assert.equal(r, TAPROOT); assert.equal(LB.deriveTaproot(XPUB86, 0).address, r); } },
  { name: 'btc taproot address shown on the device', app: 'Bitcoin', device: 'approve', run: (l) => LB.walletAddress(l, LB.taprootPolicy(FPR, XPUB86), { index: 2, display: true }), check: (r) => assert.equal(r, taprootAddressOf(secretAt(seed, 'btc', "m/86'/0'/0'/0/2"))) },
  { name: 'btc sign a taproot send (two coins)', app: 'Bitcoin', device: 'approve', run: (l) => LB.signPsbt(l, trMaps(TR_PLAN), LB.taprootPolicy(FPR, XPUB86)), check: (r) => checkTaproot(r, TR_PLAN) },
  {
    // as hw.js's signBtc does it: the bc1q coin under the segwit policy, then the bc1p coin under the taproot one
    name: 'btc sign a send from both addresses (two passes)', app: 'Bitcoin', device: 'approve2',
    run: async (l) => {
      const maps = trMaps(MIXED_PLAN);
      return { segwit: await LB.signPsbt(l, maps, LB.segwitPolicy(FPR, XPUB84)), taproot: await LB.signPsbt(l, maps, LB.taprootPolicy(FPR, XPUB86)) };
    },
    check: (r) => {
      const digests = planDigests(MIXED_PLAN);
      const key = secretAt(seed, 'btc', BTC);
      assert.deepEqual(r.segwit.map((y) => y.index), [0]);
      assert.equal(hex(r.segwit[0].signature), hex(concat(signBtcDigest(digests[0], key), Uint8Array.of(1))));
      checkTaproot(r.taproot, MIXED_PLAN, digests);
    },
  },
];
