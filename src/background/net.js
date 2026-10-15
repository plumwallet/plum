// Reading the outside world for Ethereum and Bitcoin: JSON over fetch with a timeout, and the same question asked of
// the next provider when one is down. No cookies, no referrer. Everything that comes back is data, checked by the caller.

export class NetError extends Error {
  constructor(message, { status = null, data = null } = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** fetch with a timeout: { status, ok, text }. */
export async function request(url, { method = 'GET', body, headers = {}, timeout = 15_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: body != null ? { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers } : headers,
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (e) {
    throw new NetError(e?.name === 'AbortError' ? `${new URL(url).host} took too long to answer` : `can't reach ${new URL(url).host}: check your connection`);
  } finally {
    clearTimeout(t);
  }
}

/** JSON from a URL; a non-2xx answer throws (with its status). */
export async function getJson(url, opts) {
  const r = await request(url, opts);
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* not json */ }
  if (!r.ok) throw new NetError(json?.message || json?.error?.message || `${new URL(url).host} answered ${r.status}`, { status: r.status, data: json });
  if (json == null) throw new NetError(`${new URL(url).host} answered with something that isn't JSON`);
  return json;
}

/**
 * Ask each provider in turn until one answers: `fn(base)` for each base URL. A provider that's down, slow or rate
 * limiting moves on to the next; a real answer (even an error the chain gave, like "nonce too low") is final, so a
 * transaction is never sent twice because one provider said no.
 */
export async function failover(bases, fn, { final = (e) => e?.final } = {}) {
  let last;
  for (const base of bases) {
    try {
      return await fn(base);
    } catch (e) {
      if (final(e)) throw e;
      last = e;
    }
  }
  throw last ?? new NetError('no provider answered');
}

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
