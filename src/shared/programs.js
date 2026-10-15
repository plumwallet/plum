// Programs plum can name in a preview. A name is only a label: what a transaction does is read from its simulation.
import { ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './tx.js';

export const PROGRAMS = {
  [SYSTEM_PROGRAM]: 'System',
  [COMPUTE_BUDGET_PROGRAM]: 'Compute Budget',
  [TOKEN_PROGRAM]: 'Token',
  [TOKEN_2022_PROGRAM]: 'Token-2022',
  [ATA_PROGRAM]: 'Associated Token',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: 'Memo (v1)',
  AddressLookupTab1e1111111111111111111111111: 'Address Lookup Table',
  Stake11111111111111111111111111111111111111: 'Stake',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Token Metadata',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpools',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 'Magic Eden',
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: 'Lighthouse',
};

export const programName = (id) => PROGRAMS[id] ?? null;
