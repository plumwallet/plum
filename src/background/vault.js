// The vault: every secret plum holds, sealed under your password.
//
//   password --scrypt (N=2^17, r=8, p=1, 128 MiB, random salt)--> key-encryption key
//   key-encryption key --AES-256-GCM--> data key (random, 32 bytes)
//   data key --AES-256-GCM--> { mnemonic, keys }
//
// Unlocking yields the data key, which lives only in memory (the background page and storage.session, which Firefox
// never writes to disk and never shows a content script). Locking forgets it. Changing the password re-seals the data
// key alone. Each ciphertext is bound to what it is (additional data), so one can't stand in for another.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { b64decode, b64encode, utf8, wipe } from '../shared/bytes.js';

export const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const AAD_KEY = utf8('plum-vault-v1:data-key');
const AAD_DATA = utf8('plum-vault-v1:data');

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

async function kek(password, kdf) {
  if (kdf?.name !== 'scrypt' || !(kdf.N >= 2 ** 14) || !(kdf.r >= 8) || !(kdf.p >= 1)) throw new Error('the vault asks for weaker settings than plum allows');
  return scryptAsync(utf8(String(password).normalize('NFKC')), b64decode(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 29 });
}

async function aes(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(raw, plain, aad) {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aes(raw), plain));
  return { iv: b64encode(iv), ct: b64encode(ct) };
}

async function unseal(raw, box, aad) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(box.iv), additionalData: aad }, await aes(raw), b64decode(box.ct)));
}

const encodeData = (data) => utf8(JSON.stringify(data));
const decodeData = (bytes) => {
  const data = JSON.parse(new TextDecoder().decode(bytes));
  wipe(bytes);
  return data;
};

/** Any password is accepted, blank included; only its type and a sane length are checked. */
export function checkPassword(password) {
  if (typeof password !== 'string') throw new Error('a password has to be text');
  if (password.length > 1024) throw new Error('that password is too long');
}

/** A new vault holding `data`. Returns { vault, dataKey }. */
export async function createVault(password, data) {
  checkPassword(password);
  const kdf = { ...KDF, salt: b64encode(random(16)) };
  const dataKey = random(32);
  const k = await kek(password, kdf);
  const vault = { v: 1, kdf, key: await seal(k, dataKey, AAD_KEY), data: await seal(dataKey, encodeData(data), AAD_DATA) };
  wipe(k);
  return { vault, dataKey };
}

/** Open the vault with a password: { dataKey, data }. A wrong password throws 'wrong password'. */
export async function unlockVault(vault, password) {
  const k = await kek(password, vault.kdf);
  let dataKey;
  try {
    dataKey = await unseal(k, vault.key, AAD_KEY);
  } catch {
    throw new Error('wrong password');
  } finally {
    wipe(k);
  }
  return { dataKey, data: decodeData(await unseal(dataKey, vault.data, AAD_DATA)) };
}

/** Is this the vault's password? (Asked again before showing a secret.) */
export async function passwordOpens(vault, password) {
  try {
    const { dataKey } = await unlockVault(vault, password);
    wipe(dataKey);
    return true;
  } catch {
    return false;
  }
}

export async function readVault(vault, dataKey) {
  return decodeData(await unseal(dataKey, vault.data, AAD_DATA));
}

/** The same vault holding new data (same password, same data key, fresh nonce). */
export async function writeVault(vault, dataKey, data) {
  return { ...vault, data: await seal(dataKey, encodeData(data), AAD_DATA) };
}

/** The vault under a new password, with a new data key too (so a data key seen before is worth nothing now).
 * Returns { vault, dataKey, data }. */
export async function changePassword(vault, oldPassword, newPassword) {
  checkPassword(newPassword);
  const { dataKey: old, data } = await unlockVault(vault, oldPassword);
  wipe(old);
  const kdf = { ...KDF, salt: b64encode(random(16)) };
  const dataKey = random(32);
  const k = await kek(newPassword, kdf);
  const out = { v: 1, kdf, key: await seal(k, dataKey, AAD_KEY), data: await seal(dataKey, encodeData(data), AAD_DATA) };
  wipe(k);
  return { vault: out, dataKey, data };
}
