// What building the task list and a task's detail costs: queries that don't grow with the tasks, and no git for a running task.
import assert from 'node:assert/strict';
import type { TaskId } from '../src/domain/shared/id.ts';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-views-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('./open-db.ts');
const { taskDetail, taskViews } = await import('../src/application/actions.ts');
const { liveLinks, loadedLinks } = await import('../src/application/work/dependencies.ts');
const { dependentViews } = await import('../src/domain/work/link.ts');
const { withViews } = await import('../src/application/work/task-views.ts');
const { doneTask, runningTask } = await import('./fixtures.ts');

type TestDb = ReturnType<typeof openDb>;

/** How many SQL statements `fn` prepares on `db`. */
function statements(db: TestDb, fn: () => void): number {
  const raw = db.raw;
  const prepare = raw.prepare.bind(raw);
  let n = 0;
  raw.prepare = (sql: string) => {
    n++;
    return prepare(sql);
  };
  try {
    fn();
  } finally {
    raw.prepare = prepare;
  }
  return n;
}

/** A database with `n` queued tasks, each building on the one before it and after the one before that. */
function chained(n: number) {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  const ids: TaskId[] = [];
  for (let i = 0; i < n; i++) {
    const t = db.addTask({ repo_id: repo.id, title: `t${i}`, prompt: 'p' });
    if (i >= 1) db.addLink({ task_id: t.id, on: ids[i - 1], kind: 'builds_on' });
    if (i >= 2) db.addLink({ task_id: t.id, on: ids[i - 2], kind: 'after' });
    ids.push(t.id);
  }
  return db;
}

test('the task list runs the same statements however many tasks and links there are', () => {
  const counts = [5, 40].map((n) => {
    const db = chained(n);
    const views = taskViews(db, { limit: 1000 });
    assert.equal(views.length, n);
    return statements(db, () => taskViews(db, { limit: 1000 }));
  });
  assert.equal(counts[0], counts[1], `statements for 5 and 40 tasks: ${counts.join(' and ')}`);
  assert.ok(counts[1] < 30, `${counts[1]} statements`);
});

test("the list works out each task's start state once, for both its waiting and its wait", () => {
  const db = chained(4);
  db.setPaused(false);
  const index = loadedLinks(db);
  const reads = new Map<TaskId, number>();
  const links = {
    ...index,
    linksOf: (id: TaskId) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return index.linksOf(id);
    },
  };
  const views = withViews(db, db.listTasks(), links);
  // None is in review, so a task's own links are read twice: once for its start state, once for its link list.
  for (const v of views) assert.equal(reads.get(v.id), 2, `#${v.id}'s links read ${reads.get(v.id)} times`);
  const [, , , last] = views.sort((a, b) => a.id - b.id);
  assert.deepEqual(last.waiting, { on: [views[2].id], stuck: null });
  assert.deepEqual(last.wait, { kind: 'dependency', on: [views[2].id], stuck: null });
});

test('the list shows the links, dependents and waits it always did', () => {
  const db = chained(4);
  const [d, c, b, a] = taskViews(db, { limit: 10 });
  assert.deepEqual(a.links, []);
  assert.deepEqual(a.dependents, [
    { id: b.id, kind: 'builds_on' },
    { id: c.id, kind: 'after' },
  ]);
  assert.deepEqual(
    d.links.map((l) => [l.on, l.kind, l.state]),
    [
      [b.id, 'after', 'unlanded'],
      [c.id, 'builds_on', 'waiting'],
    ],
  );
  assert.deepEqual(d.waiting, { on: [c.id], stuck: null });
});

test("a dependent's link removed between reads doesn't throw", () => {
  const db = chained(2);
  const [a, b] = [db.listTasks()[1], db.listTasks()[0]];
  // A second read of the dependent's links finds the link gone; the views need no second read.
  db.linksOf = (id) => {
    db.removeLink(id, a.id);
    return [];
  };
  assert.deepEqual(dependentViews(a.id, liveLinks(db)), [{ id: b.id, kind: 'builds_on' }]);
  assert.doesNotThrow(() => taskViews(db, { limit: 10 }));
});

test("a running task's detail starts no git; a done task's still measures its branch", async () => {
  const bin = mkdtempSync(join(tmpdir(), 'agentdeck-fakegit-'));
  const marker = join(bin, 'ran');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const db = openDb(':memory:');
    const repo = db.addRepo({ name: 'demo', path: bin, base_branch: 'main' });
    db.raw.exec('UPDATE repos SET auto_merge = 1');
    const running = runningTask(db, repo);
    db.raw.exec(`UPDATE tasks SET branch = 'agentdeck/task-${running.id}' WHERE id = ${running.id}`);
    await taskDetail(db, running.id);
    assert.equal(existsSync(marker), false, 'git ran for a running task');

    const done = doneTask(db, repo);
    db.raw.exec(`UPDATE tasks SET branch = 'agentdeck/task-${done.id}' WHERE id = ${done.id}`);
    await taskDetail(db, done.id);
    assert.equal(existsSync(marker), true, 'git should measure a done task');
  } finally {
    process.env.PATH = path;
  }
});
