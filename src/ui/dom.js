// Building the page: elements from code, text always as text. No innerHTML anywhere in plum, so nothing a site or a
// token's name contains can ever become markup.

/** h('div', { class: 'x', onclick }, 'text', child, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'vars') for (const [n, x] of Object.entries(v)) el.style.setProperty(n, x);
    else if (k === 'href' || k === 'src') { if (/^https:\/\//.test(String(v)) || (k === 'src' && /^data:image\//.test(String(v)))) el.setAttribute(k, v); }
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'open') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
}

/** Copy text, then say so on the button for a moment. */
export async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const was = btn.textContent;
      btn.textContent = 'copied';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 1200);
    }
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A button that does `fn`, showing a spinner and refusing double clicks while it runs. */
export function busyButton(el, fn) {
  el.addEventListener('click', async (e) => {
    if (el.dataset.busy) return;
    el.dataset.busy = '1';
    const label = [...el.childNodes];
    // while it works the button shows only plum's turning | / - \ (no word), at the width it had, so nothing moves; its
    // busy word stays for screen readers
    el.style.minWidth = `${el.getBoundingClientRect().width}px`;
    el.disabled = true;
    el.setAttribute('aria-label', el.dataset.busyText || 'working');
    el.replaceChildren(h('span', { class: 'spin' }));
    try {
      await fn(e);
    } finally {
      delete el.dataset.busy;
      if (el.isConnected) {
        el.disabled = false;
        el.removeAttribute('aria-label');
        el.style.minWidth = '';
        el.replaceChildren(...label);
      }
    }
  });
  return el;
}
