import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, migrate, openDb } from '../src/db/index.ts';
import { parseTaskIds } from '../src/domain/task/ids.ts';
import {
  type Dependency,
  type Link,
  type LinkLookups,
  type LinkTarget,
  buildsOnError,
  linkError,
  linkState,
  releasedBy,
  startState,
  stuckOn,
  unlandedAfter,
} from '../src/domain/task/link.ts';

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

test('linkState: an after link is met once the other landed, was rejected or is gone; otherwise it has not landed yet', () => {
  const unlanded = (reason: string) => ({ kind: 'unlanded', on: 5, reason });
  assert.deepEqual(linkState(after, done), { kind: 'met' });
  assert.deepEqual(linkState(after, undefined), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, pr_url: 'u', pr_state: 'merged' }), { kind: 'met' });
  // Rejected: cancelled (a rejected proposal is cancelled too) or its PR closed. It will never land, so the merge is free.
  assert.deepEqual(linkState(after, { ...done, status: 'cancelled' }), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, pr_url: 'u', pr_state: 'closed' }), { kind: 'met' });
  // Still able to land: on its way, or failed, blocked or a PR not opened, which a retry can fix.
  assert.deepEqual(linkState(after, { ...done, status: 'proposed' }), unlanded('#5 is not done yet'));
  assert.deepEqual(linkState(after, { ...done, status: 'running' }), unlanded('#5 is not done yet'));
  assert.deepEqual(linkState(after, { ...done, pr_url: 'u', pr_state: 'open' }), unlanded("#5's PR is not merged yet"));
  assert.deepEqual(linkState(after, { ...done, status: 'failed' }), unlanded('#5 failed'));
  assert.deepEqual(linkState(after, { ...done, status: 'blocked' }), unlanded('#5 is blocked'));
  assert.deepEqual(linkState(after, { ...done, pr_mode: 'ready', pr_state: 'failed' }), unlanded("#5's PR could not be opened"));
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
  assert.deepEqual(startState({ id: 1 }, links, lookup), { kind: 'stuck', on: 5, reason: 'waits on #5 (via #2, #4), which failed' });
  // One link down, as the plan words it.
  assert.deepEqual(startState({ id: 1 }, [link(1, 4)], lookup), { kind: 'stuck', on: 5, reason: 'waits on #5 (via #4), which failed' });
  assert.deepEqual(
    startState({ id: 1 }, [link(1, 4)], world({ 4: { status: 'queued', links: [link(4, 5)] }, 5: { pr_url: 'u', pr_state: 'closed' } })),
    { kind: 'stuck', on: 5, reason: 'waits on #5 (via #4), whose PR was closed without merging' },
  );
  // Two stuck links: the first one's root.
  const two = world({ 2: { status: 'blocked' }, 3: { status: 'failed' } });
  assert.deepEqual(startState({ id: 1 }, [link(1, 2), link(1, 3)], two), { kind: 'stuck', on: 2, reason: '#2 is blocked' });
  // A root that is gone is named too.
  assert.deepEqual(startState({ id: 1 }, [link(1, 2)], world({ 2: { status: 'queued', links: [link(2, 8)] } })), {
    kind: 'stuck',
    on: 8,
    reason: 'waits on #8 (via #2), which no longer exists',
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

test('unlandedAfter lists the after links whose other task has not landed', () => {
  const statuses: Record<number, Dependency> = {
    2: done,
    3: { ...done, status: 'running' },
    4: { ...done, status: 'failed' },
    6: { ...done, status: 'cancelled' },
  };
  const lookup = (id: number) => statuses[id];
  const after = [2, 3, 4, 6, 9].map((on) => link(1, on, 'after'));
  assert.deepEqual(unlandedAfter([...after, link(1, 3)], lookup), [
    { on: 3, reason: '#3 is not done yet' },
    { on: 4, reason: '#4 failed' },
  ]);
  assert.deepEqual(unlandedAfter([], lookup), []);
});

// Lookups for stuckOn and releasedBy over a small graph: each task's status, PR and links.
function graph(tasks: Record<number, Partial<Dependency> & { links?: Link[] }>): LinkLookups<{ id: number; status: string }> {
  const all = Object.entries(tasks).map(([id, t]) => ({ id: Number(id), ...done, links: [], ...t }));
  return {
    buildingOn: (id) => all.filter((t) => t.links.some((l) => l.on === id && l.kind === 'builds_on')),
    linksOf: (id) => all.find((t) => t.id === id)?.links ?? [],
    target: (id) => all.find((t) => t.id === id),
  };
}

test('stuckOn names the dependents stuck on a task, and not one stuck on something else on the way', () => {
  // 2 builds on 1 (failed); 3 builds on 2; 4 builds on 5 (cancelled), which builds on 1; 6 builds on 2 and on 5.
  const lookups = graph({
    1: { status: 'failed' },
    2: { status: 'queued', links: [link(2, 1)] },
    3: { status: 'queued', links: [link(3, 2)] },
    4: { status: 'queued', links: [link(4, 5)] },
    5: { status: 'cancelled', links: [link(5, 1)] },
    6: { status: 'queued', links: [link(6, 5), link(6, 2)] },
    7: { status: 'queued', links: [link(7, 1, 'after')] },
  });
  assert.deepEqual(
    stuckOn(1, lookups).map((t) => t.id),
    [2, 3],
  );
  assert.deepEqual(
    stuckOn(5, lookups).map((t) => t.id),
    [4, 6],
  );
});

test('releasedBy lists only the dependents merging a task leaves free to start', () => {
  // 1 and 2 are in review; 3 builds on 1; 4 builds on 1 and 2; 5 builds on 1 and on 6 (failed); 7 is running.
  const review = { pr_mode: 'ready', pr_url: 'u', pr_state: 'open' };
  const lookups = graph({
    1: review,
    2: review,
    3: { status: 'queued', links: [link(3, 1)] },
    4: { status: 'queued', links: [link(4, 1), link(4, 2)] },
    5: { status: 'queued', links: [link(5, 1), link(5, 6)] },
    6: { status: 'failed' },
    7: { status: 'running', links: [link(7, 1)] },
  });
  assert.deepEqual(
    releasedBy(1, lookups).map((t) => t.id),
    [3],
  );
  assert.deepEqual(releasedBy(2, lookups), []);
});

test('buildsOnError refuses a builds-on link once a task has started, pointing at an after link', () => {
  assert.equal(buildsOnError(2, 'proposed', 1), null);
  assert.equal(buildsOnError(2, 'queued', 1), null);
  for (const status of ['running', 'done', 'blocked', 'failed', 'cancelled'])
    assert.match(buildsOnError(2, status, 1)!, /started.*--after/);
});

test('parseTaskIds reads lists and typed text, and refuses anything else', () => {
  assert.deepEqual(parseTaskIds(undefined), []);
  assert.deepEqual(parseTaskIds(''), []);
  assert.deepEqual(parseTaskIds([3, 1, 3]), [3, 1]);
  assert.deepEqual(parseTaskIds('12,#14 15'), [12, 14, 15]);
  for (const bad of ['12,x', [0], [1.5], ['abc'], 7, { a: 1 }]) assert.equal(parseTaskIds(bad), null);
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
