// A QR code for receiving, typed: one bold character per module in a <pre>, at the text's own size, built from text
// only (no innerHTML, no inline styles). Dark modules are a lowercase m: it's x-height tall, so it fills its square 0.6em
// cell without spilling into the rows around it the way capitals do. Light modules are spaces, and the 4-module quiet
// zone is typed spaces too. wallet.css (.qr-ascii) sets the square 0.6em line and the 2px text-stroke that closes each m
// into a solid module: letters left open (a '#', an '@') don't scan reliably, since a camera reads each module's middle.
// Tested with jsQR across 60+ addresses, Firefox and Chromium at 1x to 2x, blur, downscaling, tilt and a phone-camera
// simulation: it reads as reliably as solid squares.
import { encode } from 'uqr';

const DARK = 'm';

export function qrAscii(text) {
  // version 4 for every address (33 x 33): a 43/44-character address is version 4 anyway, and a short one would
  // otherwise be a smaller 21 x 21 code, harder to read at an angle. Never past 4, so it always fits the popup.
  const { data } = encode(text, { ecc: 'M', border: 4, minVersion: 4, maxVersion: 4 });
  const pre = document.createElement('pre');
  pre.className = 'qr-ascii';
  pre.setAttribute('role', 'img');
  pre.setAttribute('aria-label', 'QR code of your address');
  pre.textContent = data.map((row) => row.map((dark) => (dark ? DARK : ' ')).join('')).join('\n');
  return pre;
}
