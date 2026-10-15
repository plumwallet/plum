// When `npm run sign` stops waiting before Mozilla has signed (web-ext waits 15 minutes; a big change can take longer),
// the version is still uploaded and gets signed on Mozilla's side. This waits for that and downloads the signed .xpi:
//   node scripts/amo-fetch.mjs <version id> [--own-rpc] [--wait-min 60] [--open]
// The version id is the number in the link web-ext prints (.../versions/<id>). The credentials come from amo.local.txt
// (or WEB_EXT_API_KEY / WEB_EXT_API_SECRET), as for signing, and are never printed. --own-rpc names the file -own-rpc
// (it holds the RPC key: for your own install only). --open opens it in Firefox Developer Edition, which asks to add it.
// It stops at once when Mozilla rejects the version or has disabled the add-on.
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = join(ROOT, 'artifacts');
const FIREFOX = 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe';
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const versionId = process.argv[2];
if (!/^\d+$/.test(versionId ?? '')) { console.error('usage: node scripts/amo-fetch.mjs <version id> [--own-rpc] [--wait-min 60] [--open]'); process.exit(1); }
const waitMin = Number(arg('--wait-min') ?? 60);
const GUID = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;

function credentials() {
  const out = { issuer: process.env.WEB_EXT_API_KEY ?? '', secret: process.env.WEB_EXT_API_SECRET ?? '' };
  const file = join(ROOT, 'amo.local.txt');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(issuer|secret)\s*=\s*(\S+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  if (!out.issuer || !out.secret) { console.error('no Mozilla credentials in amo.local.txt'); process.exit(1); }
  return out;
}
const { issuer, secret } = credentials();

// AMO checks a token's times against its own clock, and a token here lasts a minute: a computer clock a minute or more
// behind gets "Signature has expired" on every request. So tokens are dated by AMO's clock, taken from the Date header
// of its latest answer.
let skew = 0;
const keepTime = (r) => { const t = Date.parse(r.headers.get('date') ?? ''); if (Number.isFinite(t)) skew = t - Date.now(); };

/** AMO's API takes a JWT signed with the API secret, good for a minute. */
function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor((Date.now() + skew) / 1000) - 5; // the Date header only has whole seconds
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
async function get(url, { auth = true, method = 'GET' } = {}) {
  const r = await fetch(url, { method, headers: auth ? { authorization: `JWT ${token()}` } : {}, signal: AbortSignal.timeout(30_000) });
  keepTime(r);
  return r;
}

const base = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(GUID)}`;
const DISABLED = `Mozilla has disabled the add-on (not you), so nothing more gets signed. Mozilla emails the reason and how to appeal to the developer account's address.`;

// process.exit() while fetch still holds a socket trips a libuv assertion on Windows, so main() returns the exit code.
async function main() {
  try { await get('https://addons.mozilla.org/api/v5/', { auth: false, method: 'HEAD' }); } catch {}
  const until = Date.now() + waitMin * 60_000;
  let v = null, refused = 0;
  for (;;) {
    try {
      const r = await get(`${base}/versions/${versionId}/`);
      if (r.ok) { v = await r.json(); refused = 0; }
      else {
        const body = await r.json().catch(() => ({}));
        if (body.is_disabled_by_mozilla) { console.error(DISABLED); return 1; }
        console.log(`AMO answered ${r.status}${body.detail ? `: ${body.detail}` : ''}`);
        if ((r.status === 401 || r.status === 403) && ++refused >= 3) { console.error('AMO keeps refusing: check the credentials in amo.local.txt'); return 1; }
      }
    } catch (e) { console.log(`AMO didn't answer (${e.message}): trying again`); }
    const status = v?.file?.status;
    if (status === 'public' && v.file.url) break;
    if (status === 'disabled') {
      const addon = await get(`${base}/`).then((r) => r.json()).catch(() => ({}));
      if (addon.status === 'disabled' || addon.is_disabled_by_mozilla) console.error(DISABLED);
      else console.error(`Mozilla rejected version ${v.version}: see https://addons.mozilla.org/en-US/developers/addon/${GUID}/versions/${versionId}`);
      return 1;
    }
    if (Date.now() > until) { console.error(`not signed after ${waitMin} minutes (status: ${status ?? 'unknown'}): run this again later`); return 1; }
    console.log(`${new Date().toLocaleTimeString()}  ${v?.version ?? '?'}: ${status ?? 'waiting'}`);
    await new Promise((res) => setTimeout(res, 60_000));
  }

  const r = await get(v.file.url);
  if (!r.ok) { console.error(`the download answered ${r.status}`); return 1; }
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.subarray(0, 2).toString() !== 'PK') { console.error("the download isn't an .xpi (zip)"); return 1; }
  mkdirSync(ARTIFACTS, { recursive: true });
  const name = (new URL(v.file.url).pathname.split('/').pop() || `${GUID}-${v.version}.xpi`).replace(/\.xpi$/, '');
  const xpi = join(ARTIFACTS, `${name}${process.argv.includes('--own-rpc') ? '-own-rpc' : ''}.xpi`);
  writeFileSync(xpi, bytes);
  console.log(`signed: ${xpi} (${v.version}, ${bytes.length} bytes)`);
  if (process.argv.includes('--open') && existsSync(FIREFOX)) {
    spawn(FIREFOX, [xpi], { detached: true, stdio: 'ignore' }).unref();
    console.log('Firefox Developer Edition is asking to add Plum: click Add');
  }
  return 0;
}
process.exitCode = await main();
