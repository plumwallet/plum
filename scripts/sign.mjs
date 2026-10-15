// Sign plum with Mozilla (unlisted: private, never on the add-ons store) and open the install prompt in Firefox.
//   npm run sign                 the copy for anyone: mainnet through plum's own RPC (https://plum.fun/rpc), which has
//                                to be answering first, since the signed copy can't reach mainnet without it
//   npm run sign -- --own-rpc    a copy for your own install, straight to the RPC in rpc.local.txt with its key; its
//                                .xpi is named -own-rpc so it's never mistaken for the one to publish
// The credentials come from amo.local.txt (issuer=..., secret=..., from addons.mozilla.org/developers/addon/api/key/)
// or WEB_EXT_API_KEY / WEB_EXT_API_SECRET. They're handed to web-ext through its environment and never printed.
// Mozilla also gets the readable source (artifacts/plum-source.zip), since dist/firefox/ is bundled.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUM_RPC } from '../src/background/rpc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = join(ROOT, 'artifacts');
const FIREFOX = 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe';

function credentials() {
  const out = { issuer: process.env.WEB_EXT_API_KEY ?? '', secret: process.env.WEB_EXT_API_SECRET ?? '' };
  const file = join(ROOT, 'amo.local.txt');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(issuer|secret)\s*=\s*(\S+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  if (!out.issuer || !out.secret) {
    console.error('no Mozilla credentials: paste them into amo.local.txt (issuer=... and secret=...), from https://addons.mozilla.org/developers/addon/api/key/');
    process.exit(1);
  }
  return out;
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Does plum's own RPC answer a real call, the way plum makes it (from an extension, as JSON)? */
async function plumRpcAnswers() {
  try {
    const res = await fetch(PLUM_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'moz-extension://00000000-0000-4000-8000-000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(15_000),
    });
    return Number.isInteger((await res.json())?.result);
  } catch {
    return false;
  }
}

const ownRpc = process.argv.includes('--own-rpc');
const { issuer, secret } = credentials();
if (!ownRpc && !(await plumRpcAnswers())) {
  console.error(`${PLUM_RPC} isn't answering, and the copy for anyone reads mainnet through it: deploy the proxy first (proxy/README.md), or sign your own copy with --own-rpc`);
  process.exit(1);
}
run(process.execPath, [join(ROOT, 'build.mjs'), ...(ownRpc ? ['--own-rpc'] : [])]);

// the readable source, for Mozilla (no keys in it: rpc.local.txt and amo.local.txt stay out)
mkdirSync(ARTIFACTS, { recursive: true });
const source = join(ARTIFACTS, 'plum-source.zip');
rmSync(source, { force: true });
const tar = process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
run(tar, ['-a', '-c', '-f', source, 'src', 'build.mjs', 'package.json', 'package-lock.json', 'README.md']);

const before = new Set(existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS) : []);
run(process.execPath, [join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'sign', '--channel', 'unlisted', '--source-dir', 'dist/firefox',
  '--artifacts-dir', 'artifacts', '--upload-source-code', source, '--no-config-discovery'], {
  env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret },
});

const xpis = readdirSync(ARTIFACTS).filter((f) => f.endsWith('.xpi')).map((f) => join(ARTIFACTS, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const fresh = xpis.find((f) => !before.has(f.split(/[\\/]/).pop()));
let xpi = fresh ?? xpis[0];
if (!xpi) { console.error('Mozilla signed nothing yet: check https://addons.mozilla.org/developers/addons'); process.exit(1); }
if (ownRpc && fresh) {
  xpi = fresh.replace(/\.xpi$/, '-own-rpc.xpi');
  renameSync(fresh, xpi);
}
console.log(`signed: ${xpi}${ownRpc ? ' (holds your RPC key: install it yourself, never publish it)' : ''}`);
if (!process.argv.includes('--no-open') && existsSync(FIREFOX)) {
  spawn(FIREFOX, [xpi], { detached: true, stdio: 'ignore' }).unref();
  console.log('Firefox Developer Edition is asking to add Plum: click Add');
}
