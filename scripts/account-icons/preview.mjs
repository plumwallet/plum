// A preview sheet of the wallet icons (src/shared/icons.js, so run build.mjs first), each in its 15 x 9 box at the
// three sizes the wallet draws them (home, the picker, beside a name):
//   node scripts/account-icons/preview.mjs [out.png]    (default: shots/icons-all.png)
import { writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { ICON_IDS, ICONS, PALETTE } from '../../src/shared/icons.js';
const DIR = dirname(fileURLToPath(import.meta.url));
const [,, out = join(DIR, '..', '..', 'shots', 'icons-all.png')] = process.argv;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// the same runs of colour the wallet's iconArt makes
const draw = ({ art, paint }) => art.map((text, r) => {
  let html = '', run = '', colour = null;
  const flush = () => { if (run) html += colour ? `<span style="color:${PALETTE[colour]}">${esc(run)}</span>` : esc(run); run = ''; };
  for (let c = 0; c < text.length; c++) {
    const k = text[c] === ' ' ? colour : paint[r][c];
    if (k !== colour) { flush(); colour = k; }
    run += text[c];
  }
  flush();
  return html;
}).join('\n');
// each icon nudged by its shift, as the wallet draws it; the faint square is its 15 x 9 box
const pre = (id, px) => `<pre style="font-size:${px}px;translate:${ICONS[id].shift[0]}em ${ICONS[id].shift[1]}em">${draw(ICONS[id])}</pre>`;
const cell = (id) => `<div class="c"><div class="sq">${pre(id, 12.5)}</div>
  <div class="row">${pre(id, 4.6)}${pre(id, 2.4)}</div>
  <div class="n">${id}</div></div>`;
const font = pathToFileURL(join(DIR, '..', '..', 'src', 'ui', 'fonts', 'jetbrains-mono.woff2')).href;
const page = `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:M;src:url('${font}');font-weight:100 800}
body{margin:0;padding:16px;background:#110d17;width:1048px;display:grid;grid-template-columns:repeat(5,1fr);gap:18px;font-family:M}
pre{margin:0;font-family:M;font-weight:700;line-height:1;white-space:pre;color:#fff;justify-self:start}.c{display:grid;gap:8px;align-content:start}
.row{display:flex;gap:14px;align-items:center}.n{color:#6b6b6b;font:11px sans-serif}
.sq{justify-self:start;display:grid;place-items:center;width:calc(9 * 12.5px + 24px);height:calc(9 * 12.5px + 24px);outline:1px dashed #3a3a3a}.sq pre{justify-self:center}</style><body>${ICON_IDS.map(cell).join('')}</body>`;
const html = out.replace(/\.png$/, '.html');
writeFileSync(html, page);
const browser = await puppeteer.launch({ executablePath: `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`, headless: true, defaultViewport: { width: 1080, height: 900, deviceScaleFactor: 1 }, args: ['--allow-file-access-from-files'] });
try {
  try { setPriority(browser.process().pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(() => {
    const raf = window.requestAnimationFrame.bind(window), step = 1000 / 60;
    let next = 0;
    window.requestAnimationFrame = (cb) => raf(function tick(t) { if (t < next - 2) return raf(tick); next = Math.max(next + step, t); cb(t); });
  });
  await p.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: h } });
} finally { await browser.close(); }
console.log(`${ICON_IDS.length} icons -> ${out}`);
