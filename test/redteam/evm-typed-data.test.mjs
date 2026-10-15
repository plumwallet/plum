// Attack: an Ethereum site asks for a signature on typed data (EIP-712) or a message (personal_sign).
// The rule plum sets itself: what you sign is what you see, and anything it can't show you is a danger. Can a site make
// the window show one thing while the signature covers another?
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashTypedData, recoverMessageAddress, recoverTypedDataAddress } from 'viem';
import { fakeNet } from '../fake-net.mjs';
import { boot } from './helpers.mjs';

const ETH_ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const CONTRACT = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const MAX = (1n << 256n) - 1n;
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const DOMAIN = { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: CONTRACT };

const ctx = await boot();
const net = fakeNet();
globalThis.fetch = net.fetch;
const { fake, ok, _test } = ctx;
let evm;

/** Ask for typed data; returns { answer, v } once it's in the window. */
async function askTyped(td, method = 'eth_signTypedData_v4') {
  let settled = false;
  const answer = evm(method, [ETH_ME, typeof td === 'string' ? td : JSON.stringify(td)]).then((r) => { settled = true; return r; });
  const until = Date.now() + 1000;
  while (!_test.pending.size && !settled && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  if (!_test.pending.size) return { answer, v: null, refused: (await answer).error };
  return { answer, v: await ok('approval.get') };
}
const dangers = (v) => v.typed.warnings.filter((w) => w.level === 'danger');
const approvePlain = (id) => fake.ui('approval.resolve', { id, approve: true });
const cleanUp = async (answer) => { await ctx.rejectAll(); await answer; };

test('setup: a wallet and a connected Ethereum site', async () => {
  await ctx.setup();
  const page = fake.page('https://typed.example/');
  evm = (method, params) => page.request('evm', { method, params });
  const answer = evm('eth_requestAccounts');
  const v = await ctx.nextApproval();
  await ok('approval.resolve', { id: v.id, approve: true });
  assert.deepEqual((await answer).result, [ETH_ME]);
});

/** Typed data whose real fields sit `levels` structs below a harmless-looking top line. */
function nested(levels) {
  const types = { EIP712Domain: DOMAIN_TYPE, Claim: [{ name: 'note', type: 'string' }, { name: 'l1', type: 'L1' }] };
  for (let i = 1; i < levels; i++) types[`L${i}`] = [{ name: `l${i + 1}`, type: `L${i + 1}` }];
  types[`L${levels}`] = [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }];
  let inner = { spender: ATTACKER, amount: MAX.toString() };
  for (let i = levels; i >= 2; i--) inner = { [`l${i}`]: inner };
  return { types, primaryType: 'Claim', domain: DOMAIN, message: { note: 'claim your free tokens', l1: inner } };
}

// FINDING (low: it breaks the rule, but the target contract's own types decide the nesting, and few nest this deep):
// typedLines stops walking at depth 16 *silently* (`if (depth > 16) return;` counts nothing in `more`), while the digest
// encodes one level deeper (encodeValue's limit is reached one level later, because the walk starts its count at the
// top struct and hashStruct at its fields). Fields 16 structs down are signed, never shown, and raise no "more fields
// than plum can show" danger. Here the window shows one line ("claim your free tokens") and the signature also covers
// spender = attacker, amount = max.
test('FINDING (low): fields nested 16 structs deep are signed but never shown, with no danger', async () => {
  const control = nested(15);
  const c = await askTyped(control);
  assert.ok(c.v.typed.lines.some((l) => l.path.endsWith('.spender')), 'at 15 levels the fields are shown');
  await cleanUp(c.answer);

  const td = nested(16);
  const { answer, v } = await askTyped(td);
  try {
    const shown = v.typed.lines.map((l) => `${l.path}=${l.value}`);
    const seen = shown.some((l) => l.includes(ATTACKER)) || dangers(v).length > 0;
    if (!seen) {
      // the proof: approved with no "i understand", and the signature covers the fields that weren't shown
      const r = await approvePlain(v.id);
      assert.equal(r.ok, true, r.error);
      const sig = (await answer).result;
      assert.equal(await recoverTypedDataAddress({ ...td, signature: sig }), ETH_ME, 'the signature is valid for the full data, hidden fields included');
    }
    assert.ok(seen, `the window showed ${JSON.stringify(shown)} (${dangers(v).length} dangers) and the signature gives ${ATTACKER} an amount of 2^256-1`);
  } finally { await cleanUp(answer); }
});

// FINDING (low): with primaryType "EIP712Domain" the digest is the domain separator alone (as eth-sig-util does), but
// the window's "the message" box lists the *message* object, which isn't signed at all.
test('FINDING (low): primaryType EIP712Domain: the message box shows values that are not what is signed', async () => {
  const td = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] },
    primaryType: 'EIP712Domain',
    domain: { name: 'Seaport', chainId: 1, verifyingContract: SEAPORT },
    message: { name: 'Plum login', chainId: 1, verifyingContract: CONTRACT },
  };
  const { answer, v } = await askTyped(td);
  try {
    await ok('approval.resolve', { id: v.id, approve: true });
    const sig = (await answer).result;
    assert.equal(await recoverTypedDataAddress({ ...td, signature: sig }), ETH_ME);
    const lines = Object.fromEntries(v.typed.lines.map((l) => [l.path, l.value]));
    assert.deepEqual(lines, { name: 'Seaport', chainId: '1', verifyingContract: SEAPORT }, 'the lines shown should be the domain that is signed');
  } finally { await cleanUp(answer); }
});

// FINDING (low): the window's "chain id" and "contract" come from the domain object, not from the EIP712Domain type that
// is hashed. Leave chainId out of the type and the window still says "chain id 1", with no warning, while the signature
// is good on every chain (and the "another chain" check never fires).
test('FINDING (low): "chain id 1" is shown for a signature that is not bound to any chain', async () => {
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'verifyingContract', type: 'address' }], Ballot: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] };
  const td = { types, primaryType: 'Ballot', domain: { name: 'Exchange', chainId: 1, verifyingContract: CONTRACT }, message: { to: CONTRACT, amount: '5' } };
  const { answer, v } = await askTyped(td);
  try {
    await ok('approval.resolve', { id: v.id, approve: true, ignoreRisk: true });
    const sig = (await answer).result;
    const onBsc = { ...td, domain: { ...td.domain, chainId: 56 } };
    assert.equal(await recoverTypedDataAddress({ ...onBsc, signature: sig }), ETH_ME, 'the same signature verifies for chain 56');
    assert.ok(v.typed.domain.chainId == null || v.typed.warnings.some((w) => /chain/i.test(w.text)),
      `the window says chain id ${v.typed.domain.chainId} with warnings ${JSON.stringify(v.typed.warnings)}`);
  } finally { await cleanUp(answer); }
});

// FINDING (low): a text value is cut to 120 characters (and stripped of hidden characters) for display, silently: no
// "…", no warning. The rest of the text is signed unseen. (personal_sign shows such text as unreadable and asks for
// "i understand"; typed data doesn't.)
test('FINDING (low): typed-data text longer than 120 characters is cut silently', async () => {
  const contents = `Hello, Bob! This is just a friendly note to say hi, nothing to see here, have a great day and enjoy the weather.${' '.repeat(10)}I also authorise 0xdEaD to withdraw everything I hold.`;
  const td = { types: { EIP712Domain: DOMAIN_TYPE, Mail: [{ name: 'contents', type: 'string' }] }, primaryType: 'Mail', domain: DOMAIN, message: { contents } };
  const { answer, v } = await askTyped(td);
  try {
    const shown = v.typed.lines[0].value;
    assert.ok(shown.includes('authorise') || dangers(v).length > 0, `shown: "${shown}" (${[...shown].length} characters of ${contents.length}), warnings ${JSON.stringify(v.typed.warnings)}`);
  } finally { await cleanUp(answer); }
});

// FINDING (low): bytes that aren't text (here a 32-byte hash: exactly what a Gnosis Safe owner signs to approve a Safe
// transaction with an "eth_sign"-type signature) need "i understand" only in the window's own code. The background
// signs them for approval.resolve without ignoreRisk, unlike typed-data and transaction dangers, which it enforces.
test('FINDING (low): a non-text personal_sign is approved by the background without "i understand"', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const answer = evm('personal_sign', [hash, ETH_ME]);
  const v = await ctx.nextApproval();
  try {
    assert.equal(v.message.text, null, 'the window treats it as unreadable');
    const r = await approvePlain(v.id);
    assert.equal(r.ok, false, r.ok ? `signed without "i understand": ${(await answer).result}` : '');
  } finally { await cleanUp(answer); }
});

// FINDING (medium): Sign-In with Ethereum (EIP-4361) arrives as plain personal_sign text and plum never reads it, so a
// phishing site can relay another site's sign-in challenge and get a signature that logs it in there as you. Plum's
// Solana side flags exactly this ("Sign In With Solana requests for a different domain than the site asking are
// flagged", and needs "i understand"); here the window shows the text with no warning and the background signs it.
test('FINDING (medium): a sign-in message for another site (EIP-4361) is signed with no warning', async () => {
  const siwe = [
    'app.uniswap.org wants you to sign in with your Ethereum account:', ETH_ME, '', 'Sign in to Uniswap', '',
    'URI: https://app.uniswap.org', 'Version: 1', 'Chain ID: 1', 'Nonce: 32891756', 'Issued At: 2026-10-15T09:00:00Z',
  ].join('\n');
  const answer = evm('personal_sign', [`0x${Buffer.from(siwe).toString('hex')}`, ETH_ME]);
  const v = await ctx.nextApproval();
  try {
    assert.equal(v.host, 'typed.example');
    assert.equal(v.message.text, siwe);
    const r = await approvePlain(v.id);
    assert.equal(r.ok, false, r.ok ? `typed.example got a signature that signs you in to app.uniswap.org: ${(await answer).result}` : '');
  } finally { await cleanUp(answer); }
});

/* ------------------------------------------------------------ what plum withstood */

const MAIL = {
  types: { EIP712Domain: DOMAIN_TYPE, Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }], Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }] },
  primaryType: 'Mail',
  domain: DOMAIN,
  message: { from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' }, to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }, contents: 'Hello, Bob!' },
};

test('withstood: for ordinary data every signed field is shown, in order, with its own value, and the digest is viem\'s', async () => {
  const { answer, v } = await askTyped(MAIL);
  try {
    assert.deepEqual(v.typed.lines, [
      { path: 'from.name', value: 'Cow' }, { path: 'from.wallet', value: MAIL.message.from.wallet },
      { path: 'to.name', value: 'Bob' }, { path: 'to.wallet', value: MAIL.message.to.wallet }, { path: 'contents', value: 'Hello, Bob!' },
    ]);
    await ok('approval.resolve', { id: v.id, approve: true });
    const sig = (await answer).result;
    assert.equal(await recoverTypedDataAddress({ ...MAIL, signature: sig }), ETH_ME);
    assert.ok(hashTypedData(MAIL));
  } finally { await cleanUp(answer); }
});

test('withstood: values that would be signed as something other than what is shown are refused before you see them', async () => {
  const bad = [
    ['an object as text', { contents: { toString: 'x' } }, 'string'],
    ['a list as text', { contents: ['a', 'b'] }, 'string'],
    ['a number as bytes', { contents: 256 }, 'bytes'],
    ['a number as bytes32', { contents: 7 }, 'bytes32'],
    ['31 bytes as bytes32', { contents: `0x${'11'.repeat(31)}` }, 'bytes32'],
    ['a word as bool', { contents: 'yes' }, 'bool'],
    ['a negative uint', { contents: '-1' }, 'uint256'],
    ['an unsafe JS number', { contents: 2 ** 60 }, 'uint256'],
    ['a fraction', { contents: '1.5' }, 'uint256'],
    ['uint8 overflow', { contents: 256 }, 'uint8'],
    ['an address without 0x', { contents: CONTRACT.slice(2) }, 'address'],
    ['an inherited name as a type', { contents: 'x' }, 'constructor'],
  ];
  for (const [label, message, type] of bad) {
    const td = { types: { EIP712Domain: DOMAIN_TYPE, Mail: [{ name: 'contents', type }] }, primaryType: 'Mail', domain: DOMAIN, message };
    const { answer, v, refused } = await askTyped(td);
    if (v) await cleanUp(answer);
    assert.ok(!v && refused, `${label}: reached the window`);
  }
  // a type or primaryType named after an inherited property is just unknown
  for (const td of [{ ...MAIL, primaryType: 'toString' }, { ...MAIL, primaryType: '__proto__' }, { ...MAIL, primaryType: 'hasOwnProperty' }]) {
    const { answer, v, refused } = await askTyped(td);
    if (v) await cleanUp(answer);
    assert.ok(!v && refused, td.primaryType);
  }
});

test('withstood: more fields than the window can list, a hidden character in the name, permits, Permit2 and another chain are dangers the background enforces', async () => {
  const many = { types: { EIP712Domain: DOMAIN_TYPE, Big: [{ name: 'xs', type: 'uint256[]' }] }, primaryType: 'Big', domain: DOMAIN, message: { xs: Array.from({ length: 301 }, (_, i) => String(i)) } };
  const hidden = { ...MAIL, domain: { ...DOMAIN, name: 'Uniswap​' } };
  const permit2 = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }], PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }] },
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
    message: { details: { token: CONTRACT, amount: ((1n << 160n) - 1n).toString(), expiration: '281474976710655', nonce: '0' }, spender: ATTACKER, sigDeadline: '9999999999' },
  };
  const bsc = { ...MAIL, domain: { ...DOMAIN, chainId: '0x38' } };
  for (const [label, td] of [['301 fields', many], ['hidden name', hidden], ['Permit2', permit2], ['chain 0x38', bsc]]) {
    const { answer, v } = await askTyped(td);
    try {
      assert.ok(dangers(v).length, `${label}: no danger`);
      const r = await approvePlain(v.id);
      assert.equal(r.ok, false, `${label}: signed without "i understand"`);
    } finally { await cleanUp(answer); }
  }
});

test('withstood: personal_sign shows exactly the bytes it signs (hex is bytes, anything else is text), for the connected address only', async () => {
  for (const [m, text] of [['0x48656c6c6f', 'Hello'], ['Hello', 'Hello'], ['0xabc', '0xabc']]) {
    const answer = evm('personal_sign', [m, ETH_ME]);
    const v = await ctx.nextApproval();
    assert.equal(v.message.text, text, m);
    await ok('approval.resolve', { id: v.id, approve: true });
    const raw = /^0x([0-9a-f]{2})*$/i.test(m) ? { raw: m } : m;
    assert.equal(await recoverMessageAddress({ message: raw, signature: (await answer).result }), ETH_ME, m);
  }
  for (const params of [['hi', ATTACKER], [ATTACKER, 'hi'], ['0x', ETH_ME], [{ a: 1 }, ETH_ME]]) {
    const r = await evm('personal_sign', params);
    assert.ok(r.error, JSON.stringify(params));
  }
  const tooBig = await evm('personal_sign', [`0x${'61'.repeat(16 * 1024 + 1)}`, ETH_ME]);
  assert.match(tooBig.error.message, /16 KB/);
  for (const params of [[ATTACKER, JSON.stringify(MAIL)], [JSON.stringify(MAIL), ATTACKER]]) {
    const r = await evm('eth_signTypedData_v4', params);
    assert.match(r.error.message, /isn't the one connected/);
  }
  assert.equal(_test.pending.size, 0);
});
