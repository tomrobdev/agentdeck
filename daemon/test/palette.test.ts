// The command palette's matcher and rows. The dashboard has no test runner, so its pure helpers are tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestScore, fuzzyScore, rank } from '../../app/src/lib/fuzzy.ts';
import { FILTER_STATES } from '../../daemon/src/domain/work/index.ts';
import { type PaletteHandlers, type PaletteTask, paletteItems, searchPalette } from '../../app/src/lib/palette.ts';

test('every query character must appear in order, ignoring case', () => {
  assert.notEqual(fuzzyScore('rtry', 'Retry #5'), null);
  assert.equal(fuzzyScore('yrt', 'Retry #5'), null);
  assert.equal(fuzzyScore('xyz', 'Retry #5'), null);
  assert.notEqual(fuzzyScore('RETRY', 'retry'), null);
});

test('an empty query matches everything with the same score', () => {
  assert.equal(fuzzyScore('', 'anything'), 0);
  assert.equal(fuzzyScore('   ', 'anything'), 0);
});

test('exact beats prefix beats a scattered match', () => {
  const exact = fuzzyScore('#88', '#88')!;
  const prefix = fuzzyScore('#88', '#880')!;
  const scattered = fuzzyScore('#88', 'fix #1 then 8 and 8')!;
  assert.ok(exact > prefix, 'exact over prefix');
  assert.ok(prefix > scattered, 'prefix over scattered');
});

test('consecutive characters and word starts score higher', () => {
  assert.ok(fuzzyScore('merge', 'Merge #5')! > fuzzyScore('merge', 'm e r g e')!);
  assert.ok(fuzzyScore('cl', 'close pr')! > fuzzyScore('cl', 'xcl')!);
});

test('bestScore takes the best field and null when none match', () => {
  assert.equal(bestScore('zzz', ['a', 'b']), null);
  assert.equal(bestScore('b', ['a', 'bb']), fuzzyScore('b', 'bb'));
});

test('rank orders by score, keeps ties in order and drops non-matches', () => {
  const items = ['alpha', 'beta', 'alphabet', 'gamma'];
  assert.deepEqual(
    rank(items, 'alpha', (s) => [s]),
    ['alpha', 'alphabet'],
  );
  assert.deepEqual(
    rank(items, '', (s) => [s]),
    items,
  );
  assert.deepEqual(
    rank(
      items,
      'a',
      (s) => [s],
      (s) => (s === 'gamma' ? 100 : 0),
    )[0],
    'gamma',
  );
});

const noop = () => {};
const calls: string[] = [];
const handlers: PaletteHandlers = {
  open: (id) => calls.push(`open ${id}`),
  act: (kind, id) => calls.push(`${kind} ${id}`),
  merge: (id) => calls.push(`merge ${id}`),
  verify: (id) => calls.push(`verify ${id}`),
  copyLink: (id) => calls.push(`copy ${id}`),
  newTask: noop,
  togglePause: noop,
  restartDaemon: noop,
  view: noop,
  toggleTheme: noop,
  go: noop,
  showKeys: noop,
  showStates: noop,
  edit: noop,
  bulk: noop,
};
const task = (id: number, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Task ${id}`, status, pr_state: null, repo: 'AgentDeck', branch: `agentdeck/task-${id}`, ...extra }) as PaletteTask;

const rows = (selected: PaletteTask | null, tasks: PaletteTask[], query = '') =>
  searchPalette(paletteItems({ tasks, selected, paused: false, handlers }), query);

test('"#88" then Enter opens task 88, whichever task is selected', () => {
  const tasks = [task(5, 'done', { pr_state: 'open' }), task(88, 'queued'), task(880, 'queued')];
  for (const selected of [null, tasks[0], tasks[1]]) {
    calls.length = 0;
    rows(selected, tasks, '#88')[0].run();
    assert.deepEqual(calls, ['open 88']);
  }
});

test('with a done task whose PR is open selected, Merge is listed first', () => {
  const t = task(7, 'done', { pr_state: 'open' });
  const list = rows(t, [t, task(8, 'queued')]);
  assert.equal(list[0].label, 'Merge #7');
  assert.equal(list[0].shortcut, 'm');
  assert.ok(list.findIndex((i) => i.forSelected) === 0);
  assert.ok(
    list.slice(0, list.filter((i) => i.forSelected).length).every((i) => i.forSelected),
    'its actions come before the rest',
  );
});

test('the selected task offers only what its status allows', () => {
  const labels = (t: PaletteTask) =>
    rows(t, [t])
      .filter((i) => i.forSelected)
      .map((i) => i.label);
  assert.deepEqual(labels(task(1, 'proposed')), ['Approve #1', 'Verify #1', 'Open task #1', 'Copy link to #1']);
  assert.ok(labels(task(2, 'blocked')).includes('Retry #2'));
  assert.ok(labels(task(2, 'blocked')).includes('Mark done #2'));
  assert.ok(labels(task(3, 'running')).includes('Stop #3'));
  assert.ok(!labels(task(4, 'queued')).includes('Merge #4'));
  assert.ok(!labels(task(5, 'done', { pr_state: 'open' })).includes('Retry #5'), 'a task in review is sent back with a note instead');
});

test('a task in review that is syncing or has a merge request offers no Merge', () => {
  const labels = (t: PaletteTask) =>
    rows(t, [t])
      .filter((i) => i.forSelected)
      .map((i) => i.label);
  const syncing = task(6, 'done', { pr_state: 'open', sync: { since: null, resolving: false } });
  const requested = task(7, 'done', { pr_state: 'open', merge_request: { state: 'waiting', method: 'squash', reasons: [], since: 'x' } });
  assert.ok(!labels(syncing).includes('Merge #6'));
  assert.ok(!labels(requested).includes('Merge #7'));
  assert.ok(!labels(syncing).includes('Retry #6'), 'still in review, so still no plain retry');
});

test('commands are listed, and the daemon toggle follows its state', () => {
  const all = (paused: boolean) => paletteItems({ tasks: [], selected: null, paused, handlers }).map((i) => i.label);
  assert.ok(all(false).includes('Pause the daemon'));
  assert.ok(all(true).includes('Resume the daemon'));
  for (const label of ['New task', 'Restart the daemon', 'Show list', 'Show board', 'Show graph', 'Toggle light and dark']) {
    assert.ok(all(false).includes(label), label);
  }
  assert.equal(paletteItems({ tasks: [], selected: null, paused: false, handlers }).find((i) => i.label === 'New task')?.shortcut, 'c');
});

test('tasks match on title, repo and branch', () => {
  const tasks = [task(1, 'queued', { title: 'Fix login', repo: 'Web', branch: 'agentdeck/task-1' }), task(2, 'queued', { title: 'Docs' })];
  assert.equal(rows(null, tasks, 'login')[0].key, 'task:1');
  assert.equal(rows(null, tasks, 'web')[0].key, 'task:1');
  assert.equal(rows(null, tasks, 'task-2')[0].key, 'task:2');
});

test('the palette offers the go commands, the keys sheet and a Show command per filter state', () => {
  const labels = paletteItems({ tasks: [], selected: null, paused: false, handlers }).map((i) => i.label);
  for (const label of ['Go to the queue', 'Go to insights', 'Go to settings', 'Go to repos', 'Show keyboard shortcuts']) {
    assert.ok(labels.includes(label), label);
  }
  for (const s of FILTER_STATES) assert.ok(labels.includes(`Show ${s.label.toLowerCase()}`), s.key);
});

test('the selected task gets the edit commands with their keys; a prompt is edited one task at a time', () => {
  const t = task(5, 'queued');
  const one = paletteItems({ tasks: [t], selected: t, paused: false, handlers });
  assert.equal(one.find((i) => i.label === 'Edit the prompt (#5)')?.shortcut, 'e');
  assert.equal(one.find((i) => i.label === 'Set priority urgent (#5)')?.shortcut, 'p 1');
  assert.equal(one.find((i) => i.label === 'Set the model (#5)')?.shortcut, 'M');
  assert.equal(one.find((i) => i.label === 'Link to another task (#5)')?.shortcut, 'l');
  const picked = [task(5, 'queued'), task(6, 'queued')] as never[];
  const many = paletteItems({ tasks: [], selected: t, picked, paused: false, handlers });
  assert.ok(!many.some((i) => i.label.startsWith('Edit the prompt')));
  assert.ok(many.some((i) => i.label === 'Set priority low (2 picked tasks)'));
});

test('with tasks picked the palette offers the bulk actions every one allows, first', () => {
  const picked = [task(1, 'proposed'), task(2, 'proposed')] as never[];
  const items = paletteItems({ tasks: [], selected: null, picked, paused: false, handlers });
  assert.equal(items[0].label, 'Approve 2 picked tasks');
  assert.ok(items.some((i) => i.label === 'Reject 2 picked tasks'));
  assert.ok(!items.some((i) => i.label.startsWith('Retry')));
});
