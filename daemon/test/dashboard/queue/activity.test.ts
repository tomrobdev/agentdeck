// The status bar's activity list: what counts as under way, and what each row says. The dashboard has no test runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityItems } from '../../../../app/src/lib/activity.ts';
import type { Status, TaskSummary } from '../../../../app/src/api/types.ts';
import { asTaskId } from '../../fixtures/fixtures.ts';

const NOW = Date.parse('2026-11-01T12:10:00Z');

function task({ id = 1, ...over }: Omit<Partial<TaskSummary>, 'id'> & { id?: number }): TaskSummary {
  return { id: asTaskId(id), title: 'A task', status: 'done', live: null, sync: null, merge_request: null, ...over } as TaskSummary;
}

test('nothing under way gives an empty list', () => {
  assert.deepEqual(activityItems([task({}), task({ id: 2, status: 'queued' })], null, NOW), []);
});

test('a running task and a waiting merge request are two rows', () => {
  const items = activityItems(
    [
      task({ id: 1, status: 'running', live: { since: '2026-11-01 12:00:00', turns: 4, max_turns: 40, tool: 'Edit a.ts' } }),
      task({
        id: 2,
        merge_request: { state: 'waiting', method: 'squash', reasons: ['2 checks running'], since: '2026-11-01 12:05:00' },
      }),
    ],
    null,
    NOW,
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.taskId, i.tab, i.cancellable]),
    [
      ['run', 1, 'runs', false],
      ['merge', 2, 'overview', true],
    ],
  );
  assert.ok(items[0]!.doing.endsWith(' · turn 4/40 · Edit a.ts'), items[0]!.doing); // describeLive reads the clock
  assert.equal(items[1]!.doing, 'Merging when ready · 2 checks running');
  assert.equal(items[1]!.took, '5m');
});

test('a resolve run opens on Runs, a clean sync on the overview, and planner runs have no task', () => {
  const status = { planning: [{ id: 3, repo_id: 1, repo: 'api', started_at: '2026-11-01 12:09:00' }] } as Status;
  const items = activityItems(
    [
      task({ id: 1, sync: { base: 'main', since: '2026-11-01 12:08:00', resolving: true, turns: 1, max_turns: 40, tool: null } }),
      task({ id: 2, sync: { base: 'main', since: null, resolving: false, turns: 0, max_turns: 40, tool: null } }),
    ],
    status,
    NOW,
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.taskId, i.tab]),
    [
      ['resolve', 1, 'runs'],
      ['sync', 2, 'overview'],
      ['planner', null, 'overview'],
    ],
  );
  assert.equal(items[1]!.doing, 'Syncing with main…');
});
