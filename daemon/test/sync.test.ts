// Keeping task branches up to date: a real temporary git repo with a conflicting change on main, a fake claude for the
// resolve run, and a fake github adapter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { type TaskId, asTaskId } from '../src/domain/shared/id.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-conflicts-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { github } = await import('../src/adapters/github.ts');
const { startApi } = await import('../src/api/server.ts');
const { refreshPrStates } = await import('../src/application/landing/refresh.ts');
const { doneTask: doneTaskWithPr } = await import('./fixtures.ts');
const { resolveConflicting } = await import('../src/application/landing/sync.ts');
const { ActionError, mergeTask, syncNow, retryTask, updateRepo } = await import('../src/application/actions.ts');
const { isConflicting, isMergeabilityUnknown } = await import('../src/domain/landing/conflict.ts');
const { conflictReason, syncSummary } = await import('../src/domain/landing/sync.ts');
const { buildPrBody } = await import('../src/domain/landing/pr.ts');
const { buildPrompt, buildResolvePrompt } = await import('../src/domain/runs/prompt.ts');
type PrDetails = import('../src/domain/landing/merge.ts').PrDetails;

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
const api = await startApi({ db, port: 0 });
after(() => {
  api.close();
  db.close();
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
const lines = (middle: string) => `line one\n${middle}\nline three\n`;
writeFileSync(join(dir, 'shared.txt'), lines('line two'));
writeFileSync(join(dir, 'README.md'), 'demo\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
const TEST_CMD = 'test -f fake-output.txt';
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: TEST_CMD });

const cleanDetails: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 1,
  deletions: 0,
  checks: { total: 0, failing: 0, pending: 0 },
  paths: ['README.md'],
  labels: [],
};
let pushes: string[];
let pushError: string | null;
let details: Record<string, PrDetails>;
let prCount = 0;
github.push = async (_repoPath, branch) => {
  if (pushError) throw new Error(pushError);
  pushes.push(branch);
};
github.createPr = async () => `https://github.com/acme/demo/pull/${++prCount}`;
github.prDetails = async (url) => details[url] ?? cleanDetails;
github.merge = async () => {};

beforeEach(() => {
  pushes = [];
  pushError = null;
  details = {};
  updateRepo(db, 'demo', { pr_mode: 'ready', auto_resolve: true, test_cmd: TEST_CMD });
});

let n = 0;
/** A done task with an open PR whose branch changes shared.txt, the way an agent's work would. */
async function doneTask(extra = ''): Promise<{ id: TaskId; wt: string; branch: string }> {
  n++;
  const task = db.addTask({ repo_id: repo.id, title: `Task ${n}`, prompt: `FAKE_DONE ${extra}`.trim() });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  assert.equal(t.pr?.state, 'open');
  const { worktree, branch } = t.checkout!;
  writeFileSync(join(worktree!, 'shared.txt'), lines(`task change ${n}`));
  sh(worktree!, 'commit', '-q', '-am', `Task ${n} changes line two`);
  pushes = [];
  return { id: t.id, wt: worktree!, branch: branch! };
}

/** A commit on main, as if another PR had been merged. */
function advanceMain(file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
}
const conflictOnMain = () => advanceMain('shared.txt', lines(`main change ${n}`), `Main changes line two (${n})`);
const syncEvents = (id: TaskId) => db.eventsForTask(id).filter((e) => e.type === 'sync');
const kinds = (id: TaskId) => db.runsForTask(id).map((r) => r.kind);
const claudeLog = () => readFileSync(join(home, 'fake-claude-calls.log'), 'utf8');
const resolveCalls = () => (claudeLog().match(/^AgentDeck conflict resolution/gm) ?? []).length;
const parents = (wt: string) => sh(wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length - 1;
const clean = (wt: string) => assert.equal(sh(wt, 'status', '--porcelain'), '');

test('a migration adds auto_resolve (on) and the run kind (work)', () => {
  assert.equal(repo.auto_resolve, true);
  const t = db.addTask({ repo_id: repo.id, title: 'kind', prompt: 'x' });
  const runId = db.startRun(t.id, 1, join(home, 'k.jsonl'));
  assert.equal(db.runsForTask(t.id)[0].kind, 'work');
  assert.equal(db.runsForTask(t.id)[0].id, runId);
  db.applyEvent(t.id, { type: 'cancel' });
});

test('the domain words: conflicting PRs, timeline lines, blocked reasons', () => {
  assert.equal(isConflicting({ mergeable: 'CONFLICTING', merge_state: 'DIRTY' }), true);
  assert.equal(isConflicting({ mergeable: 'UNKNOWN', merge_state: 'DIRTY' }), true);
  assert.equal(isConflicting({ mergeable: 'MERGEABLE', merge_state: 'BEHIND' }), false);
  assert.equal(isMergeabilityUnknown({ mergeable: 'UNKNOWN', merge_state: 'UNKNOWN' }), true);
  assert.equal(isMergeabilityUnknown({ mergeable: 'UNKNOWN', merge_state: 'DIRTY' }), false);
  assert.equal(syncSummary('main', 'clean', []), 'Synced with main: clean');
  assert.equal(syncSummary('main', 'resolved', ['a']), 'Resolved conflicts in 1 file');
  assert.equal(syncSummary('main', 'resolved', ['a', 'b']), 'Resolved conflicts in 2 files');
  assert.equal(conflictReason('main', ['a.ts', 'b.ts'], 'tests failed'), 'conflicts with main in 2 files: a.ts, b.ts (tests failed)');
  assert.equal(conflictReason('main', ['1', '2', '3', '4', '5', '6', '7']), 'conflicts with main in 7 files: 1, 2, 3, 4, 5 and 2 more');
  assert.equal(conflictReason('main', [], 'tests failed'), 'could not sync with main (tests failed)');
});

test('the resolve prompt names the files, both sides and the goal; resolve runs do not count as attempts in prompts or PR bodies', () => {
  const task = { id: asTaskId(7), title: 'Add a flag', prompt: 'Add the --force flag to the CLI.' };
  const p = buildResolvePrompt(task, {
    base: 'main',
    files: ['src/cli.ts', 'README.md'],
    ours: ['Add --force'],
    theirs: ['Rename --yes', 'Refactor parser'],
    testCmd: 'npm test',
  });
  for (const part of [
    'src/cli.ts',
    'README.md',
    'Add --force',
    'Rename --yes',
    'Refactor parser',
    'Add the --force flag',
    '`npm test`',
    'both sides',
    '`main`',
  ])
    assert.ok(p.includes(part), part);
  assert.ok(p.startsWith('AgentDeck conflict resolution'));

  const work = {
    kind: 'work',
    attempt: 1,
    outcome: 'done',
    num_turns: 3,
    cost_usd: 0.01,
    tests_passed: true,
    result_text: 'Did the work.\nSTATUS: DONE',
  };
  const resolve = {
    kind: 'resolve',
    attempt: 1,
    outcome: 'done',
    num_turns: 2,
    cost_usd: 0.01,
    tests_passed: null,
    result_text: 'Resolved 1 file(s).',
  };
  const body = buildPrBody({ id: 7 }, [work, resolve]);
  assert.ok(body.startsWith('Did the work.'));
  assert.match(body, /\| 1 \(conflicts\) \| done \|/);
  const task2 = { ...db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' }), attempts: 2 };
  assert.ok(buildPrompt(task2, [{ ...work, outcome: 'failed' } as never, { ...resolve } as never]).includes('ended as "failed"'));
  db.applyEvent(task2.id, { type: 'cancel' });
});

test('a clean merge is committed, tested and pushed without a claude run', async () => {
  const t = await doneTask();
  advanceMain('other.txt', 'unrelated\n', 'Add other.txt');
  const before = resolveCalls();

  const r = await syncNow(db, t.id);
  assert.equal(r.outcome, 'clean');
  assert.equal(r.pushed, true);
  assert.deepEqual(pushes, [t.branch]);
  assert.equal(readFileSync(join(t.wt, 'other.txt'), 'utf8'), 'unrelated\n');
  assert.equal(resolveCalls(), before);
  assert.deepEqual(kinds(t.id), ['work'], 'no run for a clean merge');
  assert.equal(db.getTask(t.id)!.status, 'done');
  assert.equal(syncEvents(t.id).length, 1);
  assert.equal(syncEvents(t.id)[0].reason, 'Synced with main: clean');
  assert.equal(parents(t.wt), 2, 'a merge commit, not a rebase');
  clean(t.wt);

  const again = await syncNow(db, t.id);
  assert.equal(again.outcome, 'up_to_date');
  assert.equal(syncEvents(t.id).length, 1, 'nothing to record when nothing came in');
  assert.deepEqual(pushes, [t.branch], 'and nothing to push');
});

test('a sync with no base ref ends as an error, not up to date', async () => {
  const t = await doneTask();
  const { syncBranch } = await import('../src/application/landing/sync.ts');
  const task = db.getTask(t.id)!;
  const res = await syncBranch(db, task, { ...repo, base_branch: 'no-such-branch' }, t.wt, { allowResolve: false, runTests: false });
  assert.equal(res.kind, 'error');
  assert.match(res.kind === 'error' ? res.reason : '', /no-such-branch/);
});

test('a conflict starts a resolve run that keeps both sides; the task stays done and no attempt is used', async () => {
  const t = await doneTask();
  conflictOnMain();
  const attempts = db.getTask(t.id)!.attempts;
  const before = resolveCalls();

  const r = await syncNow(db, t.id);
  assert.equal(r.outcome, 'resolved');
  assert.deepEqual(r.files, ['shared.txt']);
  assert.equal(r.pushed, true);
  assert.deepEqual(pushes, [t.branch]);
  assert.equal(resolveCalls(), before + 1);

  const text = readFileSync(join(t.wt, 'shared.txt'), 'utf8');
  assert.ok(text.includes(`task change ${n}`) && text.includes(`main change ${n}`), text);
  assert.ok(!/^(<{7}|>{7})/m.test(text));
  assert.equal(parents(t.wt), 2);
  clean(t.wt);

  const task = db.getTask(t.id)!;
  assert.equal(task.status, 'done');
  assert.equal(task.attempts, attempts, 'a resolve run does not use an attempt');
  const runs = db.runsForTask(t.id);
  assert.deepEqual(kinds(t.id), ['work', 'resolve']);
  assert.equal(runs[1].outcome, 'done');
  assert.equal(runs[1].attempt, attempts);
  assert.equal(runs[1].tests_passed, true, 'the daemon ran the repo tests on the result');
  assert.ok(runs[1].ended_at && runs[1].log_path !== runs[0].log_path);
  assert.equal(syncEvents(t.id)[0].reason, 'Resolved conflicts in 1 file');

  // The prompt named the file, the goal and both sides' commit messages.
  const prompt = claudeLog().split('AgentDeck conflict resolution').at(-1)!;
  assert.match(prompt, /- shared\.txt/);
  assert.ok(prompt.includes(`Task ${n} changes line two`) && prompt.includes(`Main changes line two (${n})`), prompt);
  assert.ok(prompt.includes('FAKE_DONE'), 'the task goal');
});

test('a resolve run that stages but does not commit still concludes the merge', async () => {
  const t = await doneTask('FAKE_RESOLVE_STAGE');
  conflictOnMain();
  assert.equal((await syncNow(db, t.id)).outcome, 'resolved');
  assert.equal(parents(t.wt), 2);
  clean(t.wt);
});

/** The branch is exactly as the task left it: same commit, no merge underway, nothing dirty. */
function untouched(t: { wt: string }, head: string): void {
  assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head);
  assert.throws(
    () => execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: t.wt, stdio: 'ignore' }),
    'no merge underway',
  );
  clean(t.wt);
  assert.equal(readFileSync(join(t.wt, 'shared.txt'), 'utf8'), lines(`task change ${n}`));
}

for (const [flag, why] of [
  ['FAKE_RESOLVE_BLOCKED', /which behaviour wins/],
  ['FAKE_RESOLVE_LEAVE', /conflict markers are still in shared\.txt/],
  ['FAKE_RESOLVE_ABORT', /the merge was not committed/],
] as const) {
  test(`${flag}: the merge is aborted and the task is blocked with the conflicting files`, async () => {
    const t = await doneTask(flag);
    conflictOnMain();
    const head = sh(t.wt, 'rev-parse', 'HEAD');
    const attempts = db.getTask(t.id)!.attempts;
    const dependent = db.addTask({ repo_id: repo.id, title: 'waits', prompt: 'x', links: [{ on: t.id, kind: 'builds_on' }] });

    const r = await syncNow(db, t.id);
    assert.equal(r.outcome, 'blocked');
    assert.deepEqual(r.files, ['shared.txt']);
    assert.match(r.reason!, /^conflicts with main in 1 file: shared\.txt/);
    assert.match(r.reason!, why);
    assert.deepEqual(pushes, [], 'nothing is pushed');
    untouched(t, head);

    const task = db.getTask(t.id)!;
    assert.equal(task.status, 'blocked');
    assert.equal(task.stop_reason, r.reason);
    assert.equal(task.attempts, attempts);
    const event = db.eventsForTask(t.id).at(-1)!;
    assert.deepEqual([event.type, event.from_status, event.to_status, event.reason], ['conflict', 'done', 'blocked', r.reason]);
    assert.equal(syncEvents(t.id).length, 0);
    assert.equal(db.runsForTask(t.id).at(-1)!.kind, 'resolve');
    assert.notEqual(db.runsForTask(t.id).at(-1)!.outcome, 'done');

    const note = db.recentNotifications(20).find((x) => x.task_id === t.id && x.kind === 'blocked')!;
    assert.match(note.body, /shared\.txt/);
    assert.ok(
      db.recentNotifications(20).some((x) => x.task_id === t.id && /can't start/.test(x.title)),
      'its dependent is warned',
    );
    db.applyEvent(dependent.id, { type: 'cancel' });
    // The person can take it from here: a retry works on the same branch.
    retryTask(db, t.id);
    assert.equal(db.getTask(t.id)!.status, 'queued');
    db.applyEvent(t.id, { type: 'cancel' });
  });
}

test('tests that fail on the merged result undo a clean merge and block the task', async () => {
  const t = await doneTask();
  advanceMain('other6.txt', 'unrelated\n', 'Add other6.txt');
  updateRepo(db, 'demo', { test_cmd: 'test ! -f other6.txt' });
  const head = sh(t.wt, 'rev-parse', 'HEAD');

  const r = await syncNow(db, t.id);
  assert.equal(r.outcome, 'blocked');
  assert.match(r.reason!, /^could not sync with main \(tests failed after merging main/);
  assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(t.wt, 'other6.txt')), false);
  assert.equal(db.getTask(t.id)!.status, 'blocked');
  assert.deepEqual(pushes, []);
});

test('an undone merge removes the untracked files the tests wrote, so the next commit does not contain them', async () => {
  const t = await doneTask();
  advanceMain('other7.txt', 'unrelated\n', 'Add other7.txt');
  updateRepo(db, 'demo', { test_cmd: 'echo output > test-output.txt && false' });
  const head = sh(t.wt, 'rev-parse', 'HEAD');

  const r = await syncNow(db, t.id);
  assert.equal(r.outcome, 'blocked');
  assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(t.wt, 'test-output.txt')), false);
  clean(t.wt);

  writeFileSync(join(t.wt, 'later.txt'), 'later\n');
  sh(t.wt, 'add', '-A');
  sh(t.wt, 'commit', '-q', '-m', 'Later change');
  assert.deepEqual(sh(t.wt, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['later.txt']);
});

test('tests that fail after a resolve run undo the merge and block the task', async () => {
  const t = await doneTask();
  conflictOnMain();
  updateRepo(db, 'demo', { test_cmd: 'false' });
  const head = sh(t.wt, 'rev-parse', 'HEAD');

  const r = await syncNow(db, t.id);
  assert.equal(r.outcome, 'blocked');
  assert.match(r.reason!, /shared\.txt.*tests failed/);
  assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head);
  clean(t.wt);
  assert.equal(readFileSync(join(t.wt, 'shared.txt'), 'utf8'), lines(`task change ${n}`));
  const run = db.runsForTask(t.id).at(-1)!;
  assert.equal(run.kind, 'resolve');
  assert.equal(run.tests_passed, false);
  assert.equal(run.outcome, 'failed');
  assert.equal(db.getTask(t.id)!.status, 'blocked');
});

test('auto_resolve off: clean merges still happen, conflicts wait for a person', async () => {
  updateRepo(db, 'demo', { auto_resolve: false });
  const t = await doneTask();
  advanceMain('other2.txt', 'unrelated\n', 'Add other2.txt');
  assert.equal((await syncAuto(t.id)).outcome, 'clean');

  conflictOnMain();
  const head = sh(t.wt, 'rev-parse', 'HEAD');
  const before = resolveCalls();
  const skipped = await syncAuto(t.id);
  assert.equal(skipped.outcome, 'skipped');
  assert.deepEqual(skipped.files, ['shared.txt']);
  assert.equal(resolveCalls(), before, 'no claude run');
  assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head);
  clean(t.wt);
  assert.equal(db.getTask(t.id)!.status, 'done', 'not blocked: the person decides');

  // By hand it still works.
  assert.equal((await syncNow(db, t.id)).outcome, 'resolved');
  assert.equal(resolveCalls(), before + 1);
  assert.equal(db.getTask(t.id)!.status, 'done');
});

/** What the scheduler's automatic path does for a task. */
const syncAuto = async (id: TaskId) => {
  const { syncTask } = await import('../src/application/landing/sync.ts');
  return syncTask(db, id, { manual: false });
};

test('a push that fails is reported and retried next time; the task stays done', async () => {
  const t = await doneTask();
  advanceMain('other3.txt', 'unrelated\n', 'Add other3.txt');
  pushError = 'remote: Permission denied (publickey)';
  const r = await syncNow(db, t.id);
  assert.equal(r.outcome, 'clean');
  assert.equal(r.pushed, false);
  assert.match(r.push_error!, /Permission denied/);
  assert.equal(db.getTask(t.id)!.status, 'done');
  assert.match(readFileSync(db.runsForTask(t.id).at(-1)!.log_path, 'utf8'), /"type":"agentdeck_pr","error":"remote: Permission denied/);
});

test('only a done task can be synced by hand', async () => {
  const queued = db.addTask({ repo_id: repo.id, title: 'queued', prompt: 'x' });
  await assert.rejects(syncNow(db, queued.id), /only a done task/);
  await assert.rejects(syncNow(db, asTaskId(999999)), ActionError);
  db.applyEvent(queued.id, { type: 'cancel' });
});

test('every run starts from the latest base, retries included', async () => {
  const t = await doneTask('FAKE_RESOLVE_X');
  advanceMain('other4.txt', 'unrelated\n', 'Add other4.txt');
  const resolvesBefore = resolveCalls();

  retryTask(db, t.id);
  await drain();
  const task = db.getTask(t.id)!;
  assert.equal(task.status, 'done');
  assert.equal(readFileSync(join(t.wt, 'other4.txt'), 'utf8'), 'unrelated\n', 'the agent started from a branch that had it');
  assert.equal(syncEvents(t.id)[0].reason, 'Synced with main: clean');
  assert.equal(resolveCalls(), resolvesBefore);
  const log = readFileSync(db.runsForTask(t.id).at(-1)!.log_path, 'utf8');
  assert.match(log, /"type":"agentdeck_sync","kind":"clean"/);
});

test('a conflict at the start of a retry gets a resolve run before the work run, without using an attempt', async () => {
  const t = await doneTask('FAKE_DONE');
  conflictOnMain();
  retryTask(db, t.id);
  const claimedAttempts = db.getTask(t.id)!.attempts + 1; // the claim takes one
  await drain();

  const task = db.getTask(t.id)!;
  assert.equal(task.status, 'done');
  assert.equal(task.attempts, claimedAttempts, 'the work run used one attempt, the resolve run none');
  assert.deepEqual(kinds(t.id).sort(), ['resolve', 'work', 'work']);
  assert.equal(syncEvents(t.id)[0].reason, 'Resolved conflicts in 1 file');
  assert.ok(!/^(<{7}|>{7})/m.test(readFileSync(join(t.wt, 'shared.txt'), 'utf8')));
  assert.equal(parents(t.wt) >= 1, true);
});

test('a conflict at the start of a run that cannot be resolved blocks the task before the agent starts', async () => {
  const t = await doneTask('FAKE_RESOLVE_BLOCKED');
  conflictOnMain();
  const head = sh(t.wt, 'rev-parse', 'HEAD');
  // A retry's work prompt carries the attempt line; the resolve prompt only quotes the goal.
  const workCalls = () => (claudeLog().match(/^--- This is attempt/gm) ?? []).length;
  const before = workCalls();
  retryTask(db, t.id);
  await drain();

  const task = db.getTask(t.id)!;
  assert.equal(task.status, 'blocked');
  assert.match(task.stop_reason!, /^conflicts with main in 1 file: shared\.txt/);
  assert.equal(workCalls(), before, 'the agent never started');
  assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head);
  clean(t.wt);
  assert.equal(
    db
      .runsForTask(t.id)
      .filter((r) => r.kind === 'work')
      .at(-1)!.outcome,
    'blocked',
  );
});

test('with auto_resolve off a run still starts when the base conflicts, on the branch as it was', async () => {
  updateRepo(db, 'demo', { auto_resolve: false });
  const t = await doneTask('FAKE_DONE');
  conflictOnMain();
  const before = resolveCalls();
  retryTask(db, t.id);
  await drain();
  assert.equal(db.getTask(t.id)!.status, 'done');
  assert.equal(resolveCalls(), before);
  assert.equal(syncEvents(t.id).length, 0);
  assert.match(readFileSync(db.runsForTask(t.id).at(-1)!.log_path, 'utf8'), /"type":"agentdeck_sync","kind":"needs_resolution"/);
});

test('refreshPrStates reads mergeability: conflicting PRs are returned, unknown ones counted, merged ones not looked up', async () => {
  const mk = (url: string, state = 'open') => {
    const t = doneTaskWithPr(db, repo, { title: url, pr: 'open', url });
    return { id: t.id, state };
  };
  const a = mk('https://x/pull/501');
  const b = mk('https://x/pull/502');
  const c = mk('https://x/pull/503');
  const d = mk('https://x/pull/504');
  details['https://x/pull/501'] = { ...cleanDetails, mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  details['https://x/pull/502'] = { ...cleanDetails, mergeable: 'UNKNOWN', merge_state: 'UNKNOWN' };
  details['https://x/pull/504'] = { ...cleanDetails, mergeable: 'CONFLICTING' };
  const asked: string[] = [];
  const det = github.prDetails;
  github.prDetails = async (url, cwd, opts) => (
    asked.push(url),
    { ...(await det(url, cwd, opts)), state: url.endsWith('504') ? 'merged' : 'open' }
  );
  try {
    const found = await refreshPrStates(db);
    assert.deepEqual(found, { conflicting: [a.id], unknown: 1, mergeable: [], polling: 0 });
    assert.equal(asked.filter((u) => u === 'https://x/pull/504').length, 1, 'a merged PR is read once, and its mergeability is not used');
    assert.equal(db.getTask(d.id)!.pr?.state, 'merged');
  } finally {
    github.prDetails = det;
    // Out of the way of the tests after this one: a done task is cancelled by retrying it first.
    for (const x of [a, b, c, d]) {
      db.applyEvent(x.id, { type: 'retry' });
      db.applyEvent(x.id, { type: 'cancel' });
    }
  }
});

test('resolveConflicting waits for the governor: paused, rate limited, or no free slot', async () => {
  const t = await doneTask();
  conflictOnMain();
  const msgs: string[] = [];
  const before = resolveCalls();

  db.setSetting('paused', '1');
  await resolveConflicting(db, [t.id], (m) => msgs.push(m));
  assert.equal(resolveCalls(), before, 'paused');
  assert.match(msgs.join('\n'), /waiting for the governor/);

  db.setSetting('paused', '0');
  db.setSetting('rate_limited_until', String(Math.floor(Date.now() / 1000) + 600));
  await resolveConflicting(db, [t.id]);
  assert.equal(resolveCalls(), before, 'rate limited');
  db.setSetting('rate_limited_until', '0');

  db.setSetting('max_concurrent', '0');
  await resolveConflicting(db, [t.id]);
  assert.equal(resolveCalls(), before, 'no slot');
  db.setSetting('max_concurrent', '1');

  const log: string[] = [];
  await resolveConflicting(db, [t.id], (m) => log.push(m));
  assert.equal(resolveCalls(), before + 1);
  assert.equal(syncEvents(t.id).at(-1)!.reason, 'Resolved conflicts in 1 file');
  assert.match(log.join('\n'), /resolved/);

  // A task that is no longer done, or whose repo is paused, is left alone.
  db.setRepoPaused(repo.id, 'doctor: tests');
  await resolveConflicting(db, [t.id]);
  db.setRepoPaused(repo.id, null);
  db.setSetting('paused', '1');
});

test('resolveConflicting with auto_resolve off makes no sync attempt and tells the conflict once', async () => {
  const t = await doneTask();
  conflictOnMain();
  const head = sh(t.wt, 'rev-parse', 'HEAD');
  const before = resolveCalls();
  updateRepo(db, 'demo', { auto_resolve: false });
  try {
    const told = new Set<TaskId>();
    const log: string[] = [];
    await resolveConflicting(db, [t.id], (m) => log.push(m), told);
    await resolveConflicting(db, [t.id], (m) => log.push(m), told);
    assert.equal(log.length, 1);
    assert.match(log[0], new RegExp(`task ${t.id}: .*auto_resolve is off.*agentdeck sync ${t.id}`));
    assert.equal(resolveCalls(), before, 'no claude run');
    assert.equal(sh(t.wt, 'rev-parse', 'HEAD'), head, 'the branch was not touched');
    assert.equal(sh(t.wt, 'status', '--porcelain'), '', 'no merge was tried in the worktree');

    // Once the conflict is gone from the refresh it is forgotten, so a new one is told again.
    await resolveConflicting(db, [], (m) => log.push(m), told);
    await resolveConflicting(db, [t.id], (m) => log.push(m), told);
    assert.equal(log.length, 2);
  } finally {
    updateRepo(db, 'demo', { auto_resolve: true });
  }
});

test('merging a PR makes the scheduler re-read the open PRs at once and resolve the ones that now conflict', async () => {
  const merged = await doneTask();
  const other = await doneTask();
  advanceMain('other5.txt', 'unrelated\n', 'Add other5.txt');
  conflictOnMain();
  const otherUrl = db.getTask(other.id)!.pr!.url!;
  details[otherUrl] = { ...cleanDetails, mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  db.setSetting('paused', '0');

  // The periodic refresh is far away: only the merge's request can trigger it.
  const scheduler = new Scheduler(db, { tickMs: 10, prRefreshMs: Number.MAX_SAFE_INTEGER, log: () => {} });
  const running = scheduler.run();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(syncEvents(other.id).length, 0, 'nothing happens until a merge');

  try {
    await mergeTask(db, merged.id);
    assert.ok(db.prCheckRequested() > 0);
    const deadline = Date.now() + 15_000;
    while (!syncEvents(other.id).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  } finally {
    scheduler.stop();
    await running;
    db.setSetting('paused', '1');
  }
  assert.equal(syncEvents(other.id)[0]?.reason, 'Resolved conflicts in 1 file');
  assert.equal(db.getTask(other.id)!.status, 'done');
  assert.ok(pushes.includes(other.branch));
});

test('POST /api/tasks/:id/sync syncs with the base and returns the task', async () => {
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const t = await doneTask();
  conflictOnMain();
  const res = await fetch(`${base}/api/tasks/${t.id}/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.outcome, 'resolved');
  assert.deepEqual(body.files, ['shared.txt']);
  assert.equal(body.task.status, 'done');
  assert.deepEqual(
    body.task.runs.map((r: { kind: string }) => r.kind),
    ['work', 'resolve'],
  );

  const queued = db.addTask({ repo_id: repo.id, title: 'q', prompt: 'x' });
  const bad = await fetch(`${base}/api/tasks/${queued.id}/sync`, { method: 'POST' });
  assert.equal(bad.status, 400);
  db.applyEvent(queued.id, { type: 'cancel' });
});

test('the merge preview says when the conflict is something a resolve run can fix', async () => {
  const { mergePreview } = await import('../src/application/actions.ts');
  const t = await doneTask();
  assert.equal((await mergePreview(db, t.id)).conflicting, false);
  details[db.getTask(t.id)!.pr!.url!] = { ...cleanDetails, mergeable: 'CONFLICTING' };
  const p = await mergePreview(db, t.id);
  assert.equal(p.conflicting, true);
  assert.match(p.problems[0], /conflicts/);
});
