// The accounts' icons: writes src/shared/icons.js from icons.txt (its head explains the format), and the icon square's
// question mark from ask.txt. Every icon is centred in the same 15 x 9 box; one that's bigger, has a character with no
// colour, or shows anything but typed ASCII is refused. Each also gets a shift: how far to move it so what's actually
// drawn (each character's ink, from glyphs.json) sits in the middle of its box, not just its characters. A row of
// underscores on top inks only the foot of its line, so without it those icons sat low and the others high.
//   node scripts/account-icons/build.mjs        (then: node scripts/account-icons/preview.mjs to look at them)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = dirname(fileURLToPath(import.meta.url));
const [,, file = join(DIR, 'icons.txt'), out = join(DIR, '..', '..', 'src', 'shared', 'icons.js')] = process.argv;
const W = 15, H = 9, DEFAULT = 'plum';
const GLYPHS = JSON.parse(readFileSync(join(DIR, 'glyphs.json'), 'utf8'));

const text = readFileSync(file, 'utf8').replace(/\r/g, '');
const [head, ...blocks] = text.split(/^== /m);
const palette = {};
for (const m of head.matchAll(/^:: (\S) (#[0-9a-f]{6})\b/gm)) palette[m[1]] = m[2];
const fail = (msg) => { throw new Error(`icons.txt: ${msg}`); };

/** Drops the indent every line shares and centres what's left in the 15 x 9 box (rows: [lines, and lines kept in step]). */
function boxed(id, art, ...more) {
  const indent = Math.min(...art.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const cut = (rows) => rows.map((l) => l.slice(indent));
  const w = Math.max(...cut(art).map((l) => l.length)), h = art.length;
  if (w > W || h > H) fail(`${id} is ${w} x ${h}, bigger than ${W} x ${H}`);
  const left = Math.floor((W - w) / 2), top = Math.floor((H - h) / 2);
  const box = (rows) => Array.from({ length: H }, (_, r) => (' '.repeat(left) + (cut(rows)[r - top] ?? '')).padEnd(W));
  return [box(art), ...more.map(box)];
}

/** [right, down] in em: moves the box so the outline of its ink sits in the middle of the box. */
function shiftOf(id, art) {
  const A = GLYPHS.advance;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  art.forEach((line, r) => [...line].forEach((ch, c) => {
    if (ch === ' ') return;
    const g = GLYPHS.glyphs[ch];
    if (!g) fail(`${id}: no measure for '${ch}' (run glyphs.mjs)`);
    x0 = Math.min(x0, c * A + g[0]); x1 = Math.max(x1, c * A + g[1]);
    y0 = Math.min(y0, r + g[2]); y1 = Math.max(y1, r + g[3]);
  }));
  const round = (v) => Math.round(v * 1000) / 1000 || 0;
  return [round((W * A) / 2 - (x0 + x1) / 2), round(H / 2 - (y0 + y1) / 2)];
}

const items = blocks.map((block) => {
  const [title, ...lines] = block.replace(/\n+$/, '').split('\n');
  const id = title.trim();
  if (!/^[a-z0-9]+$/.test(id)) fail(`"${id}" isn't a plain lowercase id`);
  // the legend comes first; the first line that isn't one starts the art
  const legend = new Map();
  let fallback = null, i = 0;
  for (; i < lines.length; i++) {
    const m = /^: (\S)(?: (\S))? (\S)$/.exec(lines[i]);
    if (!m) break;
    if (m[1] === '*' && !m[2]) fallback = m[3];
    else legend.set(m[1], { ch: m[2] ?? m[1], c: m[3] });
  }
  const src = lines.slice(i).map((l) => l.replace(/\s+$/, ''));
  while (src.length && !src[0]) src.shift();
  const art = [], paint = [];
  src.forEach((line, r) => {
    let a = '', p = '';
    [...line].forEach((ch, c) => {
      if (ch === ' ') { a += ' '; p += ' '; return; }
      const { ch: shown, c: colour } = legend.get(ch) ?? { ch, c: fallback };
      if (!colour) fail(`${id}: '${ch}' at line ${r + 1}, column ${c + 1} has no colour`);
      if (!palette[colour]) fail(`${id}: colour '${colour}' isn't in the palette`);
      if (!/^[!-~]$/.test(shown)) fail(`${id}: '${shown}' isn't a typed character`);
      a += shown; p += colour;
    });
    art.push(a); paint.push(p);
  });
  // centre what's drawn in the box, so every icon draws the same size, then centre its ink
  const [shown, painted] = boxed(id, art, paint);
  return { id, art: shown, paint: painted, shift: shiftOf(id, shown) };
});
const ids = items.map((it) => it.id);
const twice = ids.find((id, k) => ids.indexOf(id) !== k);
if (twice) fail(`"${twice}" is drawn twice`);
if (ids[0] !== DEFAULT) fail(`the first icon must be ${DEFAULT}, the default`);

// the icon square's question mark: drawn like an icon, coloured by the page (its # fill and its strokes apart)
const askSrc = readFileSync(join(DIR, 'ask.txt'), 'utf8').replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((l) => l.replace(/\s+$/, ''));
for (const l of askSrc) if (!/^[ -~]*$/.test(l)) fail(`ask.txt: '${l}' isn't typed ASCII`);
const [askArt] = boxed('ask', askSrc);
const ask = { art: askArt, shift: shiftOf('ask', askArt) };

// only the colours some icon uses
const used = new Set(items.flatMap((it) => [...it.paint.join('')].filter((c) => c !== ' ')));
const colours = Object.entries(palette).filter(([k]) => used.has(k)).map(([k, v]) => `${k}: '${v}'`);
const lines = (rows) => rows.map((l) => `      ${JSON.stringify(l)},`).join('\n');
const body = items.map((it) => `  ${it.id}: {\n    art: [\n${lines(it.art)}\n    ],\n    paint: [\n${lines(it.paint)}\n    ],\n    shift: [${it.shift.join(', ')}],\n  },`).join('\n');
const src = `// The icons an account can wear, the way Phantom lets you give an account an emoji: emoji redrawn in typed characters
// and painted in their own colours. An account keeps only an id from this list (anything else is dropped); the art is
// drawn from here: big on home, small in the picker and beside the account's name. Every icon fills the same
// ${W} x ${H} box, so they all draw the same size.
// Made by scripts/account-icons/build.mjs from scripts/account-icons/icons.txt: edit that, not this.

/** The colours the icons are painted in, by letter. */
export const PALETTE = { ${colours.join(', ')} };

/**
 * Each icon: ${H} lines of ${W} characters, for every character the letter of its colour (a space where there's none), and
 * its shift: [right, down] in em, which puts the middle of what's drawn (the characters' ink) in the middle of the box.
 */
export const ICONS = {
${body}
};
export const ICON_IDS = Object.keys(ICONS);
export const DEFAULT_ICON = '${DEFAULT}';

/** The icon square's question mark, shown until an icon is picked: the same ${W} x ${H} box and shift as an icon. */
export const ASK = {
  art: [
${ask.art.map((l) => `    ${JSON.stringify(l)},`).join('\n')}
  ],
  shift: [${ask.shift.join(', ')}],
};

/** The icon's id if it's one of plum's, otherwise none. */
export const cleanIcon = (v) => (typeof v === 'string' && Object.hasOwn(ICONS, v) ? v : null);
`;
writeFileSync(out, src);
console.log(`${items.length} icons, ${colours.length} colours -> ${out}`);
