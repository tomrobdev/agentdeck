// Pure tests of plans: parsing, file names, progress, the steps a task links, and the paths a prompt names.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '../../src/domain/shared/index.ts';
import type { ListedTask } from '../../src/domain/work/read/listing.ts';
import {
  filterTasks,
  hasPlanLink,
  isOwnPlanName,
  linkedSteps,
  listable,
  matchPath,
  missingFollowedSteps,
  otherPlanOwner,
  parsePlan,
  pathsNamedIn,
  planAfterRun,
  planFileName,
  planOwnerOf,
  planProgress,
  sincePoints,
  toPlan,
  unfinishedSteps,
  unfinishedSummary,
} from '../../src/domain/work/index.ts';

const html = (steps: string) =>
  `<html data-agentdeck-plan="1"><head><title>My plan</title></head><body><p data-plan-summary>Why</p>${steps}</body></html>`;
const section = (id: string, status: string, extra = '') =>
  `<section data-plan-step id="${id}" data-status="${status}"><h2>Step ${id}</h2>${extra}</section>`;
const two = html(section('a', 'done') + section('b', 'todo', '<ul data-plan-done><li>x</li><li>y</li></ul>'));

test('parsePlan reads the title, summary and each step with its status and done criteria; a page without the marker is no plan', () => {
  const plan = parsePlan(two);
  assert.equal(plan?.title, 'My plan');
  assert.equal(plan?.summary, 'Why');
  assert.deepEqual(
    plan?.steps.map((s) => [s.id, s.title, s.status, s.done]),
    [
      ['a', 'Step a', 'done', []],
      ['b', 'Step b', 'todo', ['x', 'y']],
    ],
  );
  assert.equal(parsePlan('<html><body>no</body></html>'), null);
  assert.equal(parsePlan(html(section('c', 'weird')))?.steps[0].status, 'todo');
});

test('toPlan parses the html of an own plan, and falls back to an untitled empty plan', () => {
  const row = { id: 1, task_id: asTaskId(2), name: '2-x.html', source: 'attached' as const, created_at: 'a', updated_at: 'b' };
  assert.equal(toPlan({ ...row, html: two }).steps.length, 2);
  assert.deepEqual(toPlan({ ...row, html: 'nothing' }).steps, []);
  assert.equal(toPlan({ ...row, html: 'nothing' }).title, 'Untitled plan');
});

test('a plan file is <task id>-<slug>.html, and a name is the own plan name of that task only', () => {
  assert.equal(planFileName(12, 'Lock Down: the Domain!'), '12-lock-down-the-domain.html');
  assert.equal(planFileName(3, '!!!'), '3-plan.html');
  assert.ok(isOwnPlanName(12, '12-lock-down.html'));
  assert.ok(!isOwnPlanName(12, '13-lock-down.html'));
  assert.ok(!isOwnPlanName(12, '12-Lock.html'));
});

test('progress counts done and skipped steps as finished; the unfinished ones are summarised by id and status', () => {
  const steps = parsePlan(two)?.steps ?? [];
  assert.deepEqual(planProgress(steps), { finished: 1, total: 2 });
  assert.deepEqual(
    unfinishedSteps(steps).map((s) => s.id),
    ['b'],
  );
  assert.equal(unfinishedSummary(unfinishedSteps(steps)), 'left a linked plan step unfinished: b (todo)');
  assert.equal(unfinishedSummary([...steps, ...steps]), 'left linked plan steps unfinished: a (done), b (todo), a (done), b (todo)');
});

test('linkedSteps keeps the steps a task links, all when it links none, and nothing for a page that is no plan', () => {
  assert.deepEqual(
    linkedSteps(two, ['b'])?.map((s) => s.id),
    ['b'],
  );
  assert.equal(linkedSteps(two, null)?.length, 2);
  assert.equal(linkedSteps('x', null), null);
});

test('planAfterRun keeps the stored plan if the written one is no plan, takes the written one for an untouched own plan, else merges the linked steps', () => {
  const stored = html(section('a', 'todo') + section('b', 'todo'));
  const written = html(section('a', 'done') + section('b', 'doing'));
  const run = { stored, given: stored, written, ids: null, own: true, followed: false };
  assert.equal(planAfterRun({ ...run, written: 'junk' }), stored);
  assert.equal(planAfterRun(run), written);
  const merged = planAfterRun({ ...run, own: false, ids: ['a'] });
  assert.equal(parsePlan(merged)?.steps[0].status, 'done');
  assert.equal(parsePlan(merged)?.steps[1].status, 'todo');
  assert.equal(planAfterRun({ ...run, own: false, given: null, ids: ['a'], written: stored }), stored);
});

test('missingFollowedSteps names the linked step ids a plan no longer has', () => {
  const plan = parsePlan(two);
  assert.ok(plan);
  assert.deepEqual(
    missingFollowedSteps(plan, [
      { id: 1, steps: ['a', 'zz'] },
      { id: 2, steps: null },
      { id: 3, steps: ['b'] },
    ]),
    [{ id: 1, missing: ['zz'] }],
  );
});

test('a task follows its own plan unless it links another task, whose id then owns it', () => {
  const own = { id: asTaskId(5), plan: null };
  const linked = { id: asTaskId(5), plan: { task: asTaskId(2), steps: null } };
  assert.equal(planOwnerOf(own), 5);
  assert.equal(planOwnerOf(linked), 2);
  assert.ok(!hasPlanLink(own) && hasPlanLink(linked));
  assert.equal(otherPlanOwner(own), null);
  assert.equal(otherPlanOwner(linked), 2);
  assert.equal(otherPlanOwner({ id: asTaskId(5), plan: { task: asTaskId(5), steps: null } }), null);
});

test('pathsNamedIn finds repo paths the prompt tells the worker to read, and skips ones it creates, urls and code blocks', () => {
  assert.deepEqual(pathsNamedIn('Read `daemon/src/a.ts` and docs/b.md.'), ['daemon/src/a.ts', 'docs/b.md']);
  assert.deepEqual(pathsNamedIn('Create `daemon/src/new.ts` and read src/old.ts'), ['src/old.ts']);
  assert.deepEqual(pathsNamedIn('See https://example.com/a/b.html and `/etc/x.conf` and ../up/x.ts'), []);
  assert.deepEqual(pathsNamedIn('```\nsrc/in-code.ts\n```\nsrc/out.ts#L10'), ['src/out.ts']);
  assert.deepEqual(pathsNamedIn('Look in `daemon/src/domain/`'), ['daemon/src/domain/']);
  assert.deepEqual(pathsNamedIn('Move the code into src/moved.ts from src/from.ts'), ['src/from.ts']);
});

test('matchPath finds a path as written, under a subfolder, or not at all, for files and folders', () => {
  const files = ['a/b.ts', 'pkg/a/b.ts', 'x/dir/c.ts'];
  assert.deepEqual(matchPath('a/b.ts', files), { kind: 'exact' });
  assert.deepEqual(matchPath('b.ts', files), { kind: 'under', as: 'a/b.ts' });
  assert.deepEqual(matchPath('nope.ts', files), { kind: 'missing' });
  assert.deepEqual(matchPath('a/', files), { kind: 'exact' });
  assert.deepEqual(matchPath('dir/', files), { kind: 'under', as: 'x/dir/' });
  assert.deepEqual(matchPath('gone/', files), { kind: 'missing' });
});

test('sincePoints offers the head a person last reviewed and the end of each earlier attempt, never the head itself', () => {
  const commits = [
    { sha: 'c1', committed_at: '2026-01-01 10:00:00' },
    { sha: 'c2', committed_at: '2026-01-01 12:00:00' },
    { sha: 'c3', committed_at: '2026-01-01 14:00:00' },
  ];
  const runs = [
    { kind: 'work', attempt: 1, ended_at: '2026-01-01 11:00:00' },
    { kind: 'work', attempt: 2, ended_at: '2026-01-01 13:00:00' },
    { kind: 'work', attempt: 3, ended_at: null },
    { kind: 'sync', attempt: 1, ended_at: '2026-01-01 13:30:00' },
  ];
  const reviews = [
    { by: 'person', submitted_at: '2026-01-01 12:30:00', head_commit: 'c2' },
    { by: 'agent', submitted_at: '2026-01-01 13:30:00', head_commit: 'c3' },
  ];
  const points = sincePoints(commits, runs, reviews, 'c3');
  assert.deepEqual(
    points.map((p) => [p.kind, p.sha, p.attempt]),
    [
      ['review', 'c2', null],
      ['attempt', 'c2', 2],
      ['attempt', 'c1', 1],
    ],
  );
  assert.deepEqual(
    sincePoints(commits, runs, reviews, 'c2').map((p) => p.sha),
    ['c1'],
  );
  assert.deepEqual(sincePoints(commits, [], [], 'c3'), []);
});

const listed = (id: number, over: Record<string, unknown> = {}) =>
  ({
    id,
    repo_id: 1,
    title: `task ${id}`,
    status: 'queued',
    priority: 0,
    model: 'sonnet',
    source: 'manual',
    waiting: null,
    updated_at: `2026-01-0${id} 00:00:00`,
    stop_reason: null,
    pr_url: null,
    pr_state: null,
    branch: null,
    ...over,
  }) as unknown as Parameters<typeof filterTasks>[0][number];

test('listable flattens a task for listing: its stop reason, branch and pull request', () => {
  const t = listable({
    status: 'blocked',
    stop_reason: 'why',
    needs: null,
    question: null,
    pr: { url: 'u', state: 'open' },
    checkout: { branch: 'b', worktree: null, syncing_since: null },
  } as unknown as ListedTask & { pr: never; checkout: never });
  assert.deepEqual([t.stop_reason, t.branch, t.pr_url, t.pr_state], ['why', 'b', 'u', 'open']);
  const bare = listable({ status: 'queued', pr: null, checkout: null } as unknown as ListedTask & { pr: never; checkout: never });
  assert.deepEqual([bare.stop_reason, bare.branch, bare.pr_url, bare.pr_state], [null, null, null, null]);
});

test('filterTasks keeps what matches a state, repo, source or search, in the order asked, and refuses an unknown state or sort', () => {
  const tasks = [
    listed(1),
    listed(2, { status: 'blocked', stop_reason: 'needs deps', priority: 5 }),
    listed(3, { status: 'done', pr_state: 'open', pr_url: 'u', repo_id: 2, repo: 'other', source: 'planner' }),
  ];
  const ids = (f: Parameters<typeof filterTasks>[1]) => filterTasks(tasks, f).map((t) => t.id);
  assert.deepEqual(ids({ states: [], sort: 'oldest' }), [1, 2, 3]);
  assert.deepEqual(ids({ states: [], sort: 'newest' }), [3, 2, 1]);
  assert.deepEqual(ids({ states: ['needs-you'], sort: 'attention' }), [2]);
  assert.deepEqual(ids({ states: ['pr-open', 'queued'], sort: 'oldest' }), [1, 3]);
  assert.deepEqual(ids({ states: ['active'], sort: 'oldest' }), [1]);
  assert.deepEqual(ids({ states: [], sort: 'priority' }), [2, 3, 1]);
  assert.deepEqual(ids({ states: [], sort: 'updated' }), [3, 2, 1]);
  assert.deepEqual(ids({ states: [], sort: 'oldest', source: 'planner' }), [3]);
  assert.deepEqual(ids({ states: [], sort: 'oldest', repos: ['other'] }), [3]);
  assert.deepEqual(ids({ states: [], sort: 'oldest', repos: ['?'] }), [1, 2]);
  assert.deepEqual(ids({ states: [], sort: 'oldest', search: '#2' }), [2]);
  assert.deepEqual(ids({ states: [], sort: 'oldest', search: 'deps' }), [2]);
  assert.throws(() => filterTasks(tasks, { states: ['nope'], sort: 'oldest' }), /unknown state "nope"/);
  assert.throws(() => filterTasks(tasks, { states: [], sort: 'nope' }), /unknown sort "nope"/);
});
