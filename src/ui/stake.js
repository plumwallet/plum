// Staking, in the popup: your stake accounts (what each holds, what it's doing, what it earned last epoch) and the
// steps: stake SOL with a validator picked from the chain's own list, unstake, withdraw. The background builds and
// simulates each step; it's reviewed here like a send, then signed by your wallet alone.
import { formatUnits, prettyAmount, short } from '../shared/format.js';
import { call } from './api.js';
import { active, ctx, errLine, field, forget, go, show, screen, showErr } from './app.js';
import { busyButton, h } from './dom.js';
import { deviceBox, isLedgerWallet } from './ledger.js';
import { lidoScreen, stakeNetSeg } from './lido.js';
import { actions, addressBlock, box, kv, previewBlock, spinner } from './parts.js';

const sol = (lamports, sig = 6) => `${prettyAmount(BigInt(lamports), 9, { sig })} SOL`;
/** A stake account's state in a word, and its colour. */
const STATE = {
  active: ['earning', 't-go'],
  activating: ['starts next epoch', 't-gold'],
  deactivating: ['unstaking', 't-gold'],
  inactive: ['withdrawable', ''],
  undelegated: ['not staked', ''],
};
/** A wait, roughly: "about 5h". */
const about = (s) => (s < 3600 ? `about ${Math.max(1, Math.round(s / 60))}m` : s < 2 * 86400 ? `about ${Math.round(s / 3600)}h` : `about ${Math.round(s / 86400)}d`);
/** A big amount of SOL, short: 12.3M SOL. */
const bigSol = (lamports) => {
  const v = Number(BigInt(lamports) / 1_000_000_000n);
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M SOL` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K SOL` : `${v} SOL`;
};

/** The validators, read once a popup (the chain's list is large). */
let validatorList = null;
const loadValidators = () => (validatorList ??= call('stake.validators').catch((e) => { validatorList = null; throw e; }));

/** A validator in words: its name when it publishes one, and its vote account. */
const who = (v) => (v?.name ? `${v.name}` : short(v?.vote ?? '', 6));

/* ------------------------------------------------------------ your stake */

export async function stakeScreen({ net = null } = {}) {
  const w = active();
  // SOL here; ETH with Lido in lido.js, picked at the top of either
  if (net === 'eth' || (net == null && !w.chains.sol && w.chains.eth)) { lidoScreen({ top: stakeNetSeg(w, 'eth') }); return; }
  if (!w.chains.sol) { show(...screen('stake', () => go.home(), h('div', { class: 'note' }, `staking is on Solana and Ethereum, and ${w.name} has neither address (it's an imported key).`))); return; }
  const list = h('div', { class: 'tks' }, h('p', { class: 'empty', 'aria-label': 'reading' }, spinner()));
  const total = h('span', { class: 'dim' });
  const foot = h('p', { class: 'fine' });
  const err = errLine();
  const again = h('button', { class: 'mini', type: 'button', title: 'read your stake again' }, 'refresh');
  const next = h('button', { class: 'btn-go', type: 'button', onclick: () => pickValidator() }, 'stake SOL ->');
  show(...screen('stake', () => go.home(), stakeNetSeg(w, 'sol'),
    box('your stake', { tone: 'soft', side: h('span', { class: 'head-side' }, total, again) }, list),
    foot, err, actions(() => go.home(), next)));
  loadValidators().catch(() => {});
  const load = async () => {
    again.disabled = true;
    again.replaceChildren(spinner());
    try {
      const o = await call('stake.list');
      if (!list.isConnected) return;
      const v = await loadValidators().catch(() => null);
      const named = (vote) => v?.list.find((x) => x.vote === vote) ?? (vote ? { vote } : null);
      const staked = o.accounts.reduce((n, a) => n + BigInt(a.lamports), 0n);
      total.textContent = o.accounts.length ? sol(staked) : '';
      list.replaceChildren(...o.accounts.map((a) => accountRow(a, named(a.vote), o)));
      if (!o.accounts.length) list.append(h('p', { class: 'dim empty' }, 'nothing staked yet'));
      foot.textContent = `epoch ${o.epoch} ends in ${about(o.epochEndsIn)}. Staked SOL earns from the next epoch on; unstaked SOL can be withdrawn once the epoch it was unstaked in has ended.`;
    } catch (e) {
      if (list.isConnected) list.replaceChildren(h('p', { class: 't-red empty' }, e.message));
    } finally {
      again.disabled = false;
      again.textContent = 'refresh';
    }
  };
  again.addEventListener('click', load);
  load();
}

/** One stake account in a line: what it holds and what it's doing; its validator and last epoch's reward under it. */
function accountRow(a, validator, o) {
  const [word, tone] = STATE[a.state] ?? [a.state, ''];
  const reward = a.reward && BigInt(a.reward.amount) > 0n ? `+${prettyAmount(BigInt(a.reward.amount), 9, { sig: 4 })} last epoch` : a.state === 'active' ? 'no reward yet' : '';
  return h('button', { class: 'tk plain', type: 'button', title: 'open this stake account', onclick: () => accountScreen(a, validator, o) },
    h('span', { class: 'tk-n' }, h('b', null, sol(a.lamports)), h('span', null, validator ? who(validator) : 'no validator')),
    h('span', { class: 'tk-v' }, h('b', { class: tone }, word), h('span', null, reward)));
}

/** A stake account, opened: everything about it, and the step it's ready for (unstake, or withdraw). */
function accountScreen(a, validator, o) {
  const [word, tone] = STATE[a.state] ?? [a.state, ''];
  const err = errLine();
  const step = a.canUnstake ? 'unstake' : a.canWithdraw ? 'withdraw' : null;
  const next = step ? h('button', { class: 'btn-go', type: 'button', dataset: { busyText: 'simulating' } }, `${step} ->`) : null;
  if (next) {
    busyButton(next, async () => {
      err.hidden = true;
      try { review(await call('stake.prepare', { action: step, account: a.address }), { validator, back: () => accountScreen(a, validator, o) }); } catch (e) { showErr(err, e); }
    });
  }
  const me = active().chains.sol.address;
  const role = (addr) => (addr === me ? 'you' : short(addr, 6));
  const why = step ? null : waiting(a, o);
  show(...screen('stake account', () => stakeScreen(),
    box(null, { tone: 'soft' },
      kv('holds', sol(a.lamports, 9)),
      kv('state', h('span', { class: tone }, word)),
      validator ? kv('validator', who(validator)) : null,
      BigInt(a.effective) > 0n && a.state !== 'deactivating' ? kv('earning on', sol(a.effective, 9)) : null,
      BigInt(a.activating) > 0n ? kv('starts earning', sol(a.activating, 9)) : null,
      BigInt(a.deactivating) > 0n ? kv('unstaking', sol(a.deactivating, 9)) : null,
      a.reward ? kv(`reward, epoch ${a.reward.epoch}`, `+${sol(a.reward.amount, 9)}`) : null,
      kv('kept for rent', sol(a.rentReserve, 9)),
      kv('staker', role(a.staker)),
      kv('withdrawer', role(a.withdrawer))),
    h('div', { class: 'label' }, 'stake account'),
    addressBlock(a.address, { copy: true }),
    why ? h('p', { class: 'fine' }, why) : null,
    err, actions(() => stakeScreen(), next)));
}

/** Why a stake account has no step to take now, in words. */
function waiting(a, o) {
  if (a.state === 'deactivating') return `it can be withdrawn once this epoch ends (${about(o.epochEndsIn)})`;
  if (a.locked) return 'it is locked up: it can be withdrawn when its lockup ends';
  if (a.state === 'active' || a.state === 'activating') return "this wallet isn't its staker, so it can't unstake it";
  return "this wallet isn't its withdrawer, so it can't withdraw it";
}

/* ------------------------------------------------------------ staking: pick a validator, say how much */

const SHOWN = 20;

/** The validators, ranked by the background (voting, not skipping blocks, low commission first; the biggest after the
 * rest), searchable by name or address. */
async function pickValidator() {
  const q = h('input', { class: 'input', placeholder: 'search a name or a vote address', spellcheck: 'false', autocomplete: 'off' });
  const rows = h('div', { class: 'tks' }, h('p', { class: 'empty', 'aria-label': 'reading' }, spinner()));
  const note = h('p', { class: 'fine' }, 'ranked by what their stakers earned last epoch, after commission. Validators that skip blocks, stopped voting or keep every reward are left out of the list; the few that hold a third of all stake come after the rest, so stake stays spread out.');
  show(...screen('pick a validator', () => stakeScreen(), q, box(null, { tone: 'soft' }, rows), note));
  q.focus();
  let all;
  try { all = (await loadValidators()).list; } catch (e) { rows.replaceChildren(h('p', { class: 't-red empty' }, e.message)); return; }
  const paint = () => {
    const text = q.value.trim().toLowerCase();
    const found = text ? all.filter((v) => (v.name ?? '').toLowerCase().includes(text) || v.vote.toLowerCase().startsWith(text) || v.identity.toLowerCase().startsWith(text)).slice(0, 50) : all.filter((v) => v.suggested).slice(0, SHOWN);
    rows.replaceChildren(...found.map(validatorRow));
    if (!found.length) rows.append(h('p', { class: 'dim empty' }, 'no validator by that name or address'));
  };
  q.addEventListener('input', paint);
  paint();
}

/** A validator in a line: its name (or address), what it takes, how it votes and how much it holds. */
function validatorRow(v) {
  const second = [short(v.vote, 4), bigSol(v.stake), v.large ? 'big' : null].filter(Boolean).join(' · ');
  const skips = v.skip != null ? `skips ${(v.skip * 100).toFixed(1)}%` : '';
  return h('button', { class: 'tk plain', type: 'button', onclick: () => stakeAmount(v) },
    h('span', { class: 'tk-n' }, h('b', null, who(v)), h('span', null, second)),
    h('span', { class: 'tk-v' }, h('b', { class: v.commission > 10 ? 't-gold' : '' }, `${v.commission}% fee`),
      h('span', { class: v.suggested ? '' : 't-red' }, v.suggested ? skips : v.why[0])));
}

/** How much to stake with a validator. */
async function stakeAmount(v, amount = '') {
  const w = active();
  const amtIn = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', value: amount });
  const have = h('span', { class: 'dim' });
  const hint = h('p', { class: 'fine' });
  const err = errLine();
  const max = h('button', { class: 'mini', type: 'button', disabled: true }, 'max');
  const next = h('button', { class: 'btn-go block', type: 'button', dataset: { busyText: 'simulating' } }, 'review ->');
  busyButton(next, async () => {
    err.hidden = true;
    try {
      const prep = await call('stake.prepare', { action: 'stake', vote: v.vote, amount: amtIn.value.trim() });
      review(prep, { validator: v, back: () => stakeAmount(v, formatUnits(BigInt(prep.summary.stake), 9)) });
    } catch (e) { showErr(err, e); }
  });
  show(...screen('stake', () => pickValidator(),
    box('validator', { tone: 'soft' },
      kv('name', v.name ?? 'none published'),
      kv('commission', `${v.commission}%`, v.commission > 10 ? 'warn' : ''),
      v.skip != null ? kv('skipped blocks', `${(v.skip * 100).toFixed(1)}%`) : null,
      kv('stake it holds', bigSol(v.stake)),
      v.large ? h('p', { class: 'fine' }, 'one of the few validators that together hold a third of all stake') : null,
      v.suggested ? null : h('div', { class: 'note hot' }, `plum leaves it off its list: it ${v.why.join(', ')}`),
      addressBlock(v.vote)),
    field('amount', h('div', { class: 'input-group' }, amtIn, h('span', { class: 'suffix-btn' }, max)), have),
    hint, err, actions(() => pickValidator(), next)));
  amtIn.focus();
  try {
    const [b, terms] = await Promise.all([ctx.bal.get(`${w.id}:sol`) ?? call('balances', { chain: 'sol' }), loadValidators()]);
    const balance = BigInt(b.native.amount);
    have.textContent = `have ${prettyAmount(balance, 9)} SOL`;
    hint.textContent = `the network's smallest stake is ${formatUnits(BigInt(terms.minimum), 9)} SOL. ${sol(terms.rent, 9)} more stays in the stake account for rent, and comes back when you withdraw; plum leaves ${sol(terms.keep, 9)} in your wallet for the fees of unstaking later.`;
    // everything but the account's rent and a little for later fees
    const most = balance - BigInt(terms.rent) - BigInt(terms.keep);
    max.disabled = most <= 0n;
    max.addEventListener('click', () => { amtIn.value = formatUnits(most > 0n ? most : 0n, 9); });
  } catch { /* the review says what's wrong */ }
}

/* ------------------------------------------------------------ the review: what it does, simulated, then your yes */

const VERB = { stake: 'stake it ->', unstake: 'unstake it ->', withdraw: 'withdraw it ->' };

function review(prep, { validator = null, back }) {
  const s = prep.summary;
  const dangers = [...(prep.warnings ?? []), ...(prep.preview?.warnings ?? [])].some((x) => x.level === 'danger');
  const ack = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false' }, 'i understand the risk, sign anyway');
  const next = h('button', { class: 'btn-go block lg', type: 'button', dataset: { busyText: 'signing' }, disabled: dangers }, VERB[s.action]);
  ack.addEventListener('click', () => { const on = !ack.classList.contains('on'); ack.classList.toggle('on', on); ack.setAttribute('aria-pressed', String(on)); next.disabled = !on; });
  const err = errLine();
  // a Ledger signs it after this: its state, live, while plum waits on it
  const device = isLedgerWallet(active()) ? deviceBox('Solana', { hidden: true }) : null;
  busyButton(next, async () => {
    err.hidden = true;
    device?.watch();
    try {
      const done = await call('stake.submit', { id: prep.id });
      device?.stop();
      forget();
      go.sent(done);
    } catch (e) { if (!device?.failed(e)) showErr(err, e); }
  });
  const v = validator ?? (s.vote ? { vote: s.vote } : null);
  const summary = {
    stake: () => box('staking', { tone: 'ink' },
      kv('you stake', sol(s.stake, 9)),
      kv('with', who(v)),
      kv('stake account', `${short(s.account, 6)} (new)`),
      kv('kept for rent', sol(s.rent, 9)),
      kv('starts earning', `next epoch (${about(s.startsIn)})`),
      h('p', { class: 'fine' }, 'the stake account is made from your wallet and a seed, so your wallet is its only key: it stakes, unstakes and withdraws it.')),
    unstake: () => box('unstaking', { tone: 'ink' },
      kv('you unstake', sol(s.stake, 9)),
      v ? kv('from', who(v)) : null,
      kv('stake account', short(s.account, 6)),
      kv('stops earning', `in ${about(s.endsIn)}`),
      h('p', { class: 'fine' }, 'then withdraw it from your stake.')),
    withdraw: () => box('withdrawing', { tone: 'ink' },
      kv('you withdraw', sol(s.lamports, 9)),
      kv('stake account', short(s.account, 6)),
      kv('to', 'your wallet'),
      h('p', { class: 'fine' }, 'everything in it comes back, and the stake account closes.')),
  }[s.action]();
  show(...screen('review', null, summary,
    previewBlock(prep.preview, { extra: prep.warnings }),
    device?.node, dangers ? ack : null, err, actions(back, next)));
}
