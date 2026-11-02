import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-context-'));
process.env.AGENTDECK_HOME = home;

const { openDb } = await import('../src/db/index.ts');
const { liveContext, repoForPath } = await import('../src/application/actions.ts');
const { DIGEST_LIMIT, describeEvent, digest } = await import('../src/domain/task/digest.ts');
const { WORKTREE_DIR } = await import('../src/config.ts');

const CLI = join(import.meta.dirname, '../src/cli.ts');

const header = {
  repo: 'r',
  paused: false,
  repo_paused: null,
  running: 1,
  max_concurrent: 2,
  governor: { allow: true, reason: null },
  head: { branch: 'main', commit: 'abc1234', subject: 'Last commit' },
};

test('describeEvent words each kind of history row', () => {
  const say = (type: string, to_status: string | null, reason: string | null = null) =>
    describeEvent({ type, to_status, reason } as Parameters<typeof describeEvent>[0]);
  assert.equal(say('created', 'queued'), 'added');
  assert.equal(say('created', 'proposed'), 'proposed');
  assert.equal(say('claim', 'running'), 'started');
  assert.equal(say('finish', 'done'), 'done');
  assert.equal(say('finish', 'blocked', 'STATUS: BLOCKED: no tests\nmore'), 'blocked: STATUS: BLOCKED: no tests');
  assert.equal(say('finish', 'queued', 'tests failed'), 'failed, queued to retry: tests failed');
  assert.equal(say('rate_limited', 'queued'), 'queued again: usage limit');
  assert.equal(say('rate_limited', 'cancelled'), 'cancelled');
  assert.equal(say('recover', 'cancelled', 'x'), 'cancelled');
  assert.equal(say('environment_block', 'cancelled', 'no network'), 'cancelled');
  assert.equal(say('merge', 'done', 'requested (squash)'), 'PR merged as requested (squash)');
  assert.equal(say('pr', 'done', 'PR is merged'), 'PR merged');
  assert.equal(say('recover', 'queued'), 'queued again after a daemon restart');
  assert.equal(say('recover', 'failed', 'too many restarts'), 'failed after daemon restarts: too many restarts');
  assert.equal(say('conflict', 'blocked'), 'blocked: conflict');
  assert.equal(say('cancel', 'cancel_requested'), 'cancel requested');
  assert.equal(say('cancel', 'cancelled'), 'cancelled');
  assert.equal(say('approve', 'queued'), 'approved');
  assert.equal(say('reject', 'cancelled'), 'rejected');
  assert.equal(say('retry', 'queued', 'add a test'), 'retried: add a test');
  assert.equal(say('mark_done', 'done'), 'marked done by a person');
  assert.equal(say('pr_merged', 'done'), 'PR merged');
  assert.equal(say('merge', 'done', 'auto-merged (squash)'), 'PR auto-merged (squash)');
  assert.equal(say('merge', 'done', 'squash merge'), 'PR merged (squash merge)');
  assert.equal(say('pr', 'done', 'opened https://x/pull/1'), 'PR opened');
  assert.equal(say('pr', 'done', 'closed without merging'), 'PR: closed without merging');
  assert.equal(say('sync', 'done'), 'synced with the base branch');
  assert.equal(say('plan_unfinished', 'done'), 'left plan steps unfinished');
  assert.equal(say('environment_block', 'blocked', 'no network'), 'blocked by the environment: no network');
});

test('digest: a quiet turn is the header alone; a start shows the open tasks', () => {
  const open = [{ id: 3, title: 'Three', status: 'queued' as const, pr_state: null, stop_reason: null, waiting: { on: [2], stuck: null } }];
  const quiet = digest({ header, events: [], open, full: false });
  assert.equal(quiet.length, 1);
  assert.match(quiet[0], /^AgentDeck live · r · active · 1\/2 slots · governor allowing · main abc1234 Last commit$/);
  assert.deepEqual(digest({ header, events: [], open, full: true }).slice(1), ['Open:', '  queued #3 Three (waiting on #2)']);
  assert.deepEqual(digest({ header, events: [], open: [], full: true }).slice(1), ['Open: nothing']);
});

test('digest groups changes by task, in order, and shows the open tasks with them', () => {
  const ev = (id: number, task_id: number, type: string, to_status: string, reason: string | null = null) =>
    ({ id, task_id, type, from_status: null, to_status, reason, title: `Task ${task_id}` }) as Parameters<typeof digest>[0]['events'][0];
  const lines = digest({
    header: { ...header, governor: { allow: false, reason: '5h window at 90%' }, repo_paused: 'doctor failed' },
    events: [ev(1, 7, 'claim', 'running'), ev(2, 8, 'created', 'queued'), ev(3, 7, 'finish', 'done')],
    open: [{ id: 9, title: 'Nine', status: 'blocked', pr_state: null, stop_reason: 'needs a key', waiting: null }],
    full: false,
  });
  assert.match(lines[0], /repo PAUSED: doctor failed · 1\/2 slots · governor on hold: 5h window at 90%/);
  assert.deepEqual(lines.slice(1), [
    'Since your last message:',
    '  #7 Task 7: started · done',
    '  #8 Task 8: added',
    'Open:',
    '  blocked #9 Nine — needs a key',
  ]);
});

test('digest cuts the lines below the header at the limit and counts the rest', () => {
  const open = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    title: `T${i + 1}`,
    status: 'queued' as const,
    pr_state: null,
    stop_reason: null,
    waiting: null,
  }));
  const lines = digest({ header, events: [], open, full: true });
  assert.equal(lines.length, 1 + DIGEST_LIMIT);
  assert.equal(lines.at(-1), '  +10 more: agentdeck ls');
});

test('digest: 30 events still leave "Open:" with the tasks that need you', () => {
  const events = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    task_id: i + 1,
    type: 'claim',
    from_status: null,
    to_status: 'running',
    reason: null,
    title: `T${i + 1}`,
  })) as Parameters<typeof digest>[0]['events'];
  const open = [
    { id: 40, title: 'Quiet', status: 'queued' as const, pr_state: null, stop_reason: null, waiting: null },
    { id: 41, title: 'Stuck', status: 'blocked' as const, pr_state: null, stop_reason: 'needs a key', waiting: null },
  ];
  const lines = digest({ header, events, open, full: false });
  assert.ok(lines.length <= 1 + DIGEST_LIMIT);
  assert.ok(lines.some((l) => /\+\d+ more: agentdeck ls/.test(l)));
  assert.ok(lines.indexOf('  blocked #41 Stuck — needs a key') > lines.indexOf('Open:'));
});

test('digest: the header names a usage-limit backoff', () => {
  const until = Math.floor(Date.now() / 1000) + 3600;
  const [line] = digest({ header: { ...header, rate_limited_until: until }, events: [], open: [], full: false });
  assert.match(line, /slots · usage limit until \d\d:\d\d · governor allowing/);
  assert.doesNotMatch(line, /hold/);
});

function setup(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `agentdeck-context-${name}-`));
  const db = openDb(join(dir, 'test.db'));
  const repoDir = join(dir, 'repo');
  mkdirSync(join(repoDir, 'sub'), { recursive: true });
  const repo = db.addRepo({ name, path: repoDir, base_branch: 'main' });
  return { db, repo, repoDir };
}

test('liveContext: the open tasks first, then only what changed after the cursor, in this repo', async () => {
  const { db, repo } = setup('live');
  const other = db.addRepo({ name: 'other', path: join(tmpdir(), 'nowhere'), base_branch: 'main' });
  const a = db.addTask({ repo_id: repo.id, title: 'First', prompt: 'p' });
  db.addTask({ repo_id: repo.id, title: 'Second', prompt: 'p' });

  const start = await liveContext(db, { repo, after: null, full: true });
  assert.ok(start.lines.includes('Open:'));
  assert.ok(start.lines.some((l) => l.includes(`queued #${a.id} First`)));
  assert.equal(start.cursor, db.lastEventId());

  const quiet = await liveContext(db, { repo, after: start.cursor, full: false });
  assert.equal(quiet.lines.length, 1, 'nothing changed: the header alone');

  db.addTask({ repo_id: other.id, title: 'Elsewhere', prompt: 'p' });
  assert.equal((await liveContext(db, { repo, after: start.cursor, full: false })).lines.length, 1, "another repo's change isn't shown");

  const claimed = db.claimNextTask();
  assert.equal(claimed?.id, a.id);
  const moved = await liveContext(db, { repo, after: start.cursor, full: false });
  assert.ok(moved.lines.includes(`  #${a.id} First: started`));
  assert.ok(moved.lines.some((l) => l.includes(`running #${a.id} First`)));
  assert.ok(moved.cursor > start.cursor);
});

test("liveContext: a cursor above the newest event is no cursor; only this repo's open tasks show", async () => {
  const { db, repo } = setup('stale');
  const open = db.addTask({ repo_id: repo.id, title: 'Open one', prompt: 'p' });
  const gone = db.addTask({ repo_id: repo.id, title: 'Cancelled one', prompt: 'p' });
  db.applyEvent(gone.id, { type: 'cancel' });
  const ctx = await liveContext(db, { repo, after: db.lastEventId() + 100, full: false });
  assert.ok(ctx.lines.includes('Open:'), 'the full picture');
  assert.ok(ctx.lines.some((l) => l.includes(`#${open.id} Open one`)));
  assert.ok(!ctx.lines.some((l) => l.includes('Cancelled one')));
  assert.equal(ctx.cursor, db.lastEventId());
});

test('repoForPath finds the repo from its checkout, a subdirectory or a task worktree, and nothing elsewhere', () => {
  const { db, repo, repoDir } = setup('paths');
  assert.equal(repoForPath(db, repoDir)?.id, repo.id);
  assert.equal(repoForPath(db, join(repoDir, 'sub'))?.id, repo.id);
  const worktree = join(WORKTREE_DIR, 'paths', 'task-1');
  mkdirSync(worktree, { recursive: true });
  assert.equal(repoForPath(db, worktree)?.id, repo.id);
  assert.equal(repoForPath(db, tmpdir()), undefined);
  assert.equal(repoForPath(db, `${repoDir}-sibling`), undefined);
});

test('the hook prints the picture once per session, then only changes, and nothing for a worker', () => {
  const db = openDb(join(home, 'agentdeck.db'));
  const repoDir = mkdtempSync(join(tmpdir(), 'agentdeck-context-hook-'));
  const repo = db.addRepo({ name: 'hooked', path: repoDir, base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 'Hooked task', prompt: 'p' });
  const run = (input: object, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, 'context', '--hook'], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, AGENTDECK_HOME: home, AGENTDECK_TASK_ID: '', AGENTDECK_PLANNER: '', ...env },
    });
  const message = { session_id: 's1', cwd: repoDir, hook_event_name: 'UserPromptSubmit' };

  const first = run(message);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`queued #${task.id} Hooked task`));

  const second = run(message);
  assert.equal(second.stdout.trim().split('\n').length, 1, 'nothing changed: the header alone');

  db.claimNextTask();
  const third = run(message);
  assert.match(third.stdout, new RegExp(`#${task.id} Hooked task: started`));

  const start = run({ ...message, hook_event_name: 'SessionStart' });
  assert.match(start.stdout, /Open:/);
  assert.doesNotMatch(start.stdout, /Since your last message/);

  const worker = run(message, { AGENTDECK_TASK_ID: String(task.id) });
  assert.equal(worker.status, 0);
  assert.equal(worker.stdout, '');

  const elsewhere = run({ ...message, cwd: tmpdir() });
  assert.equal(elsewhere.status, 0);
  assert.equal(elsewhere.stdout, '');

  // A cursor file that can't be pruned (a dangling link) neither hides the digest nor stops the cursor moving.
  symlinkSync(join(home, 'nowhere'), join(home, 'hooks', 'dangling.json'));
  db.addTask({ repo_id: repo.id, title: 'Later task', prompt: 'p' });
  const pruned = run(message);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.doesNotMatch(pruned.stderr, /ENOENT/);
  assert.match(pruned.stdout, /Later task: added/);
  assert.equal((JSON.parse(readFileSync(join(home, 'hooks', 's1.json'), 'utf8')) as { after: number }).after, db.lastEventId());

  const garbage = spawnSync(process.execPath, [CLI, 'context', '--hook'], {
    input: 'not json',
    encoding: 'utf8',
    cwd: tmpdir(),
    env: { ...process.env, AGENTDECK_HOME: home },
  });
  assert.equal(garbage.status, 0);
  db.close();
});
