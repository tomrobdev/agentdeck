import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, migrate, openDb } from '../src/db/index.ts';
import { type Dependency, type Link, type LinkTarget, linkError, linkState, mergeHold, startState } from '../src/domain/task/link.ts';

const done: Dependency = { status: 'done', pr_url: null, pr_state: null, pr_mode: 'off', done_by: null };
const builds = { on: 5, kind: 'builds_on' } as const;
const after = { on: 5, kind: 'after' } as const;

test('linkState: every row of the rules table, for builds on', () => {
  const stuck = (reason: string) => ({ kind: 'stuck', on: 5, reason });
  const waiting = (reason: string) => ({ kind: 'waiting', on: 5, reason });
  assert.deepEqual(linkState(builds, done), { kind: 'met' });
  assert.deepEqual(linkState(builds, { ...done, pr_url: 'u', pr_state: 'merged', pr_mode: 'ready' }), { kind: 'met' });
  assert.deepEqual(linkState(builds, { ...done, done_by: 'person', pr_mode: 'ready' }), { kind: 'met' });
  assert.deepEqual(linkState(builds, { ...done, pr_mode: 'ready' }), waiting("#5's PR is not opened yet"));
  assert.deepEqual(linkState(builds, { ...done, done_by: 'person', pr_url: 'u', pr_state: 'open' }), waiting("#5's PR is not merged yet"));
  assert.deepEqual(linkState(builds, { ...done, pr_url: 'u', pr_state: 'open' }), waiting("#5's PR is not merged yet"));
  assert.deepEqual(linkState(builds, { ...done, status: 'queued' }), waiting('#5 is not done yet'));
  assert.deepEqual(linkState(builds, { ...done, status: 'running' }), waiting('#5 is not done yet'));
  assert.deepEqual(linkState(builds, { ...done, status: 'cancel_requested' }), waiting('#5 is not done yet'));
  assert.deepEqual(linkState(builds, { ...done, pr_mode: 'draft', pr_state: 'failed' }), stuck("#5's PR could not be opened"));
  assert.deepEqual(linkState(builds, { ...done, pr_url: 'u', pr_state: 'closed' }), stuck("#5's PR was closed without merging"));
  assert.deepEqual(linkState(builds, { ...done, status: 'failed' }), stuck('#5 failed'));
  assert.deepEqual(linkState(builds, { ...done, status: 'blocked' }), stuck('#5 is blocked'));
  assert.deepEqual(linkState(builds, { ...done, status: 'cancelled' }), stuck('#5 was cancelled'));
  assert.deepEqual(linkState(builds, undefined), stuck('#5 no longer exists'));
});

test('linkState: an after link is met once the other landed or is gone, and otherwise holds the merge', () => {
  const holding = (reason: string) => ({ kind: 'holding', on: 5, reason });
  assert.deepEqual(linkState(after, done), { kind: 'met' });
  assert.deepEqual(linkState(after, undefined), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, pr_url: 'u', pr_state: 'merged' }), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, status: 'running' }), holding('#5 is not done yet'));
  assert.deepEqual(linkState(after, { ...done, pr_url: 'u', pr_state: 'open' }), holding("#5's PR is not merged yet"));
  assert.deepEqual(linkState(after, { ...done, status: 'failed' }), holding('#5 failed'));
  assert.deepEqual(linkState(after, { ...done, pr_url: 'u', pr_state: 'closed' }), holding("#5's PR was closed without merging"));
});

// A graph for startState: each task's standing and its own links.
const world =
  (tasks: Record<number, Partial<Dependency> & { links?: Link[] }>) =>
  (id: number): LinkTarget | undefined => {
    const t = tasks[id];
    return t && { ...done, links: [], ...t };
  };
const link = (task_id: number, on: number, kind: Link['kind'] = 'builds_on'): Link => ({ task_id, on, kind });

test('startState: none, met, waiting on every unmet link', () => {
  const lookup = world({ 2: {}, 3: { status: 'running' }, 4: { status: 'queued' } });
  assert.deepEqual(startState({ id: 1 }, [], lookup), { kind: 'none' });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2, 'after')], lookup), { kind: 'none' });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2)], lookup), { kind: 'met' });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2), link(1, 3), link(1, 4)], lookup), { kind: 'waiting', on: [3, 4] });
  // An after link never holds a start, even on a task that failed.
  assert.deepEqual(startState({ id: 1 }, [link(1, 2), link(1, 3, 'after')], lookup), { kind: 'met' });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2), link(1, 9, 'after')], lookup), { kind: 'met' });
});

test('startState: stuck spreads down builds-on links, naming the root', () => {
  // 1 builds on 2 and 3; 2 builds on 4 (queued) which builds on 5 (failed); 3 is running.
  const lookup = world({
    2: { status: 'queued', links: [link(2, 4)] },
    3: { status: 'running' },
    4: { status: 'queued', links: [link(4, 5)] },
    5: { status: 'failed' },
  });
  const links = [link(1, 3), link(1, 2)];
  assert.deepEqual(startState({ id: 1 }, links, lookup), { kind: 'stuck', on: 5, reason: '#5 failed' });
  // Two stuck links: the first one's root.
  const two = world({ 2: { status: 'blocked' }, 3: { status: 'failed' } });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2), link(1, 3)], two), { kind: 'stuck', on: 2, reason: '#2 is blocked' });
  // A root that is gone is named too.
  assert.deepEqual(startState({ id: 1 }, [link(1, 2)], world({ 2: { status: 'queued', links: [link(2, 8)] } })), {
    kind: 'stuck',
    on: 8,
    reason: '#8 no longer exists',
  });
  // An after link on the way down does not spread stuck; and a done task's own links no longer matter.
  assert.deepEqual(
    startState({ id: 1 }, [link(1, 2)], world({ 2: { status: 'queued', links: [link(2, 5, 'after')] }, 5: { status: 'failed' } })),
    {
      kind: 'waiting',
      on: [2],
    },
  );
  assert.deepEqual(startState({ id: 1 }, [link(1, 2)], world({ 2: { pr_mode: 'ready', links: [link(2, 5)] }, 5: { status: 'failed' } })), {
    kind: 'waiting',
    on: [2],
  });
});

test('startState: a cycle that got into the data does not loop', () => {
  const lookup = world({
    1: { status: 'queued', links: [link(1, 2)] },
    2: { status: 'queued', links: [link(2, 3)] },
    3: { status: 'queued', links: [link(3, 2), link(3, 1)] },
  });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2)], lookup), { kind: 'waiting', on: [2] });
});

test('mergeHold lists the after links still holding the merge', () => {
  const lookup = (id: number) =>
    id === 2 ? done : id === 3 ? { ...done, status: 'running' } : id === 4 ? { ...done, status: 'failed' } : undefined;
  assert.deepEqual(mergeHold([link(1, 2, 'after'), link(1, 3, 'after'), link(1, 4, 'after'), link(1, 9, 'after'), link(1, 3)], lookup), [
    { on: 3, reason: '#3 is not done yet' },
    { on: 4, reason: '#4 failed' },
  ]);
  assert.deepEqual(mergeHold([], lookup), []);
});

test('linkError refuses a self link, a repeat and every kind of cycle', () => {
  assert.match(linkError(1, 1, [])!, /itself/);
  assert.equal(linkError(1, 2, []), null);
  assert.match(linkError(1, 2, [link(1, 2, 'after')])!, /already linked/);
  assert.match(linkError(1, 2, [link(1, 2)])!, /already linked/);
  // Direct: 2 already depends on 1.
  assert.match(linkError(1, 2, [link(2, 1)])!, /cycle/);
  // Through a chain, of either kind and mixed.
  assert.match(linkError(1, 2, [link(2, 3), link(3, 1)])!, /cycle/);
  assert.match(linkError(1, 2, [link(2, 3, 'after'), link(3, 4), link(4, 1, 'after')])!, /cycle/);
  // Not a cycle: a diamond, and an unrelated branch.
  assert.equal(linkError(1, 2, [link(1, 3), link(3, 4), link(2, 4)]), null);
  assert.equal(linkError(1, 2, [link(2, 3), link(4, 1)]), null);
});

test('migration 18 turns an existing after_task into a builds-on link', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, MIGRATIONS.slice(0, 17));
  raw.exec("INSERT INTO repos (name, path) VALUES ('r', '/r')");
  const task = "INSERT INTO tasks (repo_id, title, prompt, model, max_turns, max_attempts, after_task) VALUES (1, 't', 'p', 'm', 5, 2, ";
  raw.exec(`${task}NULL)`);
  raw.exec(`${task}1)`);
  raw.exec(`${task}2)`);
  assert.equal(migrate(raw, MIGRATIONS), MIGRATIONS.length - 17);
  assert.deepEqual(
    raw
      .prepare('SELECT task_id, on_task, kind FROM task_links ORDER BY task_id')
      .all()
      .map((r) => ({ ...r })),
    [
      { task_id: 2, on_task: 1, kind: 'builds_on' },
      { task_id: 3, on_task: 2, kind: 'builds_on' },
    ],
  );
  raw.close();
});

test('the store lists links and dependents, and addTask writes after_task as one builds-on link', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const add = (after_task?: number) => db.addTask({ repo_id: repo.id, title: 't', prompt: 'p', after_task });
  const a = add();
  const b = add(a.id);
  const c = add();
  assert.deepEqual(db.linksOf(b.id), [{ task_id: b.id, on: a.id, kind: 'builds_on' }]);
  db.addLink({ task_id: c.id, on: a.id, kind: 'after' });
  db.addLink({ task_id: c.id, on: b.id, kind: 'builds_on' });
  assert.deepEqual(
    db.dependentsOf(a.id).map((t) => t.id),
    [b.id, c.id],
  );
  assert.deepEqual(
    db.dependentsOf(a.id, 'after').map((t) => t.id),
    [c.id],
  );
  assert.equal(db.allLinks().length, 3);
  assert.equal(db.removeLink(c.id, a.id), true);
  assert.equal(db.removeLink(c.id, a.id), false);
  assert.deepEqual(db.linksOf(c.id), [{ task_id: c.id, on: b.id, kind: 'builds_on' }]);
  db.close();
});

test('a task with two builds-on links is claimed only once both are met; an after link never holds it', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const add = () => db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const a = add();
  const b = add();
  const slow = add();
  const both = add();
  db.addLink({ task_id: both.id, on: a.id, kind: 'builds_on' });
  db.addLink({ task_id: both.id, on: b.id, kind: 'builds_on' });
  db.addLink({ task_id: both.id, on: slow.id, kind: 'after' });
  // Take the other tasks out of the queue: a and b run, slow too.
  for (const t of [a, b, slow]) assert.ok(db.applyEvent(t.id, { type: 'claim' }));
  assert.equal(db.claimNextTask(), undefined, 'neither is done');
  assert.ok(db.applyEvent(a.id, { type: 'finish', outcome: 'done' }));
  assert.equal(db.claimNextTask(), undefined, 'only one is done');
  assert.ok(db.applyEvent(b.id, { type: 'finish', outcome: 'done' }));
  assert.equal(db.claimNextTask()?.id, both.id, 'both are done; the running after link does not hold the start');
  db.close();
});

test("repo deletion removes its tasks' links", () => {
  const db = openDb(':memory:');
  const keep = db.addRepo({ name: 'keep', path: '/tmp/keep', base_branch: 'main' });
  const gone = db.addRepo({ name: 'gone', path: '/tmp/gone', base_branch: 'main' });
  const k = db.addTask({ repo_id: keep.id, title: 'k', prompt: 'p' });
  const g = db.addTask({ repo_id: gone.id, title: 'g', prompt: 'p' });
  db.addLink({ task_id: k.id, on: g.id, kind: 'after' });
  db.addLink({ task_id: g.id, on: k.id, kind: 'builds_on' });
  db.setRepoArchived(gone.id, true);
  assert.equal(db.deleteRepo(gone.id), true);
  assert.deepEqual(db.allLinks(), []);
  db.close();
});
