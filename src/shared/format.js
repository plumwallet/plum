// Numbers and addresses as people read them. Token amounts stay integers (BigInt) until they're shown.

export const short = (a, n = 4) => (typeof a === 'string' && a.length > 2 * n + 1 ? `${a.slice(0, n)}..${a.slice(-n)}` : a ?? '');

/** A raw integer amount as a decimal string: formatUnits(1500000000n, 9) === '1.5'. */
export function formatUnits(raw, decimals) {
  let v = BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = v / base;
  let frac = decimals ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A decimal string as a raw integer amount: parseUnits('1.5', 9) === 1500000000n. Throws on anything else. */
export function parseUnits(text, decimals) {
  const s = String(text).trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('type an amount, like 0.5');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`this token has ${decimals} decimal${decimals === 1 ? '' : 's'} at most`);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** A friendly amount, cut (never rounded up): grouped thousands, about `sig` significant digits. */
export function prettyAmount(raw, decimals, { sig = 6 } = {}) {
  const s = formatUnits(raw, decimals);
  const neg = s.startsWith('-');
  const [w, f = ''] = (neg ? s.slice(1) : s).split('.');
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // under 1, keep the leading zeros and four digits after them (0.00001234)
  const keep = w === '0' ? f.match(/^0*/)[0].length + 4 : Math.max(0, sig - w.length);
  const frac = f.slice(0, keep).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function usd(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const digits = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 4 : 6;
  return `${n < 0 ? '-' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits === 2 ? 2 : 0, maximumFractionDigits: digits })}`;
}

export function ago(seconds) {
  if (!seconds) return '';
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
