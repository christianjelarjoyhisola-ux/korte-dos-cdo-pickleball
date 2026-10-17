const test = require('node:test');
const assert = require('node:assert/strict');

test('database broadcast probe accepts empty hints with optional platform UUID metadata', async () => {
  const { isEmptyProbePayload } = await import('../tools/player-live-probe.mjs');
  assert.equal(isEmptyProbePayload({}), true);
  assert.equal(isEmptyProbePayload({ id: 'e496a97a-681e-4116-a9af-69e6bdc91e56' }), true);
  for (const payload of [null, [], '', { id: 'not-a-uuid' }, { player: 'unexpected' },
    { id: 'e496a97a-681e-4116-a9af-69e6bdc91e56', score: 1 }]) {
    assert.equal(isEmptyProbePayload(payload), false);
  }
});
