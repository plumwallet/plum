// Program-derived addresses: the associated token account a wallet holds a coin in, found the way the runtime does
// (sha256 of the seeds, the bump, the program and "ProgramDerivedAddress", off the ed25519 curve).
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode } from './base58.js';
import { concat, utf8 } from './bytes.js';
import { ATA_PROGRAM, base58Decode32 } from './tx.js';

/** Is a 32-byte address a point on the curve (a key someone can sign for), rather than a program's address? */
export function isOnCurve(bytes) {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = utf8('ProgramDerivedAddress');

export function findProgramAddress(seeds, programId) {
  const program = base58Decode32(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), program, PDA_MARKER));
    if (!isOnCurve(h)) return [base58Encode(h), bump];
  }
  throw new Error('no address off the curve for these seeds');
}

/** The associated token account of (owner, mint) under a token program. */
export function associatedTokenAddress(owner, mint, tokenProgram) {
  return findProgramAddress([base58Decode32(owner), base58Decode32(tokenProgram), base58Decode32(mint)], ATA_PROGRAM)[0];
}
