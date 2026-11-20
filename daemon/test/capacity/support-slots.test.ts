// Support slots: review, unblock and verify runs fill their own slots first, then take work slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SUPPORT_SLOTS, slotUse, slotsLine, validateSupportSlots } from '#domain/capacity/index.ts';

test('a support run in its own slot takes no work slot', () => {
  assert.deepEqual(slotUse({ used: 2, support: 1, support_slots: 1 }), { work: 1, support_free: 0 });
  assert.deepEqual(slotUse({ used: 1, support: 0, support_slots: 1 }), { work: 1, support_free: 1 });
});

test('support runs beyond the support slots take work slots', () => {
  assert.deepEqual(slotUse({ used: 3, support: 3, support_slots: 1 }), { work: 2, support_free: 0 });
  assert.deepEqual(slotUse({ used: 1, support: 1, support_slots: 0 }), { work: 1, support_free: 0 });
});

test('slotUse never counts more support runs than slots taken', () => {
  assert.deepEqual(slotUse({ used: 1, support: 4, support_slots: 2 }), { work: 0, support_free: 1 });
});

test('support_slots is a whole number from 0 to 4, 1 by default', () => {
  assert.equal(DEFAULT_SUPPORT_SLOTS, 1);
  assert.equal(validateSupportSlots(0), null);
  assert.equal(validateSupportSlots(4), null);
  assert.match(validateSupportSlots(5) ?? '', /support_slots must be a whole number from 0 to 4/);
  assert.notEqual(validateSupportSlots(1.5), null);
});

test('slotsLine shows the work slots, then each kind of support run under way', () => {
  assert.equal(slotsLine(1, 1, { review: 1, unblock: 0, verify: 0 }), '1/1 slots · 1 review');
  assert.equal(slotsLine(0, 2, { review: 2, unblock: 1, verify: 1 }), '0/2 slots · 2 reviews · 1 unblock · 1 verify');
  assert.equal(slotsLine(0, 1, { review: 0, unblock: 0, verify: 0 }), '0/1 slots');
});
