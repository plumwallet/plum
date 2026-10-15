// plum's Ledger clients against Ledger's own apps, in its Speculos emulator (a Nano S Plus in Docker): every scenario in
// test/ledger-scenarios.mjs, the device's buttons pressed through Speculos's API, each result checked against plum's own
// keys. With --record, every exchange is written to test/fixtures/ledger-speculos.json, which npm test replays.
//   node scripts/ledger-speculos.mjs --elf <dir> [--record] [--only <app>] [--docker <docker.exe>]
// <dir> holds solana.elf, ethereum.elf and bitcoin.elf: LedgerHQ's app-solana, app-ethereum and app-bitcoin-new
// (COIN=bitcoin), built for the Nano S Plus with Ledger's app builder image. Docker must be running; this starts and
// stops one container per app.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, SEED_PHRASE } from '../test/ledger-scenarios.mjs';
import { speculosApi, speculosLink } from './ledger/speculos.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const ELF = arg('--elf') ? resolve(arg('--elf')) : null;
const DOCKER = arg('--docker') ?? 'docker';
const ONLY = arg('--only');
const RECORD = process.argv.includes('--record');
const NAME = 'plum-speculos';
const FILES = { Solana: 'solana.elf', Ethereum: 'ethereum.elf', Bitcoin: 'bitcoin.elf' };
const SETTING = { blind: /blind sign/i, raw: /^raw messages|^verbose/i };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!ELF) { console.error('usage: node scripts/ledger-speculos.mjs --elf <dir with solana.elf, ethereum.elf, bitcoin.elf> [--record]'); process.exit(1); }

const docker = (...args) => execFileSync(DOCKER, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stop = () => { try { docker('rm', '-f', NAME); } catch { /* not running */ } };

async function start(app) {
  stop();
  docker('run', '-d', '--rm', '--name', NAME, '--cpus', '2', '-p', '127.0.0.1:9999:9999', '-p', '127.0.0.1:5000:5000', '-v', `${ELF}:/apps`,
    'ghcr.io/ledgerhq/speculos:latest', '--model', 'nanosp', '--display', 'headless', '--apdu-port', '9999', '--api-port', '5000', '--seed', SEED_PHRASE, `/apps/${FILES[app]}`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try { const r = await fetch('http://127.0.0.1:5000/events?currentscreenonly=true'); if (r.ok && /ready/i.test(await r.text())) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`Speculos didn't start with ${app}`);
}

const OUT = join(ROOT, 'test', 'fixtures', 'ledger-speculos.json');
// with --only, the other apps' scenarios stay as they were recorded
const record = ONLY && existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { device: 'Speculos, Nano S Plus', seed: 'the abandon ... about test phrase', apps: {}, scenarios: {} };
for (const [name, s] of Object.entries(record.scenarios)) if (s.app.toLowerCase() === ONLY?.toLowerCase()) delete record.scenarios[name];
let failed = 0;
try {
  // a fresh device for each run of scenarios that need the same settings (the emulator keeps them until it stops)
  const runs = [];
  for (const s of SCENARIOS) {
    if (ONLY && ONLY.toLowerCase() !== s.app.toLowerCase()) continue;
    const key = `${s.app}:${(s.settings ?? []).join(',')}`;
    if (runs.at(-1)?.key === key) runs.at(-1).list.push(s); else runs.push({ key, app: s.app, settings: s.settings ?? [], list: [s] });
  }
  for (const { app, settings, list } of runs) {
    await start(app);
    const link = await speculosLink();
    const api = speculosApi();
    try {
      for (const want of settings) console.log(`  (a fresh ${app} app, ${want} turned on: ${await api.setting(SETTING[want])})`);
      for (const s of list) {
        const from = link.log.length;
        const running = s.run(link);
        // approve2: two reviews in a row (a send from both Bitcoin addresses is two passes)
        const pressed = s.device === 'approve2' ? api.approve({ max: 80 }).then(async (a) => [...a, ...await api.approve({ max: 80 })])
          : s.device ? (s.device === 'approve' ? api.approve({ max: 80 }) : api.reject({ max: 80 })) : null;
        // buttons that never reach the answer leave the device waiting: closing the link ends this scenario
        pressed?.catch(() => link.close());
        try {
          const result = await running;
          const screens = pressed ? await pressed : null;
          s.check(result);
          record.scenarios[s.name] = { app, exchanges: link.log.slice(from) };
          console.log(`ok    ${s.name}${screens ? `\n        ${screens.filter(Boolean).join(' || ').slice(0, 300)}` : ''}`);
        } catch (e) {
          failed++;
          console.log(`FAIL  ${s.name}: ${e.state ? `${e.state}: ` : ''}${e.message}`);
          for (const [a, b] of link.log.slice(-3)) console.log(`        > ${a.slice(0, 90)}\n        < ${b.slice(0, 90)}`);
        }
      }
      record.apps[app] = (await import('../src/background/ledger/apdu.js').then((m) => m.appInfo(link))).version;
    } finally {
      link.close();
    }
  }
} finally {
  stop();
}
if (RECORD && !failed) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(record, null, 1)}\n`);
  console.log(`\nrecorded ${Object.keys(record.scenarios).length} scenarios to test/fixtures/ledger-speculos.json`);
}
console.log(failed ? `\nspeculos: ${failed} failed` : '\nspeculos: passed');
process.exit(failed ? 1 : 0);
