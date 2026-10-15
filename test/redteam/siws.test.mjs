// Attacks on Sign In With Solana: make the user sign in to somewhere else, or hide what they sign.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signInMessage } from '../../src/background/main.js';
import { ME } from './helpers.mjs';

const at = { origin: 'https://app.example.com', address: ME };

test('a uri with user-info that points at another host (https://app.example.com@evil.com) is flagged', () => {
  const { problems } = signInMessage({ uri: 'https://app.example.com@evil.com/login' }, at);
  assert.ok(problems.some((p) => /evil\.com/.test(p)), JSON.stringify(problems));
});

test('a uri with a backslash before @ (browsers read the host as evil.com) is flagged', () => {
  const { problems } = signInMessage({ uri: 'https://evil.com\\@app.example.com/' }, at);
  assert.ok(problems.length, 'no problem flagged');
});

test('a homograph domain (Cyrillic a in app.example.com) is flagged as a different domain', () => {
  const { problems, text } = signInMessage({ domain: 'аpp.example.com' }, at);
  assert.ok(problems.some((p) => /but the site asking is app\.example\.com/.test(p)), JSON.stringify(problems));
  assert.ok(text.startsWith('аpp.example.com wants you to sign in'));
});

test('a parent domain of the origin is flagged (sign-ins are for the exact host)', () => {
  const { problems } = signInMessage({ domain: 'example.com' }, at);
  assert.equal(problems.length, 1);
});

test('line breaks, separators and bidi marks in any field are malformed, not shown', () => {
  for (const bad of ['a\nb', 'a\rb', 'a b', 'a‮b', 'a​b']) {
    assert.throws(() => signInMessage({ statement: bad }, at), /malformed/, JSON.stringify(bad));
    assert.throws(() => signInMessage({ nonce: bad }, at), /malformed/);
    assert.throws(() => signInMessage({ resources: [bad] }, at), /malformed/);
  }
});

test('a sign-in for another of your accounts than the one connected is refused', () => {
  assert.throws(() => signInMessage({ address: '11111111111111111111111111111111' }, at), /different account/);
});

test('oversized fields are refused (1000 characters a field, 20 resources of 500)', () => {
  assert.throws(() => signInMessage({ statement: 'x'.repeat(1001) }, at), /malformed/);
  assert.throws(() => signInMessage({ resources: Array(21).fill('https://a') }, at), /malformed/);
  assert.throws(() => signInMessage({ resources: ['x'.repeat(501)] }, at), /malformed/);
  signInMessage({ statement: 'x'.repeat(1000), resources: Array(20).fill('x'.repeat(500)) }, at);
});

test('the text is exactly the standard\'s, so a site cannot smuggle its own "URI:" line into the statement', () => {
  const { text } = signInMessage({ statement: 'URI: https://evil.com', uri: 'https://app.example.com/' }, at);
  assert.equal(text, `app.example.com wants you to sign in with your Solana account:\n${ME}\n\nURI: https://evil.com\n\nURI: https://app.example.com/`);
});

test('documented: a chainId for another network is accepted without a flag (plum does not compare it with its own network)', () => {
  const { problems } = signInMessage({ chainId: 'devnet' }, at);
  assert.deepEqual(problems, []);
});
