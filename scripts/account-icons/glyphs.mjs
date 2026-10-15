// Where each typed character's ink sits in its cell: JetBrains Mono bold at line-height 1, the way the icons are set.
// build.mjs adds these up into each icon's drawn outline and shifts the icon so that outline, not its 15 x 9 box of
// characters, sits in the middle (an underscore inks only the foot of its line, so a row of them on top looks empty).
// Run it again only if the font changes:
//   node scripts/account-icons/glyphs.mjs     (writes scripts/account-icons/glyphs.json; headless Chromium, closed after)
import { writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const DIR = dirname(fileURLToPath(import.meta.url));
const FONT = pathToFileURL(join(DIR, '..', '..', 'src', 'ui', 'fonts', 'jetbrains-mono.woff2')).href;
const SIZE = 200;

const page = `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:M;src:url('${FONT}');font-weight:100 800}
body{margin:0;background:#000}pre{margin:0;width:max-content;font:700 ${SIZE}px/1 M;color:#fff;white-space:pre}
i{display:inline-block;width:0;height:0;vertical-align:baseline}</style><body><pre id="p">#<i id="b"></i></pre></body>`;
const html = join(DIR, 'glyphs.html');
writeFileSync(html, page);

const browser = await puppeteer.launch({ executablePath: `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`, headless: true, defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, args: ['--allow-file-access-from-files'] });
let out;
try {
  try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(() => {
    const raf = window.requestAnimationFrame.bind(window), step = 1000 / 60;
    let next = 0;
    window.requestAnimationFrame = (cb) => raf(function tick(t) { if (t < next - 2) return raf(tick); next = Math.max(next + step, t); cb(t); });
  });
  await p.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  out = await p.evaluate(async (size) => {
    await document.fonts.load(`700 ${size}px M`);
    await document.fonts.ready;
    // the baseline's place in a line set at line-height 1 (a zero-height box sitting on it), and the width of one cell
    const pre = document.getElementById('p');
    const baseline = document.getElementById('b').getBoundingClientRect().top - pre.getBoundingClientRect().top;
    pre.textContent = '#'.repeat(100);
    const advance = pre.getBoundingClientRect().width / 100;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `700 ${size}px M`;
    const r = (v) => Math.round((v / size) * 10000) / 10000;
    const glyphs = {};
    for (let code = 33; code <= 126; code++) {
      const ch = String.fromCharCode(code);
      const m = ctx.measureText(ch);
      // left, right, top, bottom of the ink, in em, from the cell's top left corner
      glyphs[ch] = [r(-m.actualBoundingBoxLeft), r(m.actualBoundingBoxRight), r(baseline - m.actualBoundingBoxAscent), r(baseline + m.actualBoundingBoxDescent)];
    }
    return { advance: r(advance), baseline: r(baseline), glyphs };
  }, SIZE);
} finally { await browser.close(); }

writeFileSync(join(DIR, 'glyphs.json'), `${JSON.stringify({ font: 'JetBrains Mono 700, line-height 1', advance: out.advance, baseline: out.baseline, glyphs: out.glyphs }, null, 1)}\n`);
console.log(`advance ${out.advance}em, baseline ${out.baseline}em, ${Object.keys(out.glyphs).length} glyphs -> glyphs.json`);
