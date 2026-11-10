import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { attemptEnds, sincePoints } from '../../../src/domain/work/read/since.ts';
import type { TaskId } from '../../../src/domain/shared/id.ts';
import { SINCE_BASE, shownSince, sinceKey, sinceLabel } from '../../../../app/src/lib/work/files/since.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-since-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../fixtures/open-db.ts');
const actions = await import('../../../src/application/actions.ts');

const db = openDb(join(home, 'test.db'));
after(() => db.close());

const c = (sha: string, committed_at: string) => ({ sha, committed_at });
const run = (attempt: number, ended_at: string | null, kind = 'work') => ({ kind, attempt, ended_at });
const COMMITS = [c('c3', '2026-11-01 12:00:00'), c('c2', '2026-11-01 11:00:00'), c('c1', '2026-11-01 10:00:00')];

const ENDS: { rule: string; commits: ReturnType<typeof c>[]; runs: ReturnType<typeof run>[]; want: [number, string][] }[] = [
  {
    rule: 'each attempt ends at the last commit made before its run ended',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 10:30:00'), run(2, '2026-11-01 12:30:00')],
    want: [
      [1, 'c1'],
      [2, 'c3'],
    ],
  },
  {
    rule: 'a commit made in the second the run ended is in it',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 11:00:00')],
    want: [[1, 'c2']],
  },
  {
    rule: 'a run with no commits before its end has no end',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 09:00:00')],
    want: [],
  },
  {
    rule: 'an attempt that committed nothing ends where the one before it did, so it is left out',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 11:30:00'), run(2, '2026-11-01 11:45:00'), run(3, '2026-11-01 12:30:00')],
    want: [
      [1, 'c2'],
      [3, 'c3'],
    ],
  },
  {
    rule: 'a resolve run is left out: it commits its sync merge before it ends',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 10:30:00'), run(1, '2026-11-01 11:30:00', 'resolve'), run(1, '2026-11-01 11:40:00', 'unblock')],
    want: [[1, 'c1']],
  },
  {
    rule: 'review runs are left out',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 12:30:00', 'review')],
    want: [],
  },
  {
    rule: 'a run with no end is skipped',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 10:30:00'), run(2, null)],
    want: [[1, 'c1']],
  },
  {
    rule: 'the last work run of an attempt counts, whatever order the runs come in',
    commits: COMMITS,
    runs: [run(1, '2026-11-01 11:30:00'), run(1, '2026-11-01 10:30:00')],
    want: [[1, 'c2']],
  },
  {
    rule: 'two commits in the same second: the newer, listed first, is the end',
    commits: [c('b', '2026-11-01 10:00:00'), c('a', '2026-11-01 10:00:00')],
    runs: [run(1, '2026-11-01 10:00:00')],
    want: [[1, 'b']],
  },
];

for (const row of ENDS)
  test(`attemptEnds: ${row.rule}`, () => {
    assert.deepEqual(
      attemptEnds(row.commits, row.runs).map((e) => [e.attempt, e.sha]),
      row.want,
    );
  });

test('sincePoints: the last person review first, then earlier attempts newest first, only behind the head', () => {
  const runs = [run(1, '2026-11-01 10:30:00'), run(2, '2026-11-01 11:30:00'), run(3, '2026-11-01 12:30:00')];
  const review = (by: string, submitted_at: string | null, head_commit: string | null) => ({ by, submitted_at, head_commit });
  const reviews = [
    review('person', '2026-11-01 10:40:00', 'c1'),
    review('person', '2026-11-01 11:40:00', 'c2'),
    review('review_run', '2026-11-01 12:40:00', 'c3'),
    review('person', null, null),
  ];
  assert.deepEqual(sincePoints(COMMITS, runs, reviews, 'c3'), [
    { kind: 'review', sha: 'c2', attempt: null, at: '2026-11-01 11:40:00' },
    { kind: 'attempt', sha: 'c2', attempt: 2, at: '2026-11-01 11:30:00' },
    { kind: 'attempt', sha: 'c1', attempt: 1, at: '2026-11-01 10:30:00' },
  ]);
  assert.deepEqual(
    sincePoints(COMMITS, runs, [review('person', '2026-11-01 12:40:00', 'c3')], 'c3').map((p) => p.kind),
    ['attempt', 'attempt'],
    'a review of the head offers nothing',
  );
  assert.deepEqual(
    sincePoints(COMMITS, [], [review('person', '2026-11-01 12:40:00', 'gone')], 'c3'),
    [],
    'a review of a commit no longer on the branch offers nothing',
  );
});

test('shownSince: the pick while it is offered, else the last review, else the base', () => {
  const reviewPoint = { kind: 'review' as const, sha: 'r', attempt: null, at: '2026-11-01 11:40:00' };
  const run1 = { kind: 'attempt' as const, sha: 'c1', attempt: 1, at: '2026-11-01 10:30:00' };
  assert.equal(shownSince([reviewPoint, run1], null), reviewPoint, 'opens on the last review');
  assert.equal(shownSince([run1], null), null, 'with no review behind the head, opens on the base');
  assert.equal(shownSince([reviewPoint, run1], SINCE_BASE), null);
  assert.equal(shownSince([reviewPoint, run1], sinceKey(run1)), run1);
  assert.equal(shownSince([reviewPoint], 'attempt-1'), reviewPoint, 'a pick no longer offered falls back');
  assert.equal(sinceKey(reviewPoint), 'review');
  assert.equal(sinceLabel(run1), 'Since the end of run 1');
});

let repos = 0;
const now = Date.now();
const at = (s: number) => `@${Math.floor(now / 1000) + s} +0000`;

function newRepo() {
  const path = join(home, `repo-${++repos}`);
  mkdirSync(path);
  const git = (args: string[], when?: number) =>
    execFileSync('git', args, {
      cwd: path,
      encoding: 'utf8',
      env: when === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: at(when), GIT_COMMITTER_DATE: at(when) },
    }).trim();
  const write = (file: string, text: string) => writeFileSync(join(path, file), text);
  const commit = (message: string, when: number) => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], when);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 't']);
  write('a.txt', 'a1\na2\na3\n');
  write('b.txt', 'b1\nb2\nb3\n');
  commit('init', -1000);
  git(['checkout', '-q', '-b', 'agentdeck/task-1']);
  const repo = db.addRepo({ name: `repo-${repos}`, path, base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  db.setCheckout(task.id, { branch: 'agentdeck/task-1' });
  return { path, git, write, commit, task: task.id };
}

function workRun(task: TaskId, attempt: number, open = false) {
  const id = db.startRun(task, attempt, join(home, `run-${task}-${attempt}.jsonl`));
  if (!open) db.finishRun(id, { outcome: 'done' });
}

test('since attempt 1: only what attempt 2 changed, not what a sync brought in from the base', async () => {
  const r = newRepo();
  r.write('a.txt', 'a1\nA2\na3\n');
  const attempt1 = r.commit('Attempt 1', -300);
  workRun(r.task, 1);

  r.git(['checkout', '-q', 'main']);
  r.write('c.txt', 'from the base\n');
  r.commit('Base work', 50);
  r.git(['checkout', '-q', 'agentdeck/task-1']);
  r.git(['merge', '-q', '--no-edit', 'main'], 100);
  const synced = r.git(['rev-parse', 'HEAD']);

  r.write('b.txt', 'b1\nB2\nb3\n');
  const head = r.commit('Attempt 2', 200);
  workRun(r.task, 2, true);

  r.git(['checkout', '-q', 'main']);
  r.write('d.txt', 'later\n');
  r.commit('Later base work', 250);
  r.git(['checkout', '-q', 'agentdeck/task-1']);

  const review = db.createReview(r.task);
  db.submitReview(review.id, 'comment', 'ok so far', { head_commit: synced, diff_hash: null });

  const all = await actions.taskChanges(db, r.task);
  assert.equal(all.since, null);
  assert.deepEqual(
    all.files.map((f) => f.path),
    ['a.txt', 'b.txt'],
  );
  assert.deepEqual(
    all.since_points.map((p) => [p.kind, p.sha, p.attempt]),
    [
      ['review', synced, null],
      ['attempt', attempt1, 1],
    ],
  );
  assert.equal(all.since_points[1].at, db.runsForTask(r.task)[0].ended_at);

  const since = await actions.taskChanges(db, r.task, attempt1);
  assert.equal(since.since, attempt1);
  assert.equal(since.base_may_show, false);
  assert.equal(since.head, head);
  assert.deepEqual(
    since.files.map((f) => f.path),
    ['b.txt'],
    'c.txt came in with the sync and d.txt is not synced: neither shows',
  );
  assert.ok(since.commits.some((c) => c.sha === head));
  assert.ok(!since.commits.some((c) => c.sha === attempt1));
  assert.ok(!since.commits.some((c) => c.subject === 'Base work'));
  assert.deepEqual(since.since_points, all.since_points);
  assert.match(r.git(['diff', '--name-only', attempt1, head]), /c\.txt/);

  const patch = await actions.taskDiff(db, r.task, 'b.txt', attempt1);
  assert.match(patch.patch, /-b2\n\+B2/);
  await assert.rejects(actions.taskDiff(db, r.task, 'a.txt', attempt1), /not changed on this task's branch since/);
  await assert.rejects(actions.taskDiff(db, r.task, 'c.txt', attempt1), /not changed/);

  const sinceReview = await actions.taskChanges(db, r.task, synced);
  assert.deepEqual(
    sinceReview.files.map((f) => f.path),
    ['b.txt'],
  );
});

test('since a commit the base conflicts with: the diff is from it alone, and says the base changes may show', async () => {
  const r = newRepo();
  r.write('a.txt', 'a1\nTASK\na3\n');
  const attempt1 = r.commit('Attempt 1', -300);
  workRun(r.task, 1);

  r.git(['checkout', '-q', 'main']);
  r.write('a.txt', 'a1\nBASE\na3\n');
  r.write('c.txt', 'from the base\n');
  r.commit('Base work', 50);
  r.git(['checkout', '-q', 'agentdeck/task-1']);
  try {
    r.git(['merge', '-q', '--no-edit', 'main']);
  } catch {}
  r.write('a.txt', 'a1\nTASK and BASE\na3\n');
  r.commit('Resolve', 100);
  r.write('b.txt', 'b1\nB2\nb3\n');
  r.commit('Attempt 2', 200);

  const since = await actions.taskChanges(db, r.task, attempt1);
  assert.equal(since.base_may_show, true);
  assert.deepEqual(
    since.files.map((f) => f.path),
    ['a.txt', 'b.txt', 'c.txt'],
  );
  assert.match((await actions.taskDiff(db, r.task, 'c.txt', attempt1)).patch, /\+from the base/);
});

test('a since that is not a commit on the branch is refused', async () => {
  const r = newRepo();
  r.write('a.txt', 'changed\n');
  r.commit('Work', -100);
  const onMain = r.git(['rev-parse', 'main']);
  await assert.rejects(actions.taskChanges(db, r.task, onMain), /is not a commit on this task's branch/);
  await assert.rejects(actions.taskDiff(db, r.task, 'a.txt', onMain), /is not a commit on this task's branch/);
  await assert.rejects(actions.taskChanges(db, r.task, 'HEAD~1'), /since must be a whole commit id/);
});
