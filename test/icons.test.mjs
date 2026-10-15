// The accounts' icons (src/shared/icons.js, built from scripts/account-icons/icons.txt): all the same size, typed
// characters only, every character painted in one of the palette's colours.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ASK, DEFAULT_ICON, ICON_IDS, ICONS, PALETTE, cleanIcon } from '../src/shared/icons.js';

const GLYPHS = JSON.parse(readFileSync(new URL('../scripts/account-icons/glyphs.json', import.meta.url), 'utf8'));
/** The middle of what an icon draws, in em from its box's top left, once its shift is applied. */
function inkMiddle({ art, shift }) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  art.forEach((line, r) => [...line].forEach((ch, c) => {
    if (ch === ' ') return;
    const [l, rt, t, b] = GLYPHS.glyphs[ch];
    x0 = Math.min(x0, c * GLYPHS.advance + l); x1 = Math.max(x1, c * GLYPHS.advance + rt);
    y0 = Math.min(y0, r + t); y1 = Math.max(y1, r + b);
  }));
  return [(x0 + x1) / 2 + shift[0], (y0 + y1) / 2 + shift[1]];
}

test('every icon is 15 x 9 typed characters, and every character has a colour from the palette', () => {
  assert.equal(ICON_IDS[0], DEFAULT_ICON, 'the default comes first in the picker');
  assert.equal(ICON_IDS.length, 40);
  for (const id of ICON_IDS) {
    const { art, paint } = ICONS[id];
    assert.equal(art.length, 9, `${id} has 9 lines`);
    assert.equal(paint.length, 9, `${id} has a colour line for each`);
    art.forEach((line, r) => {
      assert.equal(line.length, 15, `${id} line ${r + 1} is 15 wide`);
      assert.equal(paint[r].length, 15, `${id} colour line ${r + 1} is 15 wide`);
      assert.match(line, /^[ -~]+$/, `${id} line ${r + 1} is typed ASCII`);
      [...line].forEach((ch, c) => {
        if (ch === ' ') assert.equal(paint[r][c], ' ', `${id} ${r + 1},${c + 1}: a gap has no colour`);
        else assert.match(PALETTE[paint[r][c]] ?? '', /^#[0-9a-f]{6}$/, `${id} ${r + 1},${c + 1}: '${ch}' has a colour`);
      });
    });
    const inked = art.filter((l) => l.trim());
    const left = Math.min(...inked.map((l) => l.length - l.trimStart().length));
    const right = Math.min(...inked.map((l) => l.length - l.trimEnd().length));
    assert.ok(Math.abs(left - right) <= 1, `${id} is centred (${left} free on the left, ${right} on the right)`);
  }
});

test('what each icon draws sits in the middle of its square, and so does the question mark', () => {
  const middle = [(15 * GLYPHS.advance) / 2, 9 / 2];
  for (const [id, icon] of [...ICON_IDS.map((id) => [id, ICONS[id]]), ['the question mark', ASK]]) {
    assert.equal(icon.art.length, 9, `${id} has 9 lines`);
    assert.ok(icon.shift.every((v) => Math.abs(v) < 1), `${id} moves less than a character`);
    const [x, y] = inkMiddle(icon);
    assert.ok(Math.abs(x - middle[0]) < 0.002 && Math.abs(y - middle[1]) < 0.002, `${id}'s ink is centred (${x.toFixed(3)}, ${y.toFixed(3)})`);
  }
});

test('an account keeps only the id of one of the icons', () => {
  assert.equal(cleanIcon('frog'), 'frog');
  assert.equal(cleanIcon('donut'), 'donut');
  assert.equal(cleanIcon('fox'), null, 'a removed icon is dropped');
  assert.equal(cleanIcon('toString'), null);
  assert.equal(cleanIcon('<img src=x>'), null);
  assert.equal(cleanIcon(7), null);
});
