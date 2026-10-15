// Attack: text a site asks you to sign (or a token's name) carries characters that render as nothing, so what you read
// is not what you sign. text.js lists BMP ranges only; several invisible characters are outside them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { _test } from '../../src/background/main.js';
import { utf8 } from '../../src/shared/bytes.js';
import { cleanLine, hasHidden } from '../../src/shared/text.js';

test('TAG characters (U+E0000-E007F, invisible, used for hidden-text injection) are caught', () => {
  assert.ok(hasHidden('approve 1\u{E0030}\u{E0030}\u{E0030} USDC'), 'U+E0030 (TAG DIGIT ZERO) is invisible');
  assert.ok(hasHidden('x\u{E0001}y'), 'U+E0001 LANGUAGE TAG');
  assert.ok(hasHidden('x\u{E007F}y'), 'U+E007F CANCEL TAG');
});

test('variation selectors supplement (U+E0100-E01EF, invisible) are caught', () => {
  assert.ok(hasHidden('a\u{E0100}b'));
  assert.ok(hasHidden('a\u{E01EF}b'));
});

test('musical symbol format characters (U+1D173-1D17A, invisible) are caught', () => {
  assert.ok(hasHidden('a\u{1D173}b'));
  assert.ok(hasHidden('a\u{1D17A}b'));
});

test('combining grapheme joiner U+034F (invisible) is caught', () => {
  assert.ok(hasHidden('pump͏.fun'));
});

test('Mongolian free variation selectors U+180B-180D (invisible) are caught', () => {
  assert.ok(hasHidden('a᠋b'));
  assert.ok(hasHidden('a᠍b'));
});

test('interlinear annotation characters U+FFF9-FFFB (hide the annotated text in browsers) are caught', () => {
  assert.ok(hasHidden('send 1￹000￺￻ SOL'));
});

test('end to end: a message laced with TAG characters must not be shown as readable text', () => {
  const view = _test.messageView(utf8('Sign in to app.example.com\u{E0041}\u{E0042}\u{E0043}\nnonce: 1234'));
  assert.equal(view.text, null, 'shown as plain text, with the hidden characters silently dropped on screen');
});

test('token names are cleaned of TAG characters too (a fake "USDC" with invisible padding)', () => {
  assert.equal(cleanLine('USDC\u{E0041}\u{E0042}'), 'USDC');
  assert.equal(cleanLine('US\u{E0100}DC'), 'USDC');
});

test('the characters plum does list are still caught (regression)', () => {
  for (const c of ['​', '‎', '‮', '⁦', '﻿', '­', '؜', '᠎', 'ㅤ', '️', '\u0007', '\u009f']) assert.ok(hasHidden(`a${c}b`), `U+${c.codePointAt(0).toString(16)}`);
  assert.equal(hasHidden('plain text, with\ttabs\nand lines'), false);
});

test('functional: a message with Windows line endings (CRLF) is ordinary text and should read as text, not hex', () => {
  const view = _test.messageView(utf8('Sign in to app.example.com\r\nnonce: 1234'));
  assert.notEqual(view.text, null, 'CR is treated as a hidden character, so every CRLF message shows as hex with a scary warning');
});
