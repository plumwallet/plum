// The font password fields type with (src/ui/fonts/plum-mask.otf): one glyph, a six-armed asterisk centred on the line,
// mapped to the dots Firefox shows for each hidden character (U+25CF on Windows, U+2022 elsewhere). wallet.css puts it
// first in password fields only, for just those two characters (unicode-range), so a password shows as * * * and
// everything else, the placeholder included, stays JetBrains Mono. Its cell is JetBrains Mono's: 600 units of 1000.
//   node scripts/mask-font.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'fonts', 'plum-mask.otf');
const ADVANCE = 600, CX = 300;
const CY = 300; // the middle of the lowercase letters, where the dots sat
const ARM = 205, STROKE = 92; // half the asterisk's height, and its bars' thickness

/** The asterisk: three bars through the centre, upright and at +-60 degrees. */
function asterisk() {
  const p = new opentype.Path();
  for (const deg of [90, 30, 150]) {
    const a = (deg * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux, w = STROKE / 2;
    const pts = [[ARM, w], [ARM, -w], [-ARM, -w], [-ARM, w]].map(([s, t]) => [CX + ux * s + nx * t, CY + uy * s + ny * t]);
    p.moveTo(...pts[0]);
    for (const q of pts.slice(1)) p.lineTo(...q);
    p.close();
  }
  return p;
}

const glyph = (name, unicode, path) => new opentype.Glyph({ name, unicode, advanceWidth: ADVANCE, path });
const font = new opentype.Font({
  familyName: 'PlumMask', styleName: 'Regular', unitsPerEm: 1000, ascender: 1020, descender: -300,
  glyphs: [glyph('.notdef', 0, new opentype.Path()), glyph('blackcircle', 0x25cf, asterisk()), glyph('bullet', 0x2022, asterisk())],
});
writeFileSync(OUT, Buffer.from(font.toArrayBuffer()));
console.log(`wrote ${OUT}`);
