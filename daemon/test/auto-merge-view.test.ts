// Seeing whether a task will auto-merge (docs/plans/auto-merge-view.html): the check kept on the task, the view the
// domain words from it, and the CLI lines.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { asTaskId } from '../src/domain/shared/id.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-amview-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('./open-db.ts');
const { doneTask } = await import('./fixtures.ts');
const { github } = await import('../src/adapters/github.ts');
const { AUTO_MERGE_LABEL, autoMergeView } = await import('../src/domain/landing/auto-merge.ts');
const { prFields, pullRequestOf } = await import('../src/domain/landing/pr.ts');
const { refreshPrStates } = await import('../src/application/landing/refresh.ts');
const { autoMerge } = await import('../src/application/landing/auto-merge.ts');
const { setAutoMerge, taskDetail, updateRepo } = await import('../src/application/actions.ts');
const { measureBranch } = await import('../src/application/work/files.ts');
const { digest } = await import('../src/domain/work/read/digest.ts');
const { fmtAutoMerge, fmtTask } = await import('../src/cli/format.ts');
type PrDetails = import('../src/domain/landing/merge.ts').PrDetails;
type Task = import('../src/domain/work/task.ts').Task;

const db = openDb(join(home, 'test.db'));
after(() => db.close());

const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'test@example.com');
sh('config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'true' });

const ready: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 2,
  files: 2,
  additions: 30,
  deletions: 5,
  checks: { total: 2, failing: 0, pending: 0 },
  paths: ['src/a.ts', 'src/b.ts'],
  labels: [AUTO_MERGE_LABEL.name],
};

let details: Record<string, PrDetails>;
github.prDetails = async (url) => details[url] ?? ready;
github.markReady = async () => {};
github.merge = async () => {};
github.deleteRemoteBranch = async () => {};
github.ensureLabel = async () => {};
github.setLabel = async () => {};

beforeEach(() => {
  details = {};
  db.setPaused(false);
  updateRepo(db, 'demo', { auto_merge: true, auto_approve: false });
  for (const t of db.openPrTasks()) db.recordPr(t.id, { type: 'closed' });
});

let n = 0;
function tested() {
  const url = `https://x/pull/${++n}`;
  const t = doneTask(db, repo, { pr: 'open', url, branch: `agentdeck/view-${n}` });
  db.finishRun(db.startRun(t.id, 1, join(home, `run-${t.id}.log`)), { tests_passed: true });
  return { id: t.id, url };
}

// ---- Keeping the check

test('a refresh stores the check it ran, never or merge alike; merging, closing and turning auto-merge off clear it', async () => {
  const big = tested();
  details[big.url] = { ...ready, additions: 900 };
  const fine = tested();
  const closed = tested();

  await refreshPrStates(db);
  const stored = db.getTask(big.id)!;
  assert.deepEqual(stored.pr!.auto_merge_check, { verdict: 'never', reasons: ['905 lines changed, over the limit of 400'] });
  assert.ok(stored.pr!.auto_merge_checked_at);
  assert.equal(db.getTask(fine.id)!.pr!.auto_merge_check?.verdict, 'merge');

  // A later refresh replaces it.
  details[big.url] = { ...ready, additions: 10 };
  await refreshPrStates(db);
  assert.equal(db.getTask(big.id)!.pr!.auto_merge_check?.verdict, 'merge');

  // Merging clears it.
  assert.equal(await autoMerge(db, [{ id: fine.id, pr: ready }]), fine.id);
  assert.equal(db.getTask(fine.id)!.pr!.state, 'merged');
  assert.deepEqual([db.getTask(fine.id)!.pr!.auto_merge_check, db.getTask(fine.id)!.pr!.auto_merge_checked_at], [null, null]);

  // So does closing the PR.
  db.recordPr(closed.id, { type: 'closed' });
  assert.equal(db.getTask(closed.id)!.pr!.auto_merge_check, null);

  // A check is not written for a PR that was merged meanwhile.
  assert.equal(db.setAutoMergeCheck(fine.id, { verdict: 'merge', reasons: [] }), false);
  assert.equal(db.getTask(fine.id)!.pr!.auto_merge_check, null);

  // Turning auto-merge off for the task clears it.
  assert.ok(db.getTask(big.id)!.pr!.auto_merge_check);
  await setAutoMerge(db, big.id, { auto_merge: false });
  assert.deepEqual([db.getTask(big.id)!.pr!.auto_merge_check, db.getTask(big.id)!.pr!.auto_merge_checked_at], [null, null]);
});

test('a refresh stores no check for a task with auto-merge off', async () => {
  const t = tested();
  await setAutoMerge(db, t.id, { auto_merge: false });
  await refreshPrStates(db);
  assert.equal(db.getTask(t.id)!.pr!.auto_merge_check, null);
});

// ---- The view

const repoRow = { auto_merge: true, auto_approve: false, test_cmd: 'pnpm test', auto_merge_max_lines: 1000, auto_merge_skip: ['.github/'] };
const taskRow = (o: Partial<Task> = {}): Pick<Task, 'auto_merge' | 'source' | 'pr'> => ({
  auto_merge: null,
  source: 'manual',
  pr: null,
  ...o,
});
type PrFields = import('../src/domain/landing/pr.ts').PrFields;
const checked = (verdict: 'merge' | 'wait' | 'never', reasons: string[], o: Partial<PrFields> = {}) =>
  taskRow({
    pr: pullRequestOf({
      ...prFields(null),
      pr_url: 'https://x/pull/1',
      pr_state: 'open',
      auto_merge_check: { verdict, reasons },
      auto_merge_checked_at: '2026-11-01 09:00:00',
      ...o,
    }),
  });

test('autoMergeView: each state with its label and reasons', () => {
  assert.deepEqual(autoMergeView(taskRow(), { ...repoRow, auto_merge: false }), {
    state: 'off',
    label: 'auto-merge off',
    reasons: [],
    source: 'repo',
    checked_at: null,
    limits: { max_lines: 1000, skip: ['.github/'], tests: 'the last run must pass the tests' },
  });
  const on = autoMergeView(taskRow(), repoRow);
  assert.deepEqual([on.state, on.label, on.reasons, on.checked_at], ['on', 'auto-merge on', [], null]);

  const merge = autoMergeView(checked('merge', []), repoRow);
  assert.deepEqual([merge.state, merge.label, merge.checked_at], ['merge', 'will auto-merge', '2026-11-01 09:00:00']);
  const wait = autoMergeView(checked('wait', ['2 checks still running on GitHub']), repoRow);
  assert.deepEqual([wait.state, wait.label], ['wait', 'auto-merge waiting: 2 checks still running on GitHub']);
  const never = autoMergeView(checked('never', ['1200 lines changed, over the limit of 1000', 'the tests have not run']), repoRow);
  assert.deepEqual(
    [never.state, never.label, never.reasons.length],
    ['never', 'needs a person to merge: 1200 lines changed, over the limit of 1000', 2],
  );
});

test('autoMergeView: a stored check counts only while the PR is open, and an unreadable one counts for nothing', () => {
  for (const pr_state of ['merged', 'closed', null] as const)
    assert.equal(autoMergeView(checked('never', ['x'], { pr_state }), repoRow).state, 'on');
  assert.equal(autoMergeView(checked('never', ['x'], { auto_merge_check: null }), repoRow).state, 'on');
});

test('autoMergeView: where on or off comes from, and what the limits say about the tests', () => {
  assert.equal(autoMergeView(taskRow({ auto_merge: true }), { ...repoRow, auto_merge: false }).source, 'task');
  assert.equal(autoMergeView(taskRow({ auto_merge: false }), repoRow).state, 'off');
  assert.equal(autoMergeView(taskRow({ auto_merge: false }), repoRow).source, 'task');
  assert.equal(autoMergeView(taskRow(), repoRow).source, 'repo');
  assert.equal(autoMergeView(taskRow({ source: 'planner' }), repoRow).source, 'repo', 'a person approved it');

  const planner = autoMergeView(taskRow({ source: 'planner' }), { ...repoRow, auto_approve: true });
  assert.deepEqual([planner.state, planner.source], ['off', 'planner']);
  assert.equal(autoMergeView(taskRow({ source: 'planner' }), { ...repoRow, auto_approve: true, auto_merge: false }).source, 'repo');
  assert.equal(
    autoMergeView(taskRow({ source: 'planner', auto_merge: true }), { ...repoRow, auto_approve: true }).state,
    'on',
    'its own setting wins',
  );

  assert.match(autoMergeView(taskRow(), { ...repoRow, test_cmd: null }).limits.tests, /no test command/);
  assert.deepEqual(autoMergeView(taskRow(), { ...repoRow, auto_merge_skip: ['db/', 'a.ts'] }).limits.skip, ['db/', 'a.ts']);
});

test('autoMergeView: a measured branch adds how it stands against the limits', () => {
  const over = autoMergeView(taskRow(), repoRow, { lines: 1240, paths: ['src/a.ts', '.github/workflows/x.yml'] });
  assert.equal(over.state, 'on');
  assert.deepEqual(over.reasons, ['now 1,240 lines, over the limit of 1,000', 'touches .github/workflows/x.yml']);

  assert.deepEqual(autoMergeView(taskRow(), repoRow, { lines: 1000, paths: ['src/a.ts'] }).reasons, [], 'at the limit is fine');
  const many = autoMergeView(taskRow(), repoRow, { lines: 5, paths: ['.github/a', '.github/b', '.github/c', '.github/d', '.github/e'] });
  assert.deepEqual(many.reasons, ['touches .github/a, .github/b, .github/c and 2 more']);
  const skill = autoMergeView(taskRow(), { ...repoRow, auto_merge_skip: [] }, { lines: 5, paths: ['.claude/skills/x/SKILL.md'] });
  assert.deepEqual(skill.reasons, ['changes .claude/skills/x/SKILL.md: files under .claude/ steer every later agent']);
  assert.deepEqual(
    autoMergeView(taskRow(), { ...repoRow, auto_merge: false }, { lines: 5000, paths: [] }).reasons,
    [],
    'off: nothing to measure',
  );
  // Once a PR is open its stored check is what counts.
  assert.deepEqual(autoMergeView(checked('merge', []), repoRow, { lines: 5000, paths: [] }).reasons, []);
});

test('measureBranch counts the lines and paths a branch changed against the base; taskDetail shows them for a task with no PR', async () => {
  sh('checkout', '-q', '-b', 'agentdeck/measured');
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, '.github/ci.yml'), 'a\nb\nc\n');
  writeFileSync(join(dir, 'a.ts'), 'x\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'work');
  sh('checkout', '-q', 'main');

  assert.deepEqual(await measureBranch(db, repo, 'agentdeck/measured'), { lines: 4, paths: ['.github/ci.yml', 'a.ts'] });
  assert.equal(await measureBranch(db, repo, 'agentdeck/nope'), null);

  const t = doneTask(db, repo, { branch: 'agentdeck/measured' });
  const view = (await taskDetail(db, t.id)).auto_merge_view!;
  assert.deepEqual([view.state, view.reasons], ['on', ['touches .github/ci.yml']]);
});

// ---- The CLI

test('ls and show say a task with a PR over the limit needs a person to merge', async () => {
  const t = tested();
  details[t.url] = { ...ready, additions: 900 };
  await refreshPrStates(db);
  const task = await taskDetail(db, t.id);

  const line = fmtTask(task, 'demo');
  assert.match(line, /PR open: https:\/\/x\/pull\/\d+ {2}needs a person to merge: 905 lines changed, over the limit of 400/);
  const shown = fmtAutoMerge(task.auto_merge_view!);
  assert.equal(shown[0], "auto-merge needs a person to merge: 905 lines changed, over the limit of 400 (the repo's setting)");
  assert.equal(shown[1], '           - 905 lines changed, over the limit of 400');
  assert.match(shown[2], /checked \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
  assert.match(shown[3], /limits: 400 lines, not touching \.github\/; the last run must pass the tests/);

  await setAutoMerge(db, t.id, { auto_merge: false });
  const off = await taskDetail(db, t.id);
  assert.doesNotMatch(fmtTask(off, 'demo'), /auto-merge|merge:/);
  assert.deepEqual(fmtAutoMerge(off.auto_merge_view!), ["auto-merge auto-merge off (this task's setting)"]);
});

test('context marks an open task with its auto-merge label unless it is off', () => {
  const header = {
    repo: 'demo',
    paused: false,
    repo_paused: null,
    running: 0,
    max_concurrent: 2,
    governor: { allow: true, reason: null },
    head: null,
  };
  const task = (id: number, auto_merge_view: { state: string; label: string } | null) => ({
    id: asTaskId(id),
    title: `t${id}`,
    status: 'done' as const,
    pr_state: 'open' as const,
    stop_reason: null,
    waiting: null,
    auto_merge_view,
  });
  const lines = digest({
    header,
    events: [],
    full: true,
    open: [
      task(1, { state: 'never', label: 'needs a person to merge: 900 lines changed, over the limit of 400' }),
      task(2, { state: 'off', label: 'auto-merge off' }),
      task(3, null),
    ],
  });
  assert.ok(lines.includes('  in review #1 t1 [needs a person to merge: 900 lines changed, over the limit of 400]'));
  assert.ok(lines.includes('  in review #2 t2'));
  assert.ok(lines.includes('  in review #3 t3'));
});
