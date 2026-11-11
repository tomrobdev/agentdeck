// When approving opens the dialog. The dashboard has no test runner, so its rule is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveDialog, asApproveDialogSetting, hasSomethingToShow } from '#app/lib/work/approve-dialog.ts';

const clean = { staleness: null, notes: [], overlaps: [] };
const stale = { staleness: { ref: 'main', base: 'abc', commits: 4, changed: [] }, notes: [], overlaps: [] };
const noted = { staleness: null, notes: ['src/gone.ts is not on main'], overlaps: [] };
const overlapping = {
  staleness: null,
  notes: [],
  overlaps: [{ id: 9, title: 't', status: 'queued', paths: ['a.ts'], linked: false }],
} as never;
const linkedOnly = {
  staleness: null,
  notes: [],
  overlaps: [{ id: 9, title: 't', status: 'queued', paths: ['a.ts'], linked: true }],
} as never;

test('something to show: a staleness line, notes or an unlinked overlap', () => {
  assert.equal(hasSomethingToShow(null), false);
  assert.equal(hasSomethingToShow(clean), false);
  assert.equal(hasSomethingToShow(stale), true);
  assert.equal(hasSomethingToShow(noted), true);
  assert.equal(hasSomethingToShow(overlapping), true);
});

test('three proposals, one stale: the dialog opens, lists all and ticks the other two', () => {
  const plan = approveDialog(
    [
      { id: 1, check: clean },
      { id: 2, check: stale },
      { id: 3, check: null },
    ],
    'needed',
  );
  assert.deepEqual(plan, { open: true, listed: [1, 2, 3], ticked: [1, 3] });
});

test('nothing to show: no dialog by default', () => {
  assert.equal(approveDialog([{ id: 1, check: clean }], 'needed').open, false);
  assert.equal(approveDialog([{ id: 1, check: linkedOnly }], 'needed').open, false);
  assert.deepEqual(approveDialog([{ id: 1, check: clean }], 'needed'), { open: false, listed: [], ticked: [] });
});

test('always opens it, never does not', () => {
  const items = [
    { id: 1, check: clean },
    { id: 2, check: stale },
  ];
  assert.deepEqual(approveDialog([{ id: 1, check: clean }], 'always'), { open: true, listed: [1], ticked: [1] });
  assert.equal(approveDialog(items, 'never').open, false);
  assert.deepEqual(approveDialog(items, 'always').ticked, [1]);
});

test('one flagged task is ticked: the person asked for it', () => {
  assert.deepEqual(approveDialog([{ id: 5, check: stale }], 'needed'), { open: true, listed: [5], ticked: [5] });
});

test('no tasks never open it', () => {
  assert.equal(approveDialog([], 'always').open, false);
});

test('a stored setting that is not known is the default', () => {
  assert.equal(asApproveDialogSetting('never'), 'never');
  assert.equal(asApproveDialogSetting('x'), 'needed');
  assert.equal(asApproveDialogSetting(null), 'needed');
});
