// Staking ETH with Lido, in the popup: your stETH and your withdrawal requests (each claimable once Lido has finalized
// it), then the steps: stake ETH, ask for ETH back. The background builds every transaction itself for Lido's own
// contracts, simulates it and refuses it if anything else would move (lido.js there); the review shows each step, on
// Ethereum, before you sign.
import { ago, formatUnits, prettyAmount, short, usd } from '../shared/format.js';
import { call } from './api.js';
import { active, ctx, errLine, field, go, screen, show, showErr } from './app.js';
import { busyButton, h } from './dom.js';
import { netLoud } from './evm.js';
import { deviceBox, isLedgerWallet } from './ledger.js';
import { actions, box, kv, previewBlock, seg, spinner } from './parts.js';

const eth = (wei) => `${prettyAmount(BigInt(wei), 18)} ETH`;
const steth = (wei) => `${prettyAmount(BigInt(wei), 18)} stETH`;

/** The chains staking happens on (SOL with validators, ETH with Lido), as a row at the top of the stake screen; none
 * when the wallet has only one of them. */
export function stakeNetSeg(w, current) {
  const choices = [...(w.chains.sol ? [['sol', 'sol']] : []), ...(w.chains.eth ? [['eth', 'eth']] : [])];
  if (choices.length < 2) return null;
  return h('div', { class: 'swap-net' }, h('span', { class: 'dim' }, 'stake'), seg(choices, current, (v) => go.stake({ net: v }), { label: 'which chain' }));
}

/** The Lido screen. `top` is what sits above it (the stake screen's row of chains, when there is one). */
export async function lidoScreen({ top = null } = {}) {
  const w = active();
  if (!w.chains.eth) { show(...screen('stake', () => go.home(), top, h('div', { class: 'note' }, `staking ETH is on Ethereum, and ${w.name} has no Ethereum address (it's an imported key).`))); return; }
  const list = h('div', { class: 'tks' }, h('p', { class: 'empty', 'aria-label': 'reading' }, spinner()));
  const err = errLine();
  const stakeIn = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', autocomplete: 'off' });
  const unstakeIn = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', autocomplete: 'off' });
  const haveEth = h('span', { class: 'dim' });
  const haveSteth = h('span', { class: 'dim' });
  let o = null, wei = null;
  const stakeGo = h('button', { class: 'btn-go block', type: 'button', dataset: { busyText: 'simulating' } }, 'stake ETH ->');
  const unstakeGo = h('button', { class: 'btn-go block', type: 'button', dataset: { busyText: 'simulating' } }, 'ask for ETH back ->');
  const prepare = (input, back) => async () => {
    err.hidden = true;
    try { review(await call('lido.prepare', input()), { back }); } catch (e) { showErr(err, e); }
  };
  busyButton(stakeGo, prepare(() => ({ action: 'stake', amount: stakeIn.value.trim() }), () => lidoScreen({ top })));
  busyButton(unstakeGo, prepare(() => ({ action: 'request', amount: unstakeIn.value.trim() }), () => lidoScreen({ top })));
  const maxEth = h('button', { class: 'mini', type: 'button', onclick: () => { if (wei != null) { const keep = 3_000_000_000_000_000n; stakeIn.value = formatUnits(wei > keep ? wei - keep : 0n, 18); } } }, 'max');
  const maxSteth = h('button', { class: 'mini', type: 'button', onclick: () => { if (o) unstakeIn.value = formatUnits(BigInt(o.staked), 18); } }, 'max');
  show(...screen('stake', () => go.home(), top,
    box('lido, on ethereum', { tone: 'soft', side: netLoud('ethereum') }, list),
    box('stake', { tone: 'soft' },
      field('ETH to stake', h('div', { class: 'input-group' }, stakeIn, h('span', { class: 'suffix-btn' }, maxEth)), haveEth),
      stakeGo),
    box('unstake', { tone: 'soft' },
      field('stETH to unstake', h('div', { class: 'input-group' }, unstakeIn, h('span', { class: 'suffix-btn' }, maxSteth)), haveSteth),
      unstakeGo),
    err,
    h('p', { class: 'fine' }, "Lido stakes your ETH with its node operators and gives you stETH, which grows each day as the stake earns. Getting ETH back is a request Lido finalizes in a few days; then claim it here.")));
  try {
    const [state, bal] = await Promise.all([call('lido.state'), ctx.bal.get(`${w.id}:eth`) ?? call('balances', { chain: 'eth' })]);
    if (!list.isConnected) return;
    o = state;
    wei = BigInt(bal.native.amount ?? 0);
    haveEth.textContent = `have ${eth(wei)}`;
    haveSteth.textContent = `have ${steth(o.staked)}`;
    const rows = [
      h('div', { class: 'tk plain' }, h('span', { class: 'tk-n' }, h('b', null, 'stETH'), h('span', { class: 'dim' }, 'staked, earning')), h('span', { class: 'tk-v' }, h('b', null, prettyAmount(BigInt(o.staked), 18)), h('span', { class: 'dim' }, usd(o.usd)))),
      ...o.requests.map((r) => {
        const claim = r.finalized ? h('button', { class: 'mini', type: 'button' }, 'claim') : null;
        if (claim) busyButton(claim, prepare(() => ({ action: 'claim', request: r.id }), () => lidoScreen({ top })));
        return h('div', { class: 'tk plain' },
          h('span', { class: 'tk-n' }, h('b', null, `withdrawal #${short(r.id, 6)}`), h('span', { class: r.finalized ? 't-go' : 'dim' }, r.finalized ? 'ready to claim' : `waiting for Lido${r.at ? `, asked ${ago(r.at)}` : ''}`)),
          h('span', { class: 'tk-v' }, h('b', null, steth(r.amount)), claim ?? h('span', { class: 'dim' }, 'not yet')));
      }),
    ];
    list.replaceChildren(...rows);
  } catch (e) { list.replaceChildren(h('p', { class: 't-red' }, e.message)); }
}

/** The last look before a stake, a request or a claim: on Ethereum, what you give and get, each step, what the
 * simulation shows changing; then your yes. */
function review(prep, { back }) {
  const titles = { stake: 'staking', request: 'asking for ETH back', claim: 'claiming' };
  const go2 = h('button', { class: 'btn-go block lg', type: 'button', dataset: { busyText: prep.approval ? 'approving, then sending' : 'signing' } }, { stake: 'stake it ->', request: 'ask for it ->', claim: 'claim it ->' }[prep.action]);
  const err = errLine();
  // a Ledger signs each step after this: its state, live, while plum waits on it
  const device = isLedgerWallet(active()) ? deviceBox('Ethereum', { hidden: true }) : null;
  busyButton(go2, async () => {
    err.hidden = true;
    device?.watch();
    try {
      const done = await call('lido.submit', { id: prep.id });
      device?.stop();
      ctx.bal.clear();
      sent(done, prep);
    } catch (e) { if (!device?.failed(e)) showErr(err, e); }
  });
  show(...screen('review', null,
    box(titles[prep.action], { tone: 'ink', side: netLoud('ethereum') },
      kv('on', 'ethereum (chain 1)', 'loud'),
      kv('you give', prep.pay),
      kv('you get', prep.get),
      kv('steps', prep.approval ? `approve exactly ${prep.approval.amount} stETH, then ask` : 'one transaction'),
      prep.approval ? kv('spender', `lido's queue ${short(prep.approval.spender, 4)}`) : null),
    previewBlock(prep.preview, { extra: prep.warnings }),
    device?.node, err, actions(back, go2)));
}

/** After a step: its transactions as they went out, the last turning until it lands. */
function sent(done, prep) {
  const status = h('span', { class: 'r' }, spinner());
  show(...screen('sent', null, h('ol', { class: 'log' },
    ...done.approvals.map((a) => h('li', null, h('span', null, `approved exactly ${prep.approval?.amount ?? ''} stETH  ${short(a, 4)}`), h('span', { class: 'r' }, 'ok'))),
    h('li', null, h('span', null, 'signed, by you alone'), h('span', { class: 'r' }, 'ok')),
    h('li', null, h('span', null, `sent  ${short(done.signature, 6)}`), h('span', { class: 'r' }, 'ok')),
    h('li', null, h('span', null, 'in a block'), status)),
  h('div', { class: 'actions' }, h('a', { class: 'btn', href: done.explorer, target: '_blank', rel: 'noreferrer noopener' }, done.explorerName ?? 'etherscan'), h('button', { class: 'btn-go', type: 'button', onclick: () => go.home() }, 'done ->'))));
  const until = Date.now() + 180_000;
  const tick = async () => {
    if (!status.isConnected) return;
    const s = await call('tx.status', { signature: done.signature }).catch(() => null);
    if (s?.status === 'confirmed') { status.textContent = 'ok'; return; }
    if (s?.status === 'failed') { status.textContent = 'failed'; status.classList.add('t-red'); return; }
    if (Date.now() > until) { status.textContent = 'not seen yet'; status.classList.add('t-gold'); return; }
    setTimeout(tick, 1500);
  };
  tick();
}
