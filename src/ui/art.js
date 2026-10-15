// Text art: FIGlet titles (Big Money-nw and Small, via figlet.js), the plum logo drawn in characters, and progress
// bars.
import { figlet, parseFont } from './art/figlet.js';
import { MONEY, SMALL } from './art/fonts.js';
import { h } from './dom.js';

const FONTS = { money: MONEY, small: SMALL };
const parsed = {};
const font = (name) => (parsed[name] ??= parseFont(FONTS[name]));
const cache = new Map();

export function figletLines(text, name = 'money') {
  const key = `${name}|${text}`;
  let lines = cache.get(key);
  if (!lines) {
    lines = figlet(font(name), text);
    if (name === 'money') lines = lines.map((l) => l.replace(/\$/g, '#'));
    cache.set(key, lines);
  }
  return lines;
}

/** A title: <pre class="fig {tone}"> in a box that scales it down to the room it has. `fs` is the size it takes when
 * it fits ('1em': the same size as the text around it). */
export function fig(text, { font: name = 'money', tone = 'ink', cols, fs = null, className = '' } = {}) {
  const lines = figletLines(text, name);
  const pre = h('pre', { class: `fig ${tone} ${className}`.trim(), role: 'img', 'aria-label': text });
  lines.forEach((l, i) => {
    const row = h('span', { 'aria-hidden': 'true' });
    const runs = [];
    for (const c of l) {
      const k = c === '#' && name === 'money' ? 'f' : c === ' ' ? '' : 's';
      if (runs.length && runs[runs.length - 1][0] === k) runs[runs.length - 1][1] += c;
      else runs.push([k, c]);
    }
    for (const [k, t] of runs) row.append(k ? h('span', { class: k }, t) : t);
    if (i < lines.length - 1) row.append('\n');
    pre.append(row);
  });
  return h('span', { class: 'fig-box', vars: { '--cols': String(cols ?? Math.max(...lines.map((l) => l.length))), ...(fs ? { '--fs': fs } : {}) } }, pre);
}

/* ------------------------------------------------------------ the plum, typed */

/* the logo itself: the hollow plum, and the word sitting on its base (the chosen final, plum-logo-final.txt, with the
 * right plum redrawn as the left one's mirror). One letter per character says what it is: l leaf, s stem, f fruit, w word. */
const LOGO = [
  "                _.-.",
  "             .-'  /",
  "            ( .-'                ___",
  "            |'                  (   )",
  "          //|            .-..    | |   ___  ___   ___ .-. .-.",
  "        //  |           /    \\   | |  (   )(   ) (   )   '   \\",
  "   /---/\\   \\          ' .-,  ;  | |   | |  | |   |  .-.  .-. ;",
  "  / '    \\\\ /\\---\\     | |  . |  | |   | |  | |   | |  | |  | |",
  " |        |/ '    \\    | |  | |  | |   | |  | |   | |  | |  | |",
  " |        |        |   | |  | |  | |   | |  | |   | |  | |  | |",
  " \\\\      /|        |   | |  ' |  | |   | |  | |   | |  | |  | |",
  "   \\----/  \\      //   | `-'  '  | |   ' `--' '   | |  | |  | |",
  "            \\----/     | \\__.'  (___)   '.__.'   (___)(___)(___)",
  "                       | |",
  "                      (___)",
];
const LOGO_KINDS = [
  "                llll",
  "             lll  l",
  "            l lll                www",
  "            sl                  w   w",
  "          sss            wwww    w w   www  www   www www www",
  "        ss  s           w    w   w w  w   ww   w w   w   w   w",
  "   ffffff   s          w www  w  w w   w w  w w   w  www  www w",
  "  f f    ff ffffff     w w  w w  w w   w w  w w   w w  w w  w w",
  " f        ff f    f    w w  w w  w w   w w  w w   w w  w w  w w",
  " f        f        f   w w  w w  w w   w w  w w   w w  w w  w w",
  " ff      ff        f   w w  w w  w w   w w  w w   w w  w w  w w",
  "   ffffff  f      ff   w www  w  w w   w wwww w   w w  w w  w w",
  "            ffffff     w wwwww  wwwww   wwwwww   wwwwwwwwwwwwwww",
  "                       w w",
  "                      wwwww",
];
const KIND_CLASS = { l: 'lg-lf', s: 'lg-st', f: 'lg-rd', w: 'lg-wd' };
const PLUM_COLS = 21; // the plum alone: the columns left of the word
const PLUM_ROWS = 13;

/** One line of the logo as [class, text] runs, cut to `cols` columns. */
function logoRuns(r, cols = Infinity) {
  const text = LOGO[r].slice(0, cols), kinds = LOGO_KINDS[r].slice(0, cols);
  const out = [];
  let run = '', cls = null;
  const flush = () => { if (run) out.push([cls, run]); run = ''; };
  [...text].forEach((ch, c) => {
    const k = ch === ' ' ? null : KIND_CLASS[kinds[c]] ?? null;
    if (k !== cls) { flush(); cls = k; }
    run += ch;
  });
  flush();
  return out;
}

/** The whole logo (plum and word), or the plum alone. Size it with --logo-fs. */
export function logo({ word = true, size } = {}) {
  const pre = h('pre', { class: 'logo-art', 'aria-hidden': 'true', vars: size ? { '--logo-fs': size } : null });
  const rows = word ? LOGO.length : PLUM_ROWS;
  for (let r = 0; r < rows; r++) {
    pre.append(...logoRuns(r, word ? Infinity : PLUM_COLS).map(([cls, text]) => (cls ? h('span', { class: cls }, text) : text)));
    if (r < rows - 1) pre.append('\n');
  }
  return pre;
}

/* "ready", for the end of setup: typed in the same rounded letters as the logo's word (capped stems, '.-.' bowls), each
 * letter placed on the same line as the others: [column, first line, its lines]. Lines 2 to 10 are the letters' body
 * (the d's stem starts above it, the y's tail goes below). */
const READY = [
  [0, 2, [' ___ .-.', '(   )   \\', " |  ' .-. ;", ' |  / (___)', ' | |', ' | |', ' | |', ' | |', '(___)']],
  [12, 2, ['  .--.', ' /    \\', '|  .-. ;', '|  | | |', '|  |/  |', "|  ' _.'", "|  .'.-.", "'  `-' /", " `.__.'"]],
  [21, 2, ['  .---.', ' / .-, \\', '(__) ; |', "  .'`  |", " / .'| |", '| /  | |', '; |  ; |', "' `-'  |", "`.__.'_."]],
  [30, 0, ['     ___', '    (   )', '  .-.| |', ' /   \\ |', '|  .-. |', '| |  | |', '| |  | |', '| |  | |', "| '  | |", "' `-'  /", " `.__,'"]],
  [40, 2, [' ___  ___', '(   )(   )', ' | |  | |', ' | |  | |', ' | |  | |', ' | |  | |', " | '  | |", " '  `-' |", '  `.__. |', '  ___ | |', " (   )' |", "  ; `-' '", "   .__.'"]],
];

/** "ready" in the logo's letters, white like its word, at the text's size. */
export function readyArt() {
  const rows = Array.from({ length: 15 }, () => []);
  for (const [col, top, lines] of READY) lines.forEach((l, i) => { [...l].forEach((ch, k) => { if (ch !== ' ') rows[top + i][col + k] = ch; }); });
  const text = rows.map((r) => Array.from(r, (ch) => ch ?? ' ').join('').replace(/\s+$/, '')).join('\n');
  return h('pre', { class: 'logo-art ready-art', role: 'img', 'aria-label': 'ready' }, h('span', { class: 'lg-wd' }, text));
}

/** A typed bar: '#' done, ':' to go. */
export function bar(fraction, cols = 24) {
  const n = Math.max(0, Math.min(cols, Math.round(fraction * cols)));
  return h('span', { class: 'bar' }, h('span', { class: 'done' }, '#'.repeat(n)), h('span', { class: 'todo' }, ':'.repeat(cols - n)));
}
