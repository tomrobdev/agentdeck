// How the queue is shown: saved display settings, the board's columns and the rows j and k walk through. The dashboard
// has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DISPLAY, boardGroups, normalizeDisplay, rowOrder } from '../../app/src/lib/queueDisplay.ts';

const group = (key: string, ...ids: number[]) => ({ key, label: key, tasks: ids.map((id) => ({ id })) }) as never;
const ids = (tasks: { id: number }[]) => tasks.map((t) => t.id);

test('a display saved before show had every key gets the new keys', () => {
  const d = normalizeDisplay({ mode: 'board', show: { repo: false, pr: true } });
  assert.equal(d.mode, 'board');
  assert.deepEqual(d.show, { repo: false, pr: true, time: true, reason: true });
  assert.equal(d.groupBy, 'status');
  assert.deepEqual(d.collapsed, DEFAULT_DISPLAY.collapsed);
});

test('an old display with Merged collapsed collapses Done instead, once', () => {
  const saved = { collapsed: ['cancelled', 'merged'] };
  assert.deepEqual(normalizeDisplay(saved, false).collapsed, ['cancelled', 'done']);
  assert.deepEqual(normalizeDisplay({ collapsed: ['done'] }, false).collapsed, ['done']);
  // After the one time, Done stays as the user left it.
  assert.deepEqual(normalizeDisplay({ collapsed: [] }, true).collapsed, []);
});

test('nothing saved, or something that is not a display, is the default', () => {
  assert.deepEqual(normalizeDisplay(null), DEFAULT_DISPLAY);
  assert.deepEqual(normalizeDisplay('list'), DEFAULT_DISPLAY);
  assert.deepEqual(normalizeDisplay({ show: 'all' }).show, DEFAULT_DISPLAY.show);
});

test('the board puts review just before done', () => {
  const keys = boardGroups([group('waiting'), group('done'), group('review'), group('cancelled')]).map((g: { key: string }) => g.key);
  assert.deepEqual(keys, ['waiting', 'review', 'done', 'cancelled']);
  assert.deepEqual(
    boardGroups([group('waiting'), group('done')]).map((g: { key: string }) => g.key),
    ['waiting', 'done'],
  );
});

test('the list walks every group but the collapsed ones', () => {
  const groups = [group('waiting', 1, 2), group('done', 3), group('review', 4)];
  assert.deepEqual(ids(rowOrder(groups, { mode: 'list', groupBy: 'status', collapsed: ['done'] })), [1, 2, 4]);
  // With no grouping there is nothing to collapse.
  assert.deepEqual(ids(rowOrder(groups, { mode: 'list', groupBy: 'none', collapsed: ['done'] })), [1, 2, 3, 4]);
  // The board and the graph don't collapse groups.
  assert.deepEqual(ids(rowOrder(groups, { mode: 'board', groupBy: 'status', collapsed: ['done'] })), [1, 2, 3, 4]);
});
