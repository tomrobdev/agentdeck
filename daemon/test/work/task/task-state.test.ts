// A task carries only what its status has. A row an older daemon left with another status's columns reads as if it had none, and the
// API's JSON keeps every field on every status. (That `task.needs` doesn't compile until narrowed is in db/types-check.ts.)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type StateFields, stateFields } from '../../../src/domain/work/task.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-task-state-'));

const { openDb } = await import('../../fixtures/open-db.ts');
const { taskDetail, taskViews } = await import('../../../src/api/wire.ts');
const { TASK_STATUSES } = await import('../../../src/domain/work/lifecycle.ts');

type Db = ReturnType<typeof openDb>;

const STALE: StateFields = {
  stop_reason: 'old reason',
  needs: { kind: 'deps', items: ['zod'] },
  question: { question: 'Which?', options: ['a'] },
  done_by: 'person',
};
const NONE: StateFields = { stop_reason: null, needs: null, question: null, done_by: null };

/** What a task reads as from a row with every state column set, by status: these fields and no others. */
const ON_TASK: Record<(typeof TASK_STATUSES)[number], Partial<StateFields>> = {
  proposed: {},
  queued: {},
  running: {},
  cancel_requested: {},
  done: { done_by: STALE.done_by },
  blocked: { stop_reason: STALE.stop_reason, needs: STALE.needs, question: STALE.question },
  failed: { stop_reason: STALE.stop_reason },
  cancelled: { stop_reason: STALE.stop_reason },
};

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r-state', base_branch: 'main' });
  const id = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' }).id;
  return { db, id };
}

const writeRow = (db: Db, id: number, status: string, needs: string, question: string) =>
  db.raw
    .prepare('UPDATE tasks SET status = ?, stop_reason = ?, needs = ?, question = ?, done_by = ? WHERE id = ?')
    .run(status, STALE.stop_reason, needs, question, STALE.done_by, id);

/** The state fields a task has as its own properties. */
const onTask = (task: object) => Object.fromEntries(Object.entries(task).filter(([key]) => key in NONE));

for (const status of TASK_STATUSES) {
  test(`a ${status} row with every state column set carries only what ${status} has`, () => {
    const { db, id } = setup();
    writeRow(db, id, status, JSON.stringify(STALE.needs), JSON.stringify(STALE.question));
    const task = db.getTask(id)!;
    assert.equal(task.status, status);
    assert.deepEqual(onTask(task), ON_TASK[status]);
    const summary = db.listTaskSummaries({ limit: 10 }).find((t) => t.id === id)!;
    assert.deepEqual(onTask(summary), ON_TASK[status]);
    db.close();
  });

  test(`a ${status} row with malformed JSON in its columns still reads`, () => {
    const { db, id } = setup();
    writeRow(db, id, status, 'not json', '{"question":');
    const fields = stateFields(db.getTask(id)!);
    assert.equal(fields.needs, null);
    assert.equal(fields.question, null);
    db.close();
  });
}

/** Every field the API sends for a task in a list; the detail adds its prompt, runs, events and plans. */
const API_FIELDS = [
  'attempts',
  'auto_merge',
  'auto_merge_check',
  'auto_merge_checked_at',
  'auto_merge_view',
  'branch',
  'checks',
  'conflicting',
  'created_at',
  'dependents',
  'done_by',
  'id',
  'links',
  'live',
  'max_attempts',
  'max_turns',
  'merge_method',
  'merge_request',
  'merge_request_check',
  'merge_request_method',
  'merge_requested_at',
  'model',
  'needs',
  'plan_steps',
  'plan_task',
  'plan_unfinished',
  'pr_checks_merged',
  'pr_checks_opened',
  'pr_retry',
  'pr_state',
  'pr_url',
  'priority',
  'question',
  'repo',
  'repo_id',
  'restarts',
  'run_model',
  'source',
  'status',
  'stop_reason',
  'sync',
  'syncing_since',
  'title',
  'unblocks',
  'updated_at',
  'wait',
  'waiting',
  'worktree',
].sort();

for (const status of TASK_STATUSES) {
  test(`the API sends every field for a ${status} task, in the shape it always had`, async () => {
    const { db, id } = setup();
    writeRow(db, id, status, JSON.stringify(STALE.needs), JSON.stringify(STALE.question));
    const carried = { ...NONE, ...ON_TASK[status] };
    const expected = {
      stop_reason: carried.stop_reason,
      needs: carried.needs && JSON.stringify(carried.needs),
      question: carried.question && JSON.stringify(carried.question),
      done_by: carried.done_by,
    };
    const view = JSON.parse(JSON.stringify(taskViews(db, { limit: 10 }).find((t) => t.id === id)));
    assert.deepEqual(Object.keys(view).sort(), API_FIELDS);
    assert.deepEqual({ stop_reason: view.stop_reason, needs: view.needs, question: view.question, done_by: view.done_by }, expected);

    const detail = JSON.parse(JSON.stringify(await taskDetail(db, id)));
    for (const field of API_FIELDS) assert.ok(field in detail, field);
    assert.deepEqual(
      { stop_reason: detail.stop_reason, needs: detail.needs, question: detail.question, done_by: detail.done_by },
      expected,
    );
    db.close();
  });
}

test('applyEvent clears the columns of the status the task left', () => {
  const { db, id } = setup();
  const columns = () => db.raw.prepare('SELECT stop_reason, needs, question, done_by FROM tasks WHERE id = ?').get(id);
  assert.ok(db.applyEvent(id, { type: 'claim' }));
  assert.ok(db.applyEvent(id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck', needs: { kind: 'host', items: ['x'] } }));
  assert.ok(db.recordQuestion(id, { question: 'Which?', options: [] }, 'Which?'));
  assert.ok(db.applyEvent(id, { type: 'cancel' }));
  assert.deepEqual({ ...(columns() as object) }, { stop_reason: 'stuck', needs: null, question: null, done_by: null });
  db.close();
});
