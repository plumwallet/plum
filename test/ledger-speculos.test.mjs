// plum's Ledger clients, replayed against what Ledger's own apps answered in its Speculos emulator
// (test/fixtures/ledger-speculos.json, recorded by scripts/ledger-speculos.mjs): every APDU plum sends must be byte for
// byte the one the real app took, in the same order, and every result must check out against plum's own keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hex } from '../src/shared/bytes.js';
import { SCENARIOS } from './ledger-scenarios.mjs';

const record = JSON.parse(readFileSync(new URL('./fixtures/ledger-speculos.json', import.meta.url), 'utf8'));
const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

test('the record covers every scenario, from the three apps', () => {
  assert.deepEqual(Object.keys(record.apps).sort(), ['Bitcoin', 'Ethereum', 'Solana']);
  for (const s of SCENARIOS) assert.ok(record.scenarios[s.name], `"${s.name}" was recorded`);
});

for (const s of SCENARIOS) {
  test(`${s.app} ${record.apps[s.app]}: ${s.name.replace(/^(sol|eth|btc) /, '')}`, async () => {
    const { exchanges } = record.scenarios[s.name];
    let i = 0;
    const link = {
      async exchange(apdu) {
        assert.ok(i < exchanges.length, `plum sent more than the ${exchanges.length} APDUs the app took`);
        const [want, answer] = exchanges[i++];
        assert.equal(hex(apdu), want, `APDU ${i} differs from what the app took`);
        return fromHex(answer);
      },
    };
    const result = await s.run(link);
    assert.equal(i, exchanges.length, 'plum made every exchange the app did');
    s.check(result);
  });
}
