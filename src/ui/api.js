// plum's pages ask the background for everything; they hold no secret themselves.
import { ext } from '../shared/ext.js';

export class PlumError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function call(method, params = {}) {
  const r = await ext().runtime.sendMessage({ type: 'plum-ui', method, params });
  if (!r) throw new PlumError("plum's background didn't answer: try again");
  if (!r.ok) throw new PlumError(r.error, r.code);
  return r.result;
}

/** Keep the background awake while this page is open (Firefox suspends an idle event page, Chromium an idle service
 * worker after 30 seconds). */
export function keepAlive() {
  const t = setInterval(() => { call('ping').catch(() => {}); }, 15_000);
  return () => clearInterval(t);
}
