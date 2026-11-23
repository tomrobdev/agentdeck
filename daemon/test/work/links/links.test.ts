import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, migrate, openDb } from '#db/index.ts';
import { asTaskId } from '#test/fixtures/fixtures.ts';
import { parseTaskIds } from '#domain/work/task/ids.ts';
import {
  type Dependency,
  type Link,
  type LinkIndex,
  type LinkTarget,
  buildsOnError,
  buildsOnRepoError,
  linkError,
  linkState,
  prModeOffError,
  releasedBy,
  startState,
  stuckOn,
  unlandedAfter,
} from '#domain/work/links/link.ts';
import { type TaskStatus, transition } from '#domain/work/lifecycle/lifecycle.ts';

const done: Dependency = { status: 'done', pr: null, pr_mode: 'off', done_by: null };
const t1 = asTaskId(1);
const builds = { on: asTaskId(5), kind: 'builds_on' } as const;
const after = { on: asTaskId(5), kind: 'after' } as const;
const linkErr = (task: number, on: number, links: Link[]) => linkError(asTaskId(task), asTaskId(on), links);
const buildsErr = (id: number, status: TaskStatus, on: number) => buildsOnError(asTaskId(id), status, asTaskId(on));

test('linkState: every row of the rules table, for builds on', () => {
  const stuck = (reason: string) => ({ kind: 'stuck', on: 5, reason });
  const waiting = (reason: string) => ({ kind: 'waiting', on: 5, reason });
  assert.deepEqual(linkState(builds, done), { kind: 'met' });
  assert.deepEqual(linkState(builds, { ...done, pr: { state: 'merged' }, pr_mode: 'ready' }), { kind: 'met' });
  assert.deepEqual(linkState(builds, { ...done, done_by: 'person', pr_mode: 'ready' }), { kind: 'met' });
  assert.deepEqual(linkState(builds, { ...done, pr_mode: 'ready' }), waiting("#5's PR is not opened yet"));
  assert.deepEqual(linkState(builds, { ...done, done_by: 'person', pr: { state: 'open' } }), waiting("#5's PR is not merged yet"));
  assert.deepEqual(linkState(builds, { ...done, pr: { state: 'open' } }), waiting("#5's PR is not merged yet"));
  assert.deepEqual(linkState(builds, { ...done, status: 'queued' }), waiting('#5 is not done yet'));
  assert.deepEqual(linkState(builds, { ...done, status: 'running' }), waiting('#5 is not done yet'));
  assert.deepEqual(linkState(builds, { ...done, status: 'cancel_requested' }), waiting('#5 is not done yet'));
  assert.deepEqual(linkState(builds, { ...done, pr_mode: 'draft', pr: { state: 'failed' } }), stuck("#5's PR could not be opened"));
  assert.deepEqual(linkState(builds, { ...done, pr: { state: 'closed' } }), stuck("#5's PR was closed without merging"));
  assert.deepEqual(linkState(builds, { ...done, status: 'failed' }), stuck('#5 failed'));
  assert.deepEqual(linkState(builds, { ...done, status: 'blocked' }), stuck('#5 is blocked'));
  assert.deepEqual(linkState(builds, { ...done, status: 'cancelled' }), stuck('#5 was cancelled'));
  assert.deepEqual(linkState(builds, undefined), stuck('#5 no longer exists'));
});

test('linkState: an after link is met once the other landed, was rejected or is gone; otherwise it has not landed yet', () => {
  const unlanded = (reason: string) => ({ kind: 'unlanded', on: 5, reason });
  assert.deepEqual(linkState(after, done), { kind: 'met' });
  assert.deepEqual(linkState(after, undefined), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, pr: { state: 'merged' } }), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, status: 'cancelled' }), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, pr: { state: 'closed' } }), { kind: 'met' });
  assert.deepEqual(linkState(after, { ...done, status: 'proposed' }), unlanded('#5 is not done yet'));
  assert.deepEqual(linkState(after, { ...done, status: 'running' }), unlanded('#5 is not done yet'));
  assert.deepEqual(linkState(after, { ...done, pr: { state: 'open' } }), unlanded("#5's PR is not merged yet"));
  assert.deepEqual(linkState(after, { ...done, status: 'failed' }), unlanded('#5 failed'));
  assert.deepEqual(linkState(after, { ...done, status: 'blocked' }), unlanded('#5 is blocked'));
  assert.deepEqual(linkState(after, { ...done, pr_mode: 'ready', pr: { state: 'failed' } }), unlanded("#5's PR could not be opened"));
});

const world =
  (tasks: Record<number, Partial<Dependency> & { links?: Link[] }>) =>
  (id: number): LinkTarget | undefined => {
    const t = tasks[id];
    return t && { ...done, links: [], ...t };
  };
const link = (task_id: number, on: number, kind: Link['kind'] = 'builds_on'): Link => ({
  task_id: asTaskId(task_id),
  on: asTaskId(on),
  kind,
});

test('startState: none, met, waiting on every unmet link', () => {
  const lookup = world({ 2: {}, 3: { status: 'running' }, 4: { status: 'queued' } });
  assert.deepEqual(startState({ id: t1 }, [], lookup), { kind: 'none' });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2, 'after')], lookup), { kind: 'none' });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2)], lookup), { kind: 'met' });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2), link(1, 3), link(1, 4)], lookup), { kind: 'waiting', on: [3, 4] });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2), link(1, 3, 'after')], lookup), { kind: 'met' });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2), link(1, 9, 'after')], lookup), { kind: 'met' });
});

test('startState: stuck spreads down builds-on links, naming the root', () => {
  const lookup = world({
    2: { status: 'queued', links: [link(2, 4)] },
    3: { status: 'running' },
    4: { status: 'queued', links: [link(4, 5)] },
    5: { status: 'failed' },
  });
  const links = [link(1, 3), link(1, 2)];
  assert.deepEqual(startState({ id: t1 }, links, lookup), { kind: 'stuck', on: 5, reason: 'waits on #5 (via #2, #4), which failed' });
  assert.deepEqual(startState({ id: t1 }, [link(1, 4)], lookup), { kind: 'stuck', on: 5, reason: 'waits on #5 (via #4), which failed' });
  assert.deepEqual(
    startState({ id: t1 }, [link(1, 4)], world({ 4: { status: 'queued', links: [link(4, 5)] }, 5: { pr: { state: 'closed' } } })),
    { kind: 'stuck', on: 5, reason: 'waits on #5 (via #4), whose PR was closed without merging' },
  );
  const two = world({ 2: { status: 'blocked' }, 3: { status: 'failed' } });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2), link(1, 3)], two), { kind: 'stuck', on: 2, reason: '#2 is blocked' });
  assert.deepEqual(startState({ id: t1 }, [link(1, 2)], world({ 2: { status: 'queued', links: [link(2, 8)] } })), {
    kind: 'stuck',
    on: 8,
    reason: 'waits on #8 (via #2), which no longer exists',
  });
  assert.deepEqual(
    startState({ id: t1 }, [link(1, 2)], world({ 2: { status: 'queued', links: [link(2, 5, 'after')] }, 5: { status: 'failed' } })),
    {
      kind: 'waiting',
      on: [2],
    },
  );
  assert.deepEqual(startState({ id: t1 }, [link(1, 2)], world({ 2: { pr_mode: 'ready', links: [link(2, 5)] }, 5: { status: 'failed' } })), {
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
  assert.deepEqual(startState({ id: t1 }, [link(1, 2)], lookup), { kind: 'waiting', on: [2] });
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

function graph(tasks: Record<number, Partial<Dependency> & { links?: Link[] }>): LinkIndex {
  const all = Object.entries(tasks).map(([id, t]) => ({ id: asTaskId(Number(id)), ...done, links: [], ...t }));
  return {
    dependentsOf: (id) => all.flatMap((t) => t.links.filter((l) => l.on === id).map((l) => ({ id: t.id, status: t.status, kind: l.kind }))),
    linksOf: (id) => all.find((t) => t.id === id)?.links ?? [],
    target: (id) => all.find((t) => t.id === id) as LinkTarget | undefined,
  };
}

test('stuckOn names the dependents stuck on a task, and not one stuck on something else on the way', () => {
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
    stuckOn(t1, lookups).map((t) => t.id),
    [2, 3],
  );
  assert.deepEqual(
    stuckOn(asTaskId(5), lookups).map((t) => t.id),
    [4, 6],
  );
});

test('releasedBy lists only the dependents merging a task leaves free to start', () => {
  const review = { pr_mode: 'ready', pr: { state: 'open' } } as const;
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
    releasedBy(t1, lookups).map((t) => t.id),
    [3],
  );
  assert.deepEqual(releasedBy(asTaskId(2), lookups), []);
});

test('buildsOnRepoError refuses a builds-on link into a repo with pr_mode off; prModeOffError names the unmet tasks', () => {
  assert.equal(buildsOnRepoError(asTaskId(5), { name: 'demo', pr_mode: 'ready' }), null);
  assert.match(buildsOnRepoError(asTaskId(5), { name: 'demo', pr_mode: 'off' }) ?? '', /#5 is in demo, which opens no PRs/);
  assert.equal(prModeOffError('demo', []), null);
  assert.equal(
    prModeOffError('demo', [asTaskId(3)]),
    "demo can't stop opening PRs while #3 builds on a task that is not merged yet: wait for it to start, or cancel it",
  );
  assert.equal(
    prModeOffError('demo', [asTaskId(3), asTaskId(4)]),
    "demo can't stop opening PRs while #3, #4 build on a task that is not merged yet: wait for them to start, or cancel them",
  );
});

test('buildsOnError refuses a builds-on link once a task has started, pointing at an after link', () => {
  assert.equal(buildsErr(2, 'proposed', 1), null);
  assert.equal(buildsErr(2, 'queued', 1), null);
  for (const status of ['running', 'done', 'blocked', 'failed', 'cancelled'] as const)
    assert.match(buildsErr(2, status, 1)!, /started.*after link instead$/);
});

test('parseTaskIds reads lists and typed text, and refuses anything else', () => {
  assert.deepEqual(parseTaskIds(undefined), []);
  assert.deepEqual(parseTaskIds(''), []);
  assert.deepEqual(parseTaskIds([3, 1, 3]), [3, 1]);
  assert.deepEqual(parseTaskIds('12,#14 15'), [12, 14, 15]);
  for (const bad of ['12,x', [0], [1.5], ['abc'], 7, { a: 1 }]) assert.equal(parseTaskIds(bad), null);
});

test('linkError refuses a self link, a repeat and every kind of cycle', () => {
  assert.match(linkErr(1, 1, [])!, /itself/);
  assert.equal(linkErr(1, 2, []), null);
  assert.match(linkErr(1, 2, [link(1, 2, 'after')])!, /already linked/);
  assert.match(linkErr(1, 2, [link(1, 2)])!, /already linked/);
  assert.match(linkErr(1, 2, [link(2, 1)])!, /cycle/);
  assert.match(linkErr(1, 2, [link(2, 3), link(3, 1)])!, /cycle/);
  assert.match(linkErr(1, 2, [link(2, 3, 'after'), link(3, 4), link(4, 1, 'after')])!, /cycle/);
  assert.equal(linkErr(1, 2, [link(1, 3), link(3, 4), link(2, 4)]), null);
  assert.equal(linkErr(1, 2, [link(2, 3), link(4, 1)]), null);
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

test('the store lists links and dependents, and addTask turns after_task into one builds-on link', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const add = (after_task?: number) =>
    db.addTask({
      repo_id: repo.id,
      title: 't',
      prompt: 'p',
      links: after_task === undefined ? [] : [{ on: asTaskId(after_task), kind: 'builds_on' }],
    });
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
  db.updateRepo(repo.id, { max_concurrent: 2 });
  const add = () => db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const a = add();
  const b = add();
  const slow = add();
  const both = add();
  db.addLink({ task_id: both.id, on: a.id, kind: 'builds_on' });
  db.addLink({ task_id: both.id, on: b.id, kind: 'builds_on' });
  db.addLink({ task_id: both.id, on: slow.id, kind: 'after' });
  for (const t of [a, b, slow]) assert.ok(db.applyEvent(t.id, { type: 'claim' }));
  assert.equal(db.claimNextTask(), undefined, 'neither is done');
  assert.ok(db.applyEvent(a.id, { type: 'finish', outcome: 'done' }));
  assert.equal(db.claimNextTask(), undefined, 'only one is done');
  assert.ok(db.applyEvent(b.id, { type: 'finish', outcome: 'done' }));
  assert.equal(db.claimNextTask()?.id, both.id, 'both are done; the running after link does not hold the start');
  db.close();
});

test('linkState: a retried task whose old PR merged is not met until its new PR merges', () => {
  const waiting = (reason: string) => ({ kind: 'waiting', on: 5, reason });
  const merged: Dependency = { status: 'done', done_by: null, pr: { state: 'merged' }, pr_mode: 'ready' };
  assert.deepEqual(linkState(builds, merged), { kind: 'met' });
  const retry = transition({ ...merged, id: asTaskId(5), attempts: 1, max_attempts: 1, restarts: 0 }, { type: 'retry' })!;
  assert.equal(retry.changes.pr_state, null);
  assert.deepEqual(linkState(builds, { status: 'queued', pr: null, pr_mode: 'ready' }), waiting('#5 is not done yet'));
  const again: Dependency = { status: 'done', done_by: null, pr: null, pr_mode: 'ready' };
  assert.deepEqual(linkState(builds, again), waiting("#5's PR is not opened yet"));
  assert.deepEqual(linkState(builds, { ...again, pr: { state: 'open' } }), waiting("#5's PR is not merged yet"));
  assert.deepEqual(linkState(builds, { ...again, pr: { state: 'merged' } }), { kind: 'met' });
});

test('the claim waits on a retried task whose old PR merged until its new PR merges', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const dep = db.addTask({ repo_id: repo.id, title: 'dep', prompt: 'p' });
  assert.ok(db.applyEvent(dep.id, { type: 'claim' }));
  assert.ok(db.applyEvent(dep.id, { type: 'finish', outcome: 'done' }));
  assert.ok(db.recordPr(dep.id, { type: 'opened', url: 'https://x/pull/1' }));
  assert.ok(db.recordPr(dep.id, { type: 'seen', state: 'merged' }));
  const later = db.addTask({ repo_id: repo.id, title: 'later', prompt: 'p', links: [{ on: dep.id, kind: 'builds_on' }] });

  assert.ok(db.applyEvent(dep.id, { type: 'retry' }, { reason: 'one more thing' }));
  assert.equal(db.getTask(dep.id)!.pr, null, 'the retry set the merged PR aside');
  assert.equal(db.claimNextTask()?.id, dep.id, 'the retried task runs, the one building on it waits');
  assert.ok(db.applyEvent(dep.id, { type: 'finish', outcome: 'done' }));
  assert.equal(db.hasQueued(), false, 'done again, but its new PR is not opened yet');
  assert.equal(db.claimNextTask(), undefined);
  assert.ok(db.recordPr(dep.id, { type: 'opened', url: 'https://x/pull/2' }));
  assert.equal(db.claimNextTask(), undefined, 'the new PR is not merged yet');
  assert.ok(db.recordPr(dep.id, { type: 'seen', state: 'merged' }));
  assert.equal(db.claimNextTask()?.id, later.id);
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
