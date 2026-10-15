// build.mjs and mainnet's RPC, run for real in a copy of the project with a made-up key in its rpc.local.txt: the build
// for anyone goes to plum's own RPC and holds no key, a build that would hold the key is refused (and dist/ deleted),
// and only --own-rpc builds the key in. The project's own dist/ is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'fake-key-0123456789abcdef';
const KEYED = `https://rpc.example.com/?api-key=${KEY}`;
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'plum-build-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'build.mjs'), join(dir, 'build.mjs'));
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  writeFileSync(join(dir, 'rpc.local.txt'), `${KEYED}\n`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const build = (...args) => spawnSync(process.execPath, ['build.mjs', ...args], { cwd: dir, encoding: 'utf8' });
/** Every built file that holds `text`. */
function holding(text) {
  const out = [];
  const dist = join(dir, 'dist');
  if (!existsSync(dist)) return out;
  for (const f of readdirSync(dist, { recursive: true })) {
    const path = join(dist, f);
    if (statSync(path).isFile() && readFileSync(path).includes(text)) out.push(f);
  }
  return out;
}

test('the build for anyone goes to plum.fun/rpc and holds no key', () => {
  const r = build();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plum's own \(https:\/\/plum\.fun\/rpc\)/);
  assert.deepEqual(holding(KEY), []);
  assert.ok(holding('https://plum.fun/rpc').some((f) => /background\.js$/.test(f)));
  assert.ok(!(r.stdout + r.stderr).includes(KEY), 'the key is never printed');
});

test('a build that would hold the key is refused, and its dist/ deleted', () => {
  const r = build('--rpc', KEYED);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds the RPC key from rpc\.local\.txt/);
  assert.equal(existsSync(join(dir, 'dist')), false);
  assert.ok(!(r.stdout + r.stderr).includes(KEY), 'the key is never printed');
});

test('--own-rpc builds the key in, says so, and is for your own install', () => {
  const r = build('--own-rpc');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /YOURS.*never publish it/);
  assert.ok(holding(KEY).some((f) => /background\.js$/.test(f)));
  assert.ok(!(r.stdout + r.stderr).includes(KEY), 'the key is never printed');
});

test('--rpc takes https, or http only on this computer, and never prints what it was given', () => {
  const local = build('--rpc', 'http://127.0.0.1:8792/rpc');
  assert.equal(local.status, 0, local.stderr);
  assert.ok(holding('http://127.0.0.1:8792/rpc').some((f) => /background\.js$/.test(f)));
  for (const bad of [`http://rpc.example.com/?api-key=${KEY}`, `https://user:${KEY}@rpc.example.com/`, `not a url ${KEY}`]) {
    const r = build('--rpc', bad);
    assert.notEqual(r.status, 0, bad);
    assert.ok(!(r.stdout + r.stderr).includes(KEY), 'the key is never printed');
  }
});
