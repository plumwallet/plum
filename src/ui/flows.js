// Every way a wallet comes into plum, right here in the popup (no tab of its own): a new recovery phrase, a phrase you
// already have (and every wallet it holds, found on Solana, Ethereum and Bitcoin), or one private key. The same steps
// serve your first wallet (no head yet, and a password to seal the vault) and every account you add later (from
// accounts, under the head). A new phrase is sealed into the vault the moment it's made, so if the popup closes while
// you write the words down, nothing is lost: home reminds you to finish backing it up.
import { prettyAmount, short } from '../shared/format.js';
import { call } from './api.js';
import { logo, readyArt } from './art.js';
import { busyButton, h } from './dom.js';
import { ctx, errLine, field, forget, frame, go, screen, show, showErr } from './app.js';
import { CHAIN, CHAIN_ORDER, actions, box, haveOne, iconPicker, kv, secretField, seg } from './parts.js';

const goButton = (label, busyText) => h('button', { class: 'btn-go', type: 'button', dataset: busyText ? { busyText } : null }, label);

/* ------------------------------------------------------------ pieces the steps share */

/** The icon square (centred at the top of the step) and a name under it. */
function nameAndIcon({ name = '', icon = null, label = 'name', placeholder = 'a name (optional)' } = {}) {
  const input = h('input', { class: 'input', maxlength: '20', placeholder, value: name, autocomplete: 'off', spellcheck: 'false' });
  const picker = iconPicker(icon);
  return { icon: picker.node, nodes: [field(label, input)], name: () => input.value.trim(), iconId: () => picker.value() };
}

/** How long a new phrase is: 12 words (the usual) or 24. */
function wordsChoice(current = 12) {
  let words = current;
  return { node: field('recovery phrase', seg([[12, '12 words'], [24, '24 words']], current, (v) => { words = v; }, { label: 'how many words' })), value: () => words };
}

/** The vault's password: any text, blank included (a secretField: [ show ], a caps lock warning). */
function passwordField() {
  const pw = secretField({ placeholder: 'a password' });
  return { nodes: [field('password', pw.node)], value: () => pw.input.value };
}

/** A phrase's words, numbered, hidden until asked for. */
function phraseGrid(phrase) {
  const words = phrase.split(' ');
  let shown = false;
  const grid = h('ol', { class: `words hidden ${words.length > 12 ? 'long' : ''}` }, words.map((w, i) => h('li', null, h('span', { class: 'n' }, String(i + 1).padStart(2, ' ')), h('b', null, w))));
  const reveal = h('button', { class: 'btn', type: 'button' }, 'show the words');
  reveal.addEventListener('click', () => { shown = !shown; grid.classList.toggle('hidden', !shown); reveal.textContent = shown ? 'hide the words' : 'show the words'; });
  return [h('div', { class: 'fr red words-box' }, grid), h('div', { class: 'row centred' }, reveal)];
}

/** The wallets a scan found in a phrase, as switches: the ones with funds or history are on. { node, picks() } */
function foundPicker(found) {
  const key = (f) => `${f.scheme}:${f.index}`;
  const chosen = new Set(found.filter((f) => f.used).map(key));
  if (!chosen.size && found[0]) chosen.add(key(found[0]));
  const holdings = (f) => {
    const parts = CHAIN_ORDER.filter((c) => f.chains[c]?.used).map((c) => `${prettyAmount(BigInt(f.chains[c].amount ?? 0), CHAIN[c].decimals, { sig: 4 })} ${CHAIN[c].ticker}`);
    if (parts.length) return parts.join(' · ');
    return f.unknown ? '?' : 'empty';
  };
  const rows = found.map((f) => {
    const first = f.chains.sol?.address ?? f.chains.eth?.address ?? f.chains.btc?.address;
    const label = f.scheme === 'bip44change' ? `wallet ${f.index + 1}` : f.scheme === 'cli' ? 'cli wallet' : `old wallet ${f.index + 1}`;
    const t = h('button', { class: `toggle acct-pick ${chosen.has(key(f)) ? 'on' : ''}`, type: 'button', 'aria-pressed': String(chosen.has(key(f))), title: Object.values(f.chains).map((c) => c.path ?? 'cli (no path)').join('  ') },
      h('span', { class: 'pk-l' }, h('b', null, label), ' ', h('span', { class: 'dim' }, short(first, 4))),
      h('span', { class: `pk-r ${f.used ? 't-go' : 'dim'}` }, holdings(f)));
    t.addEventListener('click', () => {
      if (chosen.has(key(f))) chosen.delete(key(f)); else chosen.add(key(f));
      t.classList.toggle('on', chosen.has(key(f)));
      t.setAttribute('aria-pressed', String(chosen.has(key(f))));
    });
    return t;
  });
  const used = found.filter((f) => f.used).length;
  const unknown = CHAIN_ORDER.filter((c) => found.some((f) => f.chains[c] && f.chains[c].used == null));
  return {
    node: h('div', { class: 'stack tight' },
      h('p', { class: 'dim' }, used ? `${used} wallet${used === 1 ? '' : 's'} with funds or history, picked. Add or remove any.` : 'nothing used yet: wallet 1 is picked.'),
      unknown.length ? h('p', { class: 't-gold' }, `couldn't check ${unknown.map((c) => CHAIN[c].name).join(' and ')} just now`) : null,
      h('div', { class: 'picks' }, rows)),
    picks: () => found.filter((f) => chosen.has(key(f))).map((f) => ({ scheme: f.scheme, index: f.index })),
  };
}

/** Steps before the first wallet use `frame` (no head); later ones a screen under the head. */
function step(first, title, stepText, { back, next }, ...children) {
  if (first) { frame(title, { step: stepText, back, next }, ...children); return; }
  show(...screen(title, stepText, ...children, actions(back, next)));
}

/* ------------------------------------------------------------ the welcome (no wallet yet) */

export function welcome() {
  show(
    h('div', { class: 'hero' }, logo()),
    box('new here', { tone: 'soft' },
      h('div', { class: 'stack' },
        h('button', { class: 'btn-go block framed', type: 'button', onclick: () => createWallet({ first: true }) }, 'create a new wallet ->'),
        ...haveOne({ phrase: () => importPhrase({ first: true }), key: () => importKey({ first: true }) }))),
    h('p', { class: 'fine' }, 'your keys are sealed on this computer (scrypt + AES-256-GCM) and never leave it.'));
}

/* ------------------------------------------------------------ a new recovery phrase */

/**
 * A new phrase: as your first wallet (`first`: with a password, named by you) or as another account (named by you,
 * its first wallet wearing the icon). The phrase is made and sealed in the background; its words come back once, to
 * write down.
 */
export function createWallet({ first = false, keep = {} } = {}) {
  const who = nameAndIcon({ ...keep, label: first ? 'name' : 'account name' });
  const words = wordsChoice(keep.words ?? 12);
  const pw = first ? passwordField() : null;
  const err = errLine();
  const next = goButton('next ->', 'sealing your vault');
  const back = () => (first ? welcome() : go.accounts());
  busyButton(next, async () => {
    err.hidden = true;
    try {
      const params = { words: words.value(), name: who.name(), icon: who.iconId() };
      const made = first ? await call('create', { ...params, password: pw.value() }) : await call('account.new', params);
      ctx.S = made.state;
      forget();
      backup({ first, phrase: made.phrase, account: first ? ctx.S.accounts[0].id : made.account, stepText: 'step 2 of 2' });
    } catch (e) { showErr(err, e); }
  });
  step(first, first ? 'create a wallet' : 'new account', 'step 1 of 2', { back, next },
    who.icon, ...who.nodes, words.node, ...(pw ? pw.nodes : []), err);
}

/** Writing a phrase down: its words (hidden until asked for), and once they're written, done. */
export function backup({ first = false, phrase, account, stepText = null }) {
  const saved = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false' }, 'i wrote them down, in order, somewhere safe');
  const err = errLine();
  const done = goButton('done ->');
  done.disabled = true;
  saved.addEventListener('click', () => { const on = !saved.classList.contains('on'); saved.classList.toggle('on', on); saved.setAttribute('aria-pressed', String(on)); done.disabled = !on; });
  busyButton(done, async () => {
    err.hidden = true;
    try {
      ctx.S = await call('account.backedUp', { id: account });
      if (first) ready(); else go.accounts();
    } catch (e) { showErr(err, e); }
  });
  const parts = [...phraseGrid(phrase), saved, err];
  if (first) frame('your recovery phrase', { step: stepText, next: done }, ...parts);
  else show(...screen('recovery phrase', stepText, ...parts, actions(null, done)));
}

/** Backing up a phrase later (home's reminder): the password first, then the words. */
export function backupLater(account) {
  const pwF = secretField({ placeholder: 'your password' });
  const err = errLine();
  const next = goButton('show the words ->', 'checking');
  busyButton(next, async () => {
    err.hidden = true;
    try {
      const phrase = await call('account.phrase', { id: account.id, password: pwF.input.value });
      pwF.input.value = '';
      backup({ phrase, account: account.id, stepText: account.name });
    } catch (e) { showErr(err, e); }
  });
  show(...screen('back up', () => go.home(),
    h('p', null, `${account.name}'s recovery phrase isn't written down yet. Without it, losing this computer loses its wallets.`),
    field('password', pwF.node), err, actions(() => go.home(), next)));
}

/** "plum is ready", in the logo's letters, then your wallet. */
function ready() {
  const next = goButton('open your wallet ->');
  next.addEventListener('click', () => go.home());
  frame('plum is ready', { next }, h('div', { class: 'ready' }, readyArt()));
}

/* ------------------------------------------------------------ a recovery phrase you already have */

/** Bring a phrase: plum looks for every wallet it holds (on Solana, Ethereum and Bitcoin), then you pick. */
export function importPhrase({ first = false, phrase = '' } = {}) {
  const text = h('textarea', { class: 'textarea', rows: '3', spellcheck: 'false', autocomplete: 'off', placeholder: 'your 12 or 24 words, with spaces between' });
  text.value = phrase;
  const err = errLine();
  const next = goButton('next ->', 'looking for your wallets');
  busyButton(next, async () => {
    err.hidden = true;
    const words = text.value.trim();
    try {
      if (!(await call('checkMnemonic', { mnemonic: words }))) throw new Error("that recovery phrase isn't valid: check the words, their spelling and their order");
      pickWallets({ first, phrase: words, found: await call('scanPhrase', { mnemonic: words }) });
    } catch (e) { showErr(err, e); }
  });
  step(first, first ? 'restore a wallet' : 'import an account', 'step 1 of 2', { back: () => (first ? welcome() : go.accounts()), next },
    field('recovery phrase', text), err);
}

function pickWallets({ first, phrase, found }) {
  const who = nameAndIcon({ label: first ? 'name' : 'account name' });
  const picker = foundPicker(found);
  const pw = first ? passwordField() : null;
  const err = errLine();
  const next = goButton(first ? 'restore plum ->' : 'import ->', 'sealing your vault');
  busyButton(next, async () => {
    err.hidden = true;
    try {
      const picks = picker.picks();
      if (!picks.length) throw new Error('pick at least one wallet');
      const params = { mnemonic: phrase, picks, name: who.name(), icon: who.iconId() };
      ctx.S = first ? await call('restore', { ...params, password: pw.value() }) : await call('account.import', params);
      forget();
      if (first) ready(); else go.home();
    } catch (e) { showErr(err, e); }
  });
  step(first, first ? 'your wallets' : 'its wallets', 'step 2 of 2', { back: () => importPhrase({ first, phrase }), next },
    who.icon, ...who.nodes, picker.node, ...(pw ? pw.nodes : []), err);
}

/* ------------------------------------------------------------ one private key */

/** A private key (Solana, Ethereum or Bitcoin: plum tells which from its shape), checked before anything's kept. */
export function importKey({ first = false } = {}) {
  const secret = secretField({ placeholder: 'enter private key', caps: false });
  const err = errLine();
  const next = goButton('next ->', 'checking');
  busyButton(next, async () => {
    err.hidden = true;
    try { keyDetails({ first, secret: secret.input.value, info: await call('checkKey', { secret: secret.input.value }) }); } catch (e) { showErr(err, e); }
  });
  step(first, 'import a private key', 'step 1 of 2', { back: () => (first ? welcome() : go.accounts()), next },
    field('private key', secret.node, 'solana, ethereum or bitcoin'), err);
}

function keyDetails({ first, secret, info }) {
  const who = nameAndIcon();
  const pw = first ? passwordField() : null;
  const err = errLine();
  const next = goButton('import ->', 'sealing your vault');
  busyButton(next, async () => {
    err.hidden = true;
    try {
      ctx.S = await call('importKey', { secret, name: who.name(), icon: who.iconId(), ...(first ? { password: pw.value() } : {}) });
      forget();
      if (first) ready(); else go.home();
    } catch (e) { showErr(err, e); }
  });
  step(first, 'import a private key', 'step 2 of 2', { back: () => importKey({ first }), next },
    who.icon, kv(CHAIN[info.chain].name, short(info.address, 6)), info.taproot ? kv('bitcoin taproot', short(info.taproot, 6)) : null, ...who.nodes, ...(pw ? pw.nodes : []), err);
}
