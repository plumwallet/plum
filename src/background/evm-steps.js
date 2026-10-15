// What plum builds itself on an Ethereum network and sends in order (a swap, a stake, a withdrawal request): the
// approvals a token needs first (plum's own, for exact amounts), then the call. Once the last approval has landed, the
// call is simulated again and checked again by its caller, and only then signed and sent. Each transaction is signed by
// your wallet alone.
import * as E from './eth.js';
import { MAINNET } from './evm-chains.js';

const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const amountWord = (n) => n.toString(16).padStart(64, '0');
const fail = (message) => new Error(message);

/** approve(spender, amount) for a token: plum's own, for an exact amount. */
export const approveData = (spender, amount) => `0x095ea7b3${pad(spender)}${amountWord(amount)}`;

/** How much `spender` may take of `owner`'s `token`. */
export async function allowance(urls, token, owner, spender) {
  const r = await E.ethRpc(urls, 'eth_call', [{ to: token, data: `0xdd62ed3e${pad(owner)}${pad(spender)}` }, 'latest']);
  return BigInt(r && r !== '0x' ? r.slice(0, 66) : '0x0');
}

/** A token's balanceOf(owner). */
export async function tokenBalance(urls, token, owner) {
  const r = await E.ethRpc(urls, 'eth_call', [{ to: token, data: `0x70a08231${pad(owner)}` }, 'latest']);
  return BigInt(r && r !== '0x' ? r.slice(0, 66) : '0x0');
}

/** How long to wait for an approval to land before what needs it goes. */
const LAND_MS = { ethereum: 180_000, base: 60_000, arbitrum: 60_000, polygon: 90_000 };

/**
 * Send prepared steps on `net`: { calls: [{ to, value, data, gas, kind }] (the approvals, then the call), fees (the
 * fee cap you reviewed) }. The approvals are signed and sent first; once the last has landed, `recheck(sim)` reads a
 * fresh simulation of the call (and throws, in words, if it no longer passes); then the call is signed and sent.
 * { hash, approvals }
 */
export async function sendSteps(net, p, { me, urls, signAndSend, status, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }, recheck) {
  const u = await urls(net);
  const [nonceHex, fees] = await Promise.all([E.ethRpc(u, 'eth_getTransactionCount', [me, 'pending']), E.feeQuote(u, net)]);
  // the fee cap you reviewed is the one signed, while the network still agrees with it
  if (fees.base > p.fees.maxFee) throw fail('the network fee has risen past what you reviewed: review it again');
  let nonce = BigInt(nonceHex);
  const tx = (c) => ({ chainId: net.id, nonce: nonce++, maxPriorityFeePerGas: p.fees.tip, maxFeePerGas: p.fees.maxFee, gas: c.gas, to: c.to, value: c.value, data: c.data });
  const call = p.calls.at(-1);
  const approvals = [];
  for (const c of p.calls.slice(0, -1)) approvals.push(await signAndSend(me, tx(c)));
  if (approvals.length) {
    const until = Date.now() + LAND_MS[net.key];
    let st;
    for (;;) {
      st = await status(approvals.at(-1), net).catch(() => 'pending');
      if (st !== 'pending' || Date.now() >= until) break;
      await sleep(net === MAINNET ? 4000 : 1500);
    }
    if (st === 'failed') throw fail(`the approval failed on ${net.title}, so nothing else was sent`);
    if (st !== 'confirmed') throw fail(`the approval hasn't landed on ${net.title} yet, so nothing else was sent: try again in a minute (it won't need another approval)`);
  }
  // the call, simulated once more on the latest block (with the approval in place now) before it is signed
  const sim = await E.simulateCalls(u, me, [call], { fees: p.fees });
  try { recheck(sim); } catch (e) { throw fail(`${approvals.length ? 'the approval landed, but ' : ''}${e.message}`); }
  return { hash: await signAndSend(me, tx(call)), approvals };
}
