// The toolbar and add-on icons (src/icons/16, 32, 48, 128.png): the filled plum, drawn in characters.
// - 48 and 128 (the add-ons page, sites' wallet lists): the logo's 13 lines of text in JetBrains Mono
//   and the logo's own colours (base.css), drawn large one character at a time (no ligatures) in headless Chrome,
//   cropped to fill the square, with the leaf and stem lines packed closer than the plums' so the fruit takes most of
//   it, then shrunk by area averaging.
// - 16 and 32 (the toolbar): a typed character can't survive at 16 pixels, and shrinking the drawing leaves a soft blur,
//   so there the same plum is set pixel by pixel (PIXEL16, every pixel doubled at 32): sharp, in the same colours.
//   node scripts/icons.mjs [--chrome "C:\path\to\chrome.exe"] [--out dir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const CHROME = arg('--chrome') ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const OUT = arg('--out') ?? join(ROOT, 'src', 'icons');

// the typed sizes: the plums' line spacing (rows 6 to 12), the leaf and stem's above them, and how much every stroke is
// thickened, all in ems
const LH_BODY = 1.05, BODY_FROM = 6;
const TYPED = { 48: { top: 0.6, stroke: 0.16 }, 128: { top: 0.6, stroke: 0 } };

// the toolbar's plum, pixel by pixel: o outline, f fruit, d its shaded right side, h the shine, s stem, l leaf
const PIXEL16 = [
  '............lll.',
  '..........llllll',
  '.........slll...',
  '........s.s.....',
  '.......s...s....',
  '..ooooo....s....',
  '.ohffffo..oooo..',
  'offfffffooffffo.',
  'offfffdfofffffdo',
  'offfffdfofffffdo',
  'offfffdfofffffdo',
  'offfffdfofffffdo',
  '.offffdoofffffdo',
  '..ooooo.offfffdo',
  '.........offffo.',
  '..........oooo..',
];
const PIXEL = { 16: 1, 32: 2 };
const INK = { o: 'lg-rd', f: 'lg-fr', d: 'lg-sh', h: 'lg-wd', s: 'lg-st', l: 'lg-lf' };

// the plum logo, as lines of text
const FRUIT = [
  '               _.-.',
  "            .-'##/",
  "           (#.-'",
  '           |`',
  '         //|',
  '       //   \\',
  '  /---/\\     |',
  " /#'####\\\\ //|--\\",
  "|#######@|//'####\\\\",
  '|#######@|#######@|',
  '\\\\#####@/ |######@|',
  '  \\----/  \\\\\\##@///',
  '             ----',
];
const STEM = new Set(['3,11', '4,9', '4,10', '4,11', '5,7', '5,8', '5,12', '6,6', '6,13', '7,13']);
const LEAF = (r, c) => r <= 2 || (r === 3 && c === 12);
const kind = (r, c, ch) => (ch === ' ' ? null : LEAF(r, c) ? 'lg-lf' : STEM.has(`${r},${c}`) ? 'lg-st' : ch === '#' ? 'lg-fr' : ch === '@' ? 'lg-sh' : 'lg-rd');
const cells = FRUIT.flatMap((line, r) => [...line].map((ch, c) => ({ r, c, ch, k: kind(r, c, ch) })).filter((x) => x.k));
// the logo's own colours, as plum.fun has them
const css = readFileSync(join(ROOT, 'src', 'ui', 'css', 'base.css'), 'utf8');
const colors = Object.fromEntries([...css.matchAll(/\.logo-art \.(lg-[a-z]+) \{ color: (#[0-9a-f]{6}); \}/g)].map((m) => [m[1], m[2]]));
const font = readFileSync(join(ROOT, 'src', 'ui', 'fonts', 'jetbrains-mono.woff2')).toString('base64');

// every automated browser on this machine runs at 60 fps at most
const CAP_60FPS = () => {
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const step = 1000 / 60, pending = new Map();
  let nextId = 1, next = 0, last = -1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    const tick = (t) => {
      if (t !== last) {
        if (t < next - 2) { pending.set(id, raf(tick)); return; }
        next = t - next > step ? t + step : next + step;
        last = t;
      }
      pending.delete(id);
      cb(t);
    };
    pending.set(id, raf(tick));
    return id;
  };
  window.cancelAnimationFrame = (id) => { caf(pending.get(id)); pending.delete(id); };
};

/** In the page: the pixel plum at its sizes, and the typed plum drawn big and shrunk into the others. Base64 PNGs by size. */
async function paint({ cells, colors, font, lhBody, bodyFrom, typed, pixel, pixelMap, ink }) {
  const png = (c) => c.toDataURL('image/png').split(',')[1];
  const pixels = Object.entries(pixel).map(([S, k]) => {
    const c = document.createElement('canvas');
    c.width = c.height = Number(S);
    const x = c.getContext('2d');
    pixelMap.forEach((row, y) => [...row].forEach((ch, xx) => { if (ink[ch]) { x.fillStyle = colors[ink[ch]]; x.fillRect(xx * k, y * k, k, k); } }));
    return [S, png(c)];
  });

  const face = new FontFace('PlumMono', `url(data:font/woff2;base64,${font})`, { weight: '100 800' });
  await face.load();
  document.fonts.add(face);
  const FS = 120, PAD = 60, COLS = 19, ROWS = 13;
  // each row's top, in ems
  const rowY = (r, top) => (r <= bodyFrom ? r * top : bodyFrom * top + (r - bodyFrom) * lhBody);
  const W = Math.ceil(COLS * 0.6 * FS + PAD * 2), H = Math.ceil((rowY(ROWS, 1) + 1) * FS + PAD * 2);
  const draw = (w, top) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.font = `800 ${FS}px PlumMono`;
    x.textBaseline = 'alphabetic';
    x.lineJoin = 'round';
    x.lineWidth = w * FS;
    for (const { r, c: col, ch, k } of cells) {
      const px = PAD + col * 0.6 * FS, py = PAD + (rowY(r, top) + 0.8) * FS;
      x.fillStyle = x.strokeStyle = colors[k];
      if (w) x.strokeText(ch, px, py);
      x.fillText(ch, px, py);
    }
    return x.getImageData(0, 0, W, H).data;
  };
  const shrink = (src, S) => {
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (src[(y * W + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = S / Math.max(bw, bh);
    const ox = (S - bw * k) / 2, oy = (S - bh * k) / 2;
    const out = new ImageData(S, S);
    for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
      // the source rectangle under this pixel, clipped to the ink's box
      const sx0 = Math.max(x0, x0 + (px - ox) / k), sx1 = Math.min(x1 + 1, x0 + (px + 1 - ox) / k);
      const sy0 = Math.max(y0, y0 + (py - oy) / k), sy1 = Math.min(y1 + 1, y0 + (py + 1 - oy) / k);
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
          const wt = (Math.min(x + 1, sx1) - Math.max(x, sx0)) * wy, i = (y * W + x) * 4, al = (src[i + 3] / 255) * wt;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
        }
      }
      const o = (py * S + px) * 4;
      if (a) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
      out.data[o + 3] = Math.min(255, Math.round(a * k * k * 255));
    }
    const c = document.createElement('canvas');
    c.width = c.height = S;
    c.getContext('2d').putImageData(out, 0, 0);
    return png(c);
  };
  const drawn = new Map();
  const typedPngs = Object.entries(typed).map(([S, { top, stroke }]) => {
    const key = `${top}|${stroke}`;
    if (!drawn.has(key)) drawn.set(key, draw(stroke, top));
    return [S, shrink(drawn.get(key), Number(S))];
  });
  return Object.fromEntries([...pixels, ...typedPngs]);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
try {
  const pid = browser.process()?.pid;
  if (pid) try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed */ }
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(CAP_60FPS);
  await page.goto('about:blank');
  const pngs = await page.evaluate(paint, { cells, colors, font, lhBody: LH_BODY, bodyFrom: BODY_FROM, typed: TYPED, pixel: PIXEL, pixelMap: PIXEL16, ink: INK });
  mkdirSync(OUT, { recursive: true });
  for (const [size, b64] of Object.entries(pngs)) writeFileSync(join(OUT, `${size}.png`), Buffer.from(b64, 'base64'));
  console.log(`icons: ${Object.keys(pngs).join(', ')} (16 and 32 set in pixels, 48 and 128 typed) -> ${OUT}`);
} finally {
  await browser.close();
}
