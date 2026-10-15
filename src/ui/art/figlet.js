/* FIGlet in the browser: big type built from characters. A .flf font is parsed once; text is set with the font's own
 * layout (kerning, or smushing by its rules), as figlet 2.2 does it. The site's titles are set in two fonts, shipped in
 * ./fonts: Big Money-nw (nathan bloomfield, widened by patorjk) for the big ones, Small (Glenn Chappell) for small ones.
 * Pure functions, no DOM: the same code can run in Node. */
/* eslint-disable */

const SM_EQUAL = 1, SM_LOWLINE = 2, SM_HIERARCHY = 4, SM_PAIR = 8, SM_BIGX = 16, SM_HARDBLANK = 32, SM_KERN = 64, SM_SMUSH = 128;

/** Parse a .flf font (the printable ASCII range is all the site needs). */
export function parseFont(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const head = lines[0].split(' ');
  if (!/^flf2a/.test(head[0])) throw new Error('not a figlet font');
  const hard = head[0][5];
  const height = +head[1], oldLayout = +head[4], comments = +head[5];
  const full = head.length > 7 ? +head[7] : null;
  let mode;
  if (full != null && !Number.isNaN(full)) mode = full & (SM_SMUSH | SM_KERN | 63);
  else if (oldLayout === 0) mode = SM_KERN;
  else if (oldLayout < 0) mode = 0;
  else mode = (oldLayout & 31) | SM_SMUSH;
  const chars = new Map();
  let at = 1 + comments;
  for (let code = 32; code < 127 && at + height <= lines.length; code++) {
    const g = [];
    for (let r = 0; r < height; r++) {
      const l = lines[at + r];
      const end = l[l.length - 1];
      let k = l.length;
      while (k > 0 && l[k - 1] === end) k--;
      g.push(l.slice(0, k));
    }
    at += height;
    const w = Math.max(...g.map((l) => l.length));
    chars.set(code, g.map((l) => l.padEnd(w, ' ')));
  }
  return { hard, height, mode, chars };
}

function smushem(F, l, r, wl, wr) {
  if (l === ' ') return r;
  if (r === ' ') return l;
  if (wl < 2 || wr < 2) return null;
  const m = F.mode;
  if (!(m & SM_SMUSH)) return null;
  if ((m & 63) === 0) {
    if (l === F.hard) return r;
    if (r === F.hard) return l;
    return r;
  }
  if (m & SM_HARDBLANK && l === F.hard && r === F.hard) return l;
  if (l === F.hard || r === F.hard) return null;
  if (m & SM_EQUAL && l === r) return l;
  if (m & SM_LOWLINE) {
    if (l === '_' && '|/\\[]{}()<>'.includes(r)) return r;
    if (r === '_' && '|/\\[]{}()<>'.includes(l)) return l;
  }
  if (m & SM_HIERARCHY) {
    const H = ['|', '/\\', '[]', '{}', '()', '<>'];
    const cl = H.findIndex((s) => s.includes(l)), cr = H.findIndex((s) => s.includes(r));
    if (cl >= 0 && cr >= 0 && cl !== cr) return cl > cr ? l : r;
  }
  if (m & SM_PAIR) {
    const p = l + r;
    if (p === '[]' || p === '][' || p === '{}' || p === '}{' || p === '()' || p === ')(') return '|';
  }
  if (m & SM_BIGX) {
    if (l === '/' && r === '\\') return '|';
    if (l === '\\' && r === '/') return 'Y';
    if (l === '>' && r === '<') return 'X';
  }
  return null;
}

/** Text set in a font: an array of lines (trailing blank lines and trailing spaces dropped). */
export function figlet(F, text) {
  const out = Array.from({ length: F.height }, () => '');
  let prevW = 0;
  for (const chr of String(text)) {
    const g = F.chars.get(chr.charCodeAt(0)) ?? F.chars.get(63) ?? F.chars.get(32);
    const w = g[0].length;
    const len = out[0].length;
    let amt = 0;
    if (len > 0 && F.mode & (SM_KERN | SM_SMUSH)) {
      amt = w;
      for (let r = 0; r < F.height; r++) {
        const line = out[r];
        let lb = line.length - 1;
        while (lb > 0 && line[lb] === ' ') lb--;
        const ch1 = line[lb];
        let cb = 0;
        while (cb < g[r].length && g[r][cb] === ' ') cb++;
        const ch2 = g[r][cb];
        let a = cb + len - 1 - lb;
        if (!ch1 || ch1 === ' ') a++;
        else if (ch2 && smushem(F, ch1, ch2, prevW, w) != null) a++;
        amt = Math.min(amt, a);
      }
    }
    for (let r = 0; r < F.height; r++) {
      let line = out[r];
      for (let k = 0; k < amt; k++) {
        const i = len - amt + k;
        if (i < 0) continue;
        const s = smushem(F, line[i], g[r][k], prevW, w) ?? g[r][k];
        line = line.slice(0, i) + s + line.slice(i + 1);
      }
      out[r] = line + g[r].slice(amt);
    }
    prevW = w;
  }
  const res = out.map((l) => l.split(F.hard).join(' ').replace(/\s+$/, ''));
  while (res.length && !res[res.length - 1]) res.pop();
  while (res.length && !res[0]) res.shift();
  return res;
}
