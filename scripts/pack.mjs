// Pack plum from a fresh build, one zip per browser family:
//   artifacts/plum-<version>.zip            Firefox: web-ext's build of dist/firefox/
//   artifacts/plum-<version>-chromium.zip   Chrome Web Store, Edge Add-ons, Opera Add-ons: dist/chromium/'s files with
//                                           manifest.json at the root of the zip, which is what they take (and, unzipped,
//                                           what "Load unpacked" takes)
//   npm run pack
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = join(ROOT, 'artifacts');
const CHROMIUM = join(ROOT, 'dist', 'chromium');
const { version } = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8'));

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(process.execPath, [join(ROOT, 'build.mjs')]);
run(process.execPath, [join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'build', '--source-dir', 'dist/firefox', '--artifacts-dir', 'artifacts', '--overwrite-dest']);

/* ------------------------------------------------------------ a zip, written here (no dependency for it) */

// the zip format's checksum (CRC-32), by the usual table
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Little-endian fields one after another, as [bytes, value] pairs: how the zip format lays out its headers. */
function fields(...list) {
  const out = Buffer.alloc(list.reduce((n, [bytes]) => n + bytes, 0));
  let at = 0;
  for (const [bytes, value] of list) {
    if (bytes === 2) out.writeUInt16LE(value, at);
    else out.writeUInt32LE(value, at);
    at += bytes;
  }
  return out;
}

/** A file's time as the zip format keeps it (MS-DOS: two-second steps, from 1980). */
const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

/** Zip every file under `dir` into `out`, with paths relative to `dir` (so its manifest.json sits at the root). */
function zipFolder(dir, out) {
  const UTF8_NAMES = 0x0800;
  const names = readdirSync(dir, { recursive: true }).filter((p) => statSync(join(dir, p)).isFile()).map((p) => p.split(sep).join('/')).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const path = join(dir, name);
    const data = readFileSync(path);
    const deflated = deflateRawSync(data);
    // pictures and fonts are compressed already: those are stored as they are
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const nameBytes = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(statSync(path).mtime);
    // version needed (2.0), flags, method (0 stored, 8 deflated), time, date, crc, sizes, name length, extra length
    const common = [[2, 20], [2, UTF8_NAMES], [2, store ? 0 : 8], [2, time], [2, date], [4, crc32(data)], [4, body.length], [4, data.length], [2, nameBytes.length], [2, 0]];
    const local = Buffer.concat([fields([4, 0x04034b50], ...common), nameBytes, body]);
    // the central directory's entry adds: made by (2.0), comment length, disk, attributes, where the local entry is
    centrals.push(Buffer.concat([fields([4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = fields([4, 0x06054b50], [2, 0], [2, 0], [2, names.length], [2, names.length], [4, directory.length], [4, offset], [2, 0]);
  writeFileSync(out, Buffer.concat([...locals, directory, end]));
  return names.length;
}

mkdirSync(ARTIFACTS, { recursive: true });
const zip = join(ARTIFACTS, `plum-${version}-chromium.zip`);
const count = zipFolder(CHROMIUM, zip);
console.log(`packed ${relative(ROOT, zip)} (${count} files, ${Math.round(statSync(zip).size / 1024)} KB): upload it to the Chrome Web Store, Edge Add-ons or Opera Add-ons`);
