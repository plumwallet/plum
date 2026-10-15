// Text from outside (token names, messages, sign-in fields) can carry characters that hide or reorder what's on
// screen, so what you read isn't what you sign: C0/C1 controls (tab, line feed and carriage return aside), zero-width
// and bidirectional marks, line and paragraph separators, variation selectors, combining and format characters that
// draw nothing, invisible fillers, interlinear annotations, and the astral TAG block used to smuggle hidden text.
// Listed by code point and matched by code point (the regex has the u flag), so characters outside the BMP count too.
const RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad], [0x34f], [0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x2800], [0x3164], [0xfe00, 0xfe0f],
  [0xfeff], [0xffa0], [0xfff0, 0xfffb], [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];
const cls = RANGES.map(([a, b]) => (b ? `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}` : String.fromCodePoint(a))).join('');

export const HIDDEN = new RegExp(`[${cls}]`, 'u');
const HIDDEN_ALL = new RegExp(`[${cls}]`, 'gu');

/** Does the text hold any of those characters? */
export const hasHidden = (s) => HIDDEN.test(String(s));

/** One line of plain text: hidden characters gone, line breaks as spaces, at most `max` characters (whole code points). */
export const cleanLine = (s, max = 64) => [...String(s).replace(HIDDEN_ALL, '').replace(/[\r\n\t]+/g, ' ').trim()].slice(0, max).join('');
