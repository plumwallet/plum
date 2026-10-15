// A Ledger in software, for tests: the dashboard and the Solana, Ethereum and Bitcoin apps, answering the APDUs plum
// sends the way the real apps do (plum's encodings are checked against the real apps in Speculos, see
// scripts/ledger-speculos.mjs; this one is for driving plum's own logic). Its keys come from a recovery phrase. It can
// be unplugged, locked, showing another app, made to wait for a button press, or made to lie (`lie` hooks).
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { HDKey } from '@scure/bip32';
import { base58Decode } from '../src/shared/base58.js';
import { concat, hex, utf8 } from '../src/shared/bytes.js';
import { addressOf, secretAt, seedOf, signSol } from '../src/background/keys.js';
import { LedgerError } from '../src/background/ledger/apdu.js';
import { legacyDigest } from '../src/background/bip322.js';
import { personalDigest } from '../src/background/eth.js';
import { policyId, taprootPolicy } from '../src/background/ledger/bitcoin.js';
import { signKeyPath, taprootAddressOf } from '../src/background/taproot.js';

export const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HARD = 0x80000000;

/** "m/..." from the steps a command carries. */
function readPath(d, at = 0) {
  const n = d[at];
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(new DataView(d.buffer, d.byteOffset).getUint32(at + 1 + 4 * i, false));
  return { path: `m/${steps.map((s) => (s >= HARD ? `${s - HARD}'` : String(s))).join('/')}`, next: at + 1 + 4 * n };
}

const ok = (data = new Uint8Array(0)) => concat(data, Uint8Array.of(0x90, 0x00));
const sw = (code) => Uint8Array.of(code >> 8, code & 0xff);

export function fakeLedger({ mnemonic = ABANDON, app = 'Solana' } = {}) {
  const seed = seedOf(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const dev = {
    app,
    versions: { Solana: '1.15.2', Ethereum: '1.23.0', Bitcoin: '2.5.1', BOLOS: '1.6.0' },
    connected: true,
    locked: false,
    /** what the next review gets: 'approve', 'reject', or 'wait' (until press()) */
    decide: 'approve',
    /** lies, by name: solAddress, solSig, ethAddressText, ethPub, ethSig, btcFingerprint, btcAddress, btcYield */
    lie: {},
    /** every APDU it was sent (hex), and how many reviews it showed */
    log: [],
    reviews: 0,
    /** the digest a field-by-field EIP-712 signature covers (the test sets it from plum's own hashing) */
    typedDigest: null,
    /** Bitcoin: the sighashes the device signs, in input order (the test sets them from plum's own) */
    btcDigests: null,
    openRequests: 0,
    waiting: null,
    press(answer = 'approve') { const w = this.waiting; this.waiting = null; w?.(answer); },
  };

  const decision = () => {
    dev.reviews++;
    if (dev.decide !== 'wait') return Promise.resolve(dev.decide);
    return new Promise((r) => { dev.waiting = r; });
  };
  const ethKey = (path) => root.derive(path).privateKey;
  const ethSig = (digest, path, base) => {
    const s = secp256k1.sign(digest, ethKey(path), { prehash: false, format: 'recovered' });
    const out = concat(Uint8Array.of(base + s[0]), s.slice(1, 33), s.slice(33, 65));
    return dev.lie.ethSig ? dev.lie.ethSig(out) : out;
  };

  // multi-APDU commands in progress
  let solBuf = null, ethTx = null, ethMsg = null, typed = [];
  let yields = null;

  async function solana(ins, p1, p2, data) {
    if (ins === 0x04) return ok(Uint8Array.of(0, 0, 1, 15, 2));
    if (ins === 0x05) {
      const { path } = readPath(data);
      const secret = secretAt(seed, 'sol', path);
      let pub = base58Decode(addressOf('sol', secret));
      if (dev.lie.solAddress) pub = dev.lie.solAddress(pub, path);
      if (p1 === 1 && (await decision()) !== 'approve') return sw(0x6985);
      return ok(pub);
    }
    if (ins === 0x06 || ins === 0x07) {
      solBuf = p2 & 0x01 ? concat(solBuf ?? new Uint8Array(0), data) : data;
      if (p2 & 0x02) return ok();
      const all = solBuf;
      solBuf = null;
      const { path, next } = readPath(all, 1);
      const message = all.subarray(next);
      if (ins === 0x06 && message[0] === 0x81) return sw(0x6a80);
      if (ins === 0x07 && !(message[0] === 0xff && message[16] === 0)) return sw(0x6a81);
      if ((await decision()) !== 'approve') return sw(0x6982);
      let sig = signSol(message, secretAt(seed, 'sol', path));
      if (dev.lie.solSig) sig = dev.lie.solSig(sig, message);
      return ok(sig);
    }
    return sw(0x6d00);
  }

  async function ethereum(ins, p1, p2, data) {
    if (ins === 0x06) return ok(Uint8Array.of(0x00, 1, 23, 0));
    if (ins === 0x02) {
      const { path } = readPath(data);
      let pub = secp256k1.getPublicKey(ethKey(path), false);
      if (dev.lie.ethPub) pub = dev.lie.ethPub(pub);
      let text = addressOf('eth', ethKey(path)).slice(2);
      if (dev.lie.ethAddressText) text = dev.lie.ethAddressText(text);
      if (p1 === 1 && (await decision()) !== 'approve') return sw(0x6985);
      return ok(concat(Uint8Array.of(65), pub, Uint8Array.of(40), utf8(text)));
    }
    if (ins === 0x04) {
      if (p1 === 0x00) { const { path, next } = readPath(data); ethTx = { path, bytes: data.slice(next) }; } else ethTx.bytes = concat(ethTx.bytes, data);
      const b = ethTx.bytes;
      const lenOfLen = b[1] >= 0xf8 ? b[1] - 0xf7 : 0;
      const body = lenOfLen ? Number.parseInt(hex(b.subarray(2, 2 + lenOfLen)), 16) : b[1] - 0xc0;
      if (b.length < 2 + lenOfLen + body) return ok();
      const { path, bytes } = ethTx;
      ethTx = null;
      if (dev.lie.ethNeedsBlind) return sw(0x6a80);
      if ((await decision()) !== 'approve') return sw(0x6985);
      return ok(ethSig(keccak_256(bytes), path, 0));
    }
    if (ins === 0x08) {
      if (p1 === 0x00) {
        const { path, next } = readPath(data);
        const len = new DataView(data.buffer, data.byteOffset).getUint32(next, false);
        ethMsg = { path, len, bytes: data.slice(next + 4) };
      } else ethMsg.bytes = concat(ethMsg.bytes, data);
      if (ethMsg.bytes.length < ethMsg.len) return ok();
      const { path, bytes } = ethMsg;
      ethMsg = null;
      if ((await decision()) !== 'approve') return sw(0x6985);
      return ok(ethSig(personalDigest(bytes), path, 27));
    }
    if (ins === 0x1a || ins === 0x1c) { typed.push([ins, p1, p2, hex(data)]); return ok(); }
    if (ins === 0x0c) {
      const { path, next } = readPath(data);
      let digest;
      if (p2 === 0x00) digest = keccak_256(concat(Uint8Array.of(0x19, 0x01), data.subarray(next, next + 32), data.subarray(next + 32, next + 64)));
      else { digest = dev.typedDigest; dev.typedApdus = typed; typed = []; }
      if (!digest) return sw(0x6a80);
      if ((await decision()) !== 'approve') return sw(0x6985);
      return ok(ethSig(digest, path, 27));
    }
    return sw(0x6d00);
  }

  const btcNode = (path) => root.derive(path);
  // the two default policies it knows, by their ids: native segwit (m/84') and taproot (m/86')
  const fpr = root.fingerprint.toString(16).padStart(8, '0');
  const TAPROOT_ID = hex(policyId(taprootPolicy(fpr, root.derive("m/86'/0'/0'").publicExtendedKey)));
  async function bitcoin(cla, ins, p1, p2, data) {
    if (cla === 0xf8) {
      // CONTINUE: the next thing it yields, or done
      if (!yields) return sw(0xb007);
      if (yields.length) return concat(Uint8Array.of(0x10), yields.shift(), sw(0xe000));
      yields = null;
      return ok();
    }
    if (ins === 0x05) return ok(dev.lie.btcFingerprint ?? Uint8Array.from(root.fingerprint.toString(16).padStart(8, '0').match(/../g), (x) => Number.parseInt(x, 16)));
    if (ins === 0x00) {
      const { path } = readPath(data, 1);
      return ok(utf8(btcNode(path).publicExtendedKey));
    }
    if (ins === 0x03) {
      const index = new DataView(data.buffer, data.byteOffset).getUint32(66, false);
      let a = hex(data.subarray(1, 33)) === TAPROOT_ID ? taprootAddressOf(secretAt(seed, 'btc', `m/86'/0'/0'/0/${index}`)) : addressOf('btc', secretAt(seed, 'btc', `m/84'/0'/0'/0/${index}`));
      if (dev.lie.btcAddress) a = dev.lie.btcAddress(a);
      if (data[0] === 1 && (await decision()) !== 'approve') return sw(0x6985);
      return ok(utf8(a));
    }
    if (ins === 0x10) {
      // a BIP-137 message: the real app asks for the message piece by piece (its Merkle root is all this command
      // carries); this one signs the message the test gave it
      const { path } = readPath(data);
      if ((await decision()) !== 'approve') return sw(0x6985);
      const s = secp256k1.sign(legacyDigest(dev.btcMessage ?? new Uint8Array(0)), root.derive(path).privateKey, { prehash: false, format: 'recovered' });
      return ok(concat(Uint8Array.of(31 + s[0]), s.slice(1)));
    }
    if (ins === 0x04) {
      if ((await decision()) !== 'approve') return sw(0x6985);
      // the wallet's keys are at m/84'/0'/0'/0/index and m/86'/0'/0'/0/index; the test says which index and, for
      // each policy, which inputs with which sighashes (`digests`: segwit inputs 0, 1, 2...; `taproot`: [{ input,
      // digest }])
      const { index = 0, digests = dev.btcDigests ?? [], segwit = null, taproot = [] } = dev.btcPlan ?? {};
      const pid = hex(data.subarray(data.length - 64, data.length - 32));
      let list, key, pub;
      if (pid === TAPROOT_ID) {
        key = secretAt(seed, 'btc', `m/86'/0'/0'/0/${index}`);
        pub = schnorr.getPublicKey(key);
        list = taproot.map(({ input, digest }) => concat(Uint8Array.of(input, 32), pub, signKeyPath([digest], key, new Uint8Array(32)).signatures[0]));
      } else {
        key = secretAt(seed, 'btc', `m/84'/0'/0'/0/${index}`);
        pub = secp256k1.getPublicKey(key, true);
        list = (segwit ?? digests.map((digest, input) => ({ input, digest }))).map(({ input, digest }) => concat(Uint8Array.of(input, pub.length), pub, secp256k1.sign(digest, key, { prehash: false, format: 'der' }), Uint8Array.of(0x01)));
      }
      if (dev.lie.btcYield) list = dev.lie.btcYield(list, { pub, key, taproot: pid === TAPROOT_ID });
      yields = list;
      if (!yields.length) { yields = null; return ok(); }
      return concat(Uint8Array.of(0x10), yields.shift(), sw(0xe000));
    }
    return sw(0x6d00);
  }

  async function exchange(apdu) {
    dev.log.push(hex(apdu));
    if (!dev.connected) throw new LedgerError('connect', 'your Ledger was unplugged');
    const [cla, ins, p1, p2, lc] = apdu;
    const data = apdu.slice(5, 5 + lc);
    if (dev.locked) return sw(0x5515);
    if (cla === 0xb0 && ins === 0x01) {
      const name = utf8(dev.app);
      const version = utf8(dev.versions[dev.app] ?? '1.0.0');
      return ok(concat(Uint8Array.of(1, name.length), name, Uint8Array.of(version.length), version, Uint8Array.of(1, 0)));
    }
    if (cla === 0xb0 && ins === 0xa7) { dev.app = 'BOLOS'; return ok(); }
    if (dev.app === 'BOLOS') {
      if (cla === 0xe0 && ins === 0xd8) {
        dev.openRequests++;
        const name = String.fromCharCode(...data);
        if (!dev.versions[name]) return sw(0x6807);
        dev.app = name;
        return ok();
      }
      return sw(0x6e00);
    }
    if (dev.app === 'Solana' && cla === 0xe0) return solana(ins, p1, p2, data);
    if (dev.app === 'Ethereum' && cla === 0xe0) return ethereum(ins, p1, p2, data);
    if (dev.app === 'Bitcoin' && (cla === 0xe1 || cla === 0xf8)) return bitcoin(cla, ins, p1, p2, data);
    return sw(0x6e00);
  }

  /** What the device manager opens (D._setOpener): a link while it's plugged in, 'connect' otherwise. */
  dev.opener = async () => {
    if (!dev.connected) throw new LedgerError('connect', 'plug in your Ledger and unlock it');
    // closing the link (plum stopping) ends a review that's waiting, as unplugging would
    return { model: 'Nano S Plus', exchange, close() { dev.press('closed'); } };
  };
  return dev;
}
