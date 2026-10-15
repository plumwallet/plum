// The smaller guards: token account addresses, the phishing checks, and amounts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { associatedTokenAddress, findProgramAddress, isOnCurve } from '../src/shared/pda.js';
import { checkHost, lookalikeOf, parseList } from '../src/background/phishing.js';
import { formatUnits, parseUnits, prettyAmount } from '../src/shared/format.js';

test('associated token addresses match spl-token for 200 random owners, both token programs', () => {
  for (let i = 0; i < 100; i++) {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    for (const p of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      assert.equal(associatedTokenAddress(owner.toBase58(), mint.toBase58(), p.toBase58()), getAssociatedTokenAddressSync(mint, owner, false, p).toBase58());
    }
  }
});

test('on-curve: wallets are, program addresses are not', () => {
  const [pda] = findProgramAddress([new Uint8Array([1, 2, 3])], TOKEN_PROGRAM_ID.toBase58());
  assert.equal(isOnCurve(new PublicKey(pda).toBytes()), false);
  assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);
  const [theirs] = PublicKey.findProgramAddressSync([Buffer.from([1, 2, 3])], TOKEN_PROGRAM_ID);
  assert.equal(pda, theirs.toBase58());
});

const LISTS = {
  block: parseList(`---\n  - url: phantom-app.online\n  - url: "*.web.app"\n  - url: raydium.network\n`),
  allow: parseList(`  - url: phantom.app\n  - url: good.web.app\n`),
};

test('blocklist: exact, subdomains, wildcards; the more specific entry wins', () => {
  assert.equal(checkHost('phantom-app.online', LISTS).level, 'blocked');
  assert.equal(checkHost('claim.phantom-app.online', LISTS).level, 'blocked');
  assert.equal(checkHost('drainer.web.app', LISTS).level, 'blocked');
  assert.equal(checkHost('good.web.app', LISTS).level, null);
  assert.equal(checkHost('raydium.network', LISTS).level, 'blocked');
  assert.equal(checkHost('localhost', LISTS).level, null);
  assert.equal(checkHost('127.0.0.1', LISTS).level, null);
  const lists = { block: parseList('  - url: claim.phantom.app\n'), allow: parseList('  - url: phantom.app\n') };
  assert.equal(checkHost('claim.phantom.app', lists).level, 'blocked', 'an allowed parent does not clear a blocked subdomain');
  assert.equal(checkHost('phantom.app', lists).level, null);
});

test('messages: text and the off-chain format are fine; anything that is or begins like a transaction is refused', async () => {
  const { messageRefusal } = await import('../src/background/main.js');
  const { Keypair: K, SystemProgram, Transaction } = await import('@solana/web3.js');
  const enc = new TextEncoder();
  assert.equal(messageRefusal(enc.encode('Sign in to plum.fun\nnonce: 9f2c')), null);
  assert.equal(messageRefusal(enc.encode('émoji first 🍑 then words')), null);
  assert.equal(messageRefusal(Uint8Array.of(0xff, ...enc.encode('solana offchain'), 0, 1, 2)), null);
  assert.equal(messageRefusal(crypto.getRandomValues(new Uint8Array(32)).map((b) => b & 0x7f)), null, 'opaque bytes below 0x80 are allowed (with a warning in the window)');
  const payer = K.generate().publicKey;
  const tx = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' }).add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  assert.match(messageRefusal(wire), /transaction/);
  assert.match(messageRefusal(tx.serializeMessage()), /transaction/);
  assert.match(messageRefusal(Uint8Array.from([...tx.serializeMessage(), 1, 2, 3])), /begin like/, 'a message with bytes after it');
  assert.match(messageRefusal(Uint8Array.of(0x81, ...wire.subarray(1))), /newer kind/, 'a v1-looking blob');
});

test('lookalikes are flagged; the real sites and ordinary ones are not', () => {
  for (const host of ['phamtom.app', 'raydlum.io', 'pump-fun.app', 'pumpfun.io', 'phantom-wallet.net', 'jupag.org', 'solflare-airdrop.com', 'magiceden.xyz', 'dexscreener.top', 'plumfun.xyz']) {
    assert.ok(lookalikeOf(host), `${host} should be flagged`);
  }
  for (const host of ['pump.fun', 'app.pump.fun', 'jup.ag', 'station.jup.ag', 'raydium.io', 'phantom.app', 'phantom.com', 'solscan.io', 'plum.fun', 'github.com', 'google.com', 'draft.io', 'tensorflow.org', 'solana.fm', 'solanabeach.io', 'x.com', 'axiom.trade', 'photon-sol.tinyastro.io', 'localhost']) {
    assert.equal(lookalikeOf(host), null, `${host} should pass`);
  }
});

test('amounts: exact in, exact out, friendly on screen', () => {
  assert.equal(parseUnits('1.5', 9), 1_500_000_000n);
  assert.equal(parseUnits('0.000000001', 9), 1n);
  assert.equal(parseUnits('1,000', 6), 1_000_000_000n);
  assert.equal(parseUnits('.5', 2), 50n);
  assert.throws(() => parseUnits('0.0000000001', 9), /9 decimals/);
  assert.throws(() => parseUnits('1e5', 9));
  assert.throws(() => parseUnits('-1', 9));
  assert.throws(() => parseUnits('', 9));
  assert.equal(formatUnits(1_500_000_000n, 9), '1.5');
  assert.equal(formatUnits(-5n, 2), '-0.05');
  assert.equal(formatUnits(100n, 0), '100');
  assert.equal(prettyAmount(12_345_678_901_234n, 9), '12,345.6');
  assert.equal(prettyAmount(1_234_567n, 9), '0.001234');
  assert.equal(prettyAmount(1_500_000_000n, 9), '1.5');
});
