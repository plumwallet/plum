// The page's scrollbar, drawn in text: a column of characters down the right edge in place of the browser's own bar.
// The track is ':' and the thumb a small box on its side ('.', '|', "'"), in whole rows of text, so it moves a line at
// a time. Drag the thumb, or press the track to jump there. Built from text nodes only; it shows only while there's
// something to scroll.
const bar = document.createElement('div');
bar.className = 'tbar';
bar.setAttribute('aria-hidden', 'true');
const text = document.createElement('pre');
bar.append(text);
document.body.append(bar);
document.documentElement.classList.add('tbar-on'); // Firefox's own bar goes (css) only once this one is here

const root = document.scrollingElement || document.documentElement;
let shown = '', frame = 0, drag = null;
/** One row of the bar, in pixels: its line height (css). */
const row = () => parseFloat(getComputedStyle(text).lineHeight) || 12.5;

/** The bar as it is right now: how many rows, where the thumb starts and how long it is. */
function measure() {
  const view = innerHeight, full = root.scrollHeight, r = row();
  const rows = Math.max(4, Math.floor(view / r));
  if (full <= view + 1) return { rows, size: 0, at: 0, room: 0, travel: 0, r };
  const size = Math.max(3, Math.min(rows - 1, Math.round((rows * view) / full)));
  const travel = full - view;
  const at = Math.round(((rows - size) * Math.min(travel, Math.max(0, root.scrollTop))) / travel);
  return { rows, size, at, room: rows - size, travel, r };
}

function paint() {
  frame = 0;
  const m = measure();
  bar.hidden = m.size === 0;
  if (!m.size) return;
  const key = `${m.rows}|${m.size}|${m.at}`;
  if (key === shown) return;
  shown = key;
  const out = [];
  for (let i = 0; i < m.rows; i++) {
    if (i) out.push('\n');
    const t = i - m.at;
    if (t < 0 || t >= m.size) out.push(':');
    else {
      const b = document.createElement('b');
      b.textContent = t === 0 ? '.' : t === m.size - 1 ? "'" : '|';
      out.push(b);
    }
  }
  text.replaceChildren(...out);
}
const later = () => { if (!frame) frame = requestAnimationFrame(paint); };

addEventListener('scroll', later, { passive: true });
addEventListener('resize', later);
new ResizeObserver(later).observe(document.body);
paint();

bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const m = measure();
  if (!m.size) return;
  const at = Math.floor((e.clientY - bar.getBoundingClientRect().top) / m.r);
  if (at < m.at || at >= m.at + m.size) {
    // the track: put the thumb's middle where it was pressed
    const target = Math.min(m.room, Math.max(0, at - Math.floor(m.size / 2)));
    root.scrollTop = m.room ? (target / m.room) * m.travel : 0;
  }
  const now = measure();
  drag = { y: e.clientY, top: root.scrollTop, perPx: now.room ? now.travel / (now.room * now.r) : 0 };
  bar.classList.add('held');
  bar.setPointerCapture(e.pointerId);
});
bar.addEventListener('pointermove', (e) => {
  if (!drag) return;
  root.scrollTop = drag.top + (e.clientY - drag.y) * drag.perPx;
});
const letGo = () => { drag = null; bar.classList.remove('held'); };
bar.addEventListener('pointerup', letGo);
bar.addEventListener('pointercancel', letGo);
