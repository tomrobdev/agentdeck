// Auto-merge: the pure check, and the daemon merging on its PR refresh with a fake github adapter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TaskId } from '#domain/shared/id.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-automerge-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { doneTask, testApp, waitFor } = await import('#test/fixtures/fixtures.ts');
const { READY_PR, fakeCodeHost } = await import('#test/fixtures/fakes.ts');
const { mergeFailure, verdictView } = await import('#domain/landing/merge/merge.ts');
const { mergeRequestCheck } = await import('#domain/landing/merge/merge-request.ts');
const { cancelMergeRequest, requestMerge } = await import('#application/actions.ts');
const { github } = await import('#adapters/github/github.ts');
const { AUTO_MERGE_LABEL, autoMergeCheck, autoMergeOn, autoMergeView, prDoor } = await import('#domain/landing/merge/auto-merge.ts');
const { isMergeLocked } = await import('#application/work/checkout-locks.ts');
const { refreshPrStates } = await import('#application/landing/pull-request/refresh.ts');
const { autoMerge } = await import('#application/landing/merge/auto-merge.ts');
const { openPullRequest } = await import('#application/landing/pull-request/open-pr.ts');
const { ActionError, addTask, mergePreview, mergeTask, setAutoMerge, syncNow, updateRepo } = await import('#application/actions.ts');
const { resolveConflicting } = await import('#application/runs/sync.ts');
const { repoSettingPatch } = await import('#cli/operations/settings-args.ts');
const { liveLinks } = await import('#application/work/dependencies.ts');
const { startState, waitingFor } = await import('#domain/work/index.ts');
const waiting = (t: import('#domain/work/task/task.ts').Task) => {
  const links = liveLinks(db);
  return waitingFor(t, startState(t, links.linksOf(t.id), links.target));
};
type PrDetails = import('#domain/landing/merge/merge.ts').PrDetails;

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
  head: 'head-1',
  paths: ['src/a.ts', 'src/b.ts'],
  labels: [AUTO_MERGE_LABEL.name],
  body: '## Merge Danger\n\n**Door:** two-way. Revert the commit.',
};
const auto = (id: TaskId, pr: PrDetails = ready) => ({ id, pr, requested: false });

let details: Record<string, PrDetails>;
let gh: {
  labelsMade: number;
  created: string[][];
  labelled: { url: string; on: boolean }[];
  merged: string[];
  deleted: string[];
  heads: string[];
};
let mergeError: string | null;
github.push = async () => {};
github.createPr = async (pr) => (gh.created.push(pr.labels ?? []), `https://x/pull/new-${gh.created.length}`);
github.ensureLabel = async () => void gh.labelsMade++;
github.setLabel = async (url, _cwd, _label, on) => void gh.labelled.push({ url, on });
github.prDetails = async (url) => details[url] ?? ready;
github.markReady = async () => {};
github.merge = async (pr) => {
  if (mergeError) throw new Error(mergeError);
  gh.merged.push(pr.url);
  gh.heads.push(pr.head);
};
github.deleteRemoteBranch = async (_path, branch) => void gh.deleted.push(branch);

beforeEach(() => {
  details = {};
  gh = { labelsMade: 0, created: [], labelled: [], merged: [], deleted: [], heads: [] };
  mergeError = null;
  db.setPaused(false);
  updateRepo(db, 'demo', { auto_merge: true, auto_approve: false, pr_mode: 'ready' });
  for (const t of db.openPrTasks()) db.recordPr(t.id, { type: 'closed' });
});

let n = 0;
function tested(o: { source?: 'manual' | 'planner'; title?: string } = {}) {
  const url = `https://x/pull/${++n}`;
  const t = doneTask(db, repo, { pr: 'open', url, branch: `agentdeck/pr-${n}`, ...o });
  db.finishRun(db.startRun(t.id, 1, join(home, `run-${t.id}.log`)), { tests_passed: true });
  return { id: t.id, url, branch: t.checkout?.branch };
}

const repoRow = { test_cmd: 'pnpm test', auto_merge_max_lines: 400, auto_merge_skip: ['.github/'] };
type ReviewFacts = import('#domain/landing/review/review-gate.ts').ReviewFacts;
type CheckOptions = { tests_passed?: boolean | null; paused?: string | null; test_cmd?: string | null; review?: ReviewFacts | null };
const raw = (pr: Partial<PrDetails> = {}, o: CheckOptions = {}) =>
  autoMergeCheck({
    repo: { ...repoRow, test_cmd: o.test_cmd === undefined ? repoRow.test_cmd : o.test_cmd },
    pr_state: 'open',
    pr: { ...ready, ...pr },
    tests_passed: o.tests_passed === undefined ? true : o.tests_passed,
    paused: o.paused ?? null,
    review: o.review ?? null,
  });
const check = (pr: Partial<PrDetails> = {}, o: CheckOptions = {}) => verdictView(raw(pr, o));

test('autoMergeOn: the task wins, else the repo; a planner proposal only when a person approved it', () => {
  const on = { auto_merge: true, auto_approve: false };
  assert.equal(autoMergeOn({ auto_merge: null, source: 'manual' }, on), true);
  assert.equal(autoMergeOn({ auto_merge: null, source: 'manual' }, { ...on, auto_merge: false }), false);
  assert.equal(autoMergeOn({ auto_merge: false, source: 'manual' }, on), false);
  assert.equal(autoMergeOn({ auto_merge: true, source: 'manual' }, { ...on, auto_merge: false }), true);
  assert.equal(autoMergeOn({ auto_merge: null, source: 'planner' }, on), true, 'auto_approve off: a person queued it');
  assert.equal(autoMergeOn({ auto_merge: null, source: 'planner' }, { ...on, auto_approve: true }), false);
  assert.equal(autoMergeOn({ auto_merge: true, source: 'planner' }, { ...on, auto_approve: true }), true);
});

test('autoMergeCheck: a clean, tested, labelled PR merges; a draft too', () => {
  assert.deepEqual(check(), { verdict: 'merge', reasons: [] });
  assert.deepEqual(check({ draft: true, merge_state: 'DRAFT' }), { verdict: 'merge', reasons: [] });
  assert.equal(check({ checks: { total: 0, failing: 0, pending: 0 } }).verdict, 'merge', 'the tests are enough without CI');
  assert.equal(check({}, { test_cmd: null, tests_passed: null }).verdict, 'merge', 'CI is enough without tests');
});

test('autoMergeCheck: what needs a person', () => {
  const reasons = (pr: Partial<PrDetails>, o = {}) => check(pr, o);
  assert.deepEqual(reasons({ labels: [] }), { verdict: 'never', reasons: [`the PR has no ${AUTO_MERGE_LABEL.name} label`] });
  assert.deepEqual(reasons({ checks: { total: 2, failing: 1, pending: 0 } }).reasons, ['1 check failing on GitHub']);
  assert.deepEqual(reasons({}, { tests_passed: false }).reasons, ['tests failed on the last run']);
  assert.deepEqual(reasons({}, { tests_passed: null }).reasons, ['the tests have not run']);
  assert.deepEqual(reasons({ checks: { total: 0, failing: 0, pending: 0 } }, { test_cmd: null, tests_passed: null }).reasons, [
    'nothing tested it: the repo has no test command and no check ran on the PR',
  ]);
  assert.deepEqual(reasons({ additions: 390, deletions: 20 }).reasons, ['410 lines changed, over the limit of 400']);
  assert.deepEqual(reasons({ paths: ['src/a.ts', '.github/workflows/ci.yml'] }).reasons, ['touches .github/workflows/ci.yml']);
  assert.deepEqual(reasons({ files: 120, paths: ['a.ts'] }).reasons, ['GitHub listed 1 of 120 changed files']);
  assert.deepEqual(reasons({ merge_state: 'BLOCKED' }).reasons, [
    'GitHub says branch protection may block this merge (required reviews or checks)',
  ]);
  assert.equal(check({ labels: [] }, { paused: 'AgentDeck is paused' }).verdict, 'never', 'a person beats a wait');
});

test("prDoor: reads the Door line of the PR's Merge Danger, in the shapes markdown gives it", () => {
  for (const body of ['Door: one-way', '**Door:** One-way. Drops a column.', '- door: one way', '> Door: `one-way`'])
    assert.equal(prDoor(body), 'one-way', body);
  for (const body of ['Door: two-way', '## Merge Danger\n\n**Door:** two-way\n\nRevert it.', '* Door: Two way'])
    assert.equal(prDoor(body), 'two-way', body);
  for (const body of [null, undefined, '', 'No danger here', 'Door: maybe', 'Door:', 'Front door: two-way'])
    assert.equal(prDoor(body), null, String(body));
  assert.equal(prDoor('Door: two-way\nDoor: one-way'), 'one-way', 'one one-way line is enough');
  assert.equal(prDoor('Door: two-way\nDoor: unsure'), null, 'an unreadable line makes the whole unreadable');
});

test('autoMergeCheck: a one-way door, or no readable Door line, needs a person and says why; a two-way door merges', () => {
  assert.deepEqual(raw({ body: '## Merge Danger\n\nDoor: one-way. Deletes old runs.' }), {
    verdict: 'never',
    reasons: [{ kind: 'one_way_door', text: 'the PR marks its change a one-way door, hard to walk back, so a person merges it' }],
  });
  for (const body of [null, 'A PR with no Merge Danger', 'Door: depends'])
    assert.deepEqual(raw({ body }), {
      verdict: 'never',
      reasons: [{ kind: 'no_door', text: 'the PR description has no readable Door line (one-way or two-way), so a person merges it' }],
    });
  assert.deepEqual(check({ body: 'Door: two-way' }), { verdict: 'merge', reasons: [] });
  assert.deepEqual(check({ body: 'Door: two-way', additions: 390, deletions: 20 }).reasons, ['410 lines changed, over the limit of 400']);
});

test('the refresh never merges a one-way door PR, and the preview names why', async () => {
  const oneWay = tested();
  details[oneWay.url] = { ...ready, body: 'Door: one-way' };
  const twoWay = tested();
  const found = await refreshPrStates(db);
  assert.deepEqual(
    found.mergeable.map((m) => m.id),
    [twoWay.id],
  );
  assert.deepEqual((await mergePreview(db, oneWay.id)).auto_merge, {
    verdict: 'never',
    reasons: ['the PR marks its change a one-way door, hard to walk back, so a person merges it'],
  });
  assert.equal(db.getTask(oneWay.id)!.pr?.auto_merge_check?.reasons[0].kind, 'one_way_door');
  for (const t of [oneWay, twoWay]) db.recordPr(t.id, { type: 'closed' });
});

test('autoMergeCheck: with no test command, only a check that ran tested it; skipped and neutral ones did not', () => {
  const one = (state: 'pass' | 'fail' | 'pending' | 'skipped') => ({ name: state, state, url: null, started_at: null, completed_at: null });
  const untested = { test_cmd: null, tests_passed: null };
  const nothing = 'nothing tested it: the repo has no test command and no check ran on the PR';
  const skipped = { checks: { total: 2, failing: 0, pending: 0 }, check_list: [one('skipped'), one('skipped')] };
  assert.deepEqual(check(skipped, untested), { verdict: 'never', reasons: [nothing] });
  assert.equal(check({ ...skipped, check_list: [one('skipped'), one('pass')] }, untested).verdict, 'merge');
  const running = { checks: { total: 2, failing: 0, pending: 1 }, check_list: [one('skipped'), one('pending')] };
  assert.deepEqual(check(running, untested), { verdict: 'wait', reasons: ['1 check still running on GitHub'] });
  const failing = { checks: { total: 1, failing: 1, pending: 0 }, check_list: [one('fail')] };
  assert.deepEqual(check(failing, untested).reasons, ['1 check failing on GitHub']);
});

test('the refresh leaves a PR with only skipped checks in a repo with no test command for a person', async () => {
  updateRepo(db, 'demo', { test_cmd: null });
  try {
    const t = doneTask(db, repo, { pr: 'open', url: `https://x/pull/${++n}` });
    const skipped = { name: 'deploy', state: 'skipped' as const, url: null, started_at: null, completed_at: null };
    details[db.getTask(t.id)!.pr!.url!] = { ...ready, checks: { total: 1, failing: 0, pending: 0 }, check_list: [skipped] };
    assert.deepEqual((await refreshPrStates(db)).mergeable, []);
    assert.equal(db.getTask(t.id)!.pr?.auto_merge_check?.verdict, 'never');
  } finally {
    updateRepo(db, 'demo', { test_cmd: 'true' });
  }
});

test('autoMergeCheck: a PR touching .claude/ needs a person, even with an empty skip list', () => {
  const paths = ['src/a.ts', '.claude/skills/x/SKILL.md'];
  const why = 'changes .claude/skills/x/SKILL.md: files under .claude/ steer every later agent';
  for (const auto_merge_skip of [[], ['.github/'], ['.claude/']]) {
    const verdict = verdictView(
      autoMergeCheck({
        repo: { ...repoRow, auto_merge_skip },
        pr_state: 'open',
        pr: { ...ready, paths },
        tests_passed: true,
        paused: null,
      }),
    );
    assert.deepEqual(verdict, { verdict: 'never', reasons: [why] }, auto_merge_skip.join());
  }
  assert.deepEqual(check({ paths: [...paths, '.github/ci.yml'] }).reasons, [why, 'touches .github/ci.yml']);
});

test('autoMergeCheck: what can still change on its own', () => {
  assert.deepEqual(check({ checks: { total: 2, failing: 0, pending: 1 }, merge_state: 'BLOCKED' }), {
    verdict: 'wait',
    reasons: ['1 check still running on GitHub'],
  });
  assert.deepEqual(check({ mergeable: 'UNKNOWN', merge_state: 'UNKNOWN' }).reasons, [
    'GitHub is still working out whether it merges cleanly',
  ]);
  assert.deepEqual(check({ mergeable: 'CONFLICTING', merge_state: 'DIRTY' }).reasons, ['the branch has conflicts with the base branch']);
  assert.deepEqual(check({}, { paused: 'AgentDeck is paused' }), { verdict: 'wait', reasons: ['AgentDeck is paused'] });
});

test('autoMergeCheck: with auto_resolve off a conflict needs a person and names the sync; on, it still waits', () => {
  const conflict = { mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  const off = verdictView(
    autoMergeCheck({
      repo: repoRow,
      pr_state: 'open',
      pr: { ...ready, ...conflict },
      tests_passed: true,
      paused: null,
      auto_resolve: false,
    }),
  );
  assert.equal(off.verdict, 'never');
  assert.match(off.reasons.join('\n'), /auto_resolve off.*sync/);
  const on = autoMergeCheck({
    repo: repoRow,
    pr_state: 'open',
    pr: { ...ready, ...conflict },
    tests_passed: true,
    paused: null,
    auto_resolve: true,
  });
  assert.deepEqual(on, raw(conflict));
  assert.equal(on.verdict, 'wait');
});

test('autoMergeCheck: the findings come first, then what only auto-merge asks, in order, each with its kind', () => {
  const never = raw(
    {
      labels: [],
      checks: { total: 2, failing: 1, pending: 0 },
      additions: 500,
      files: 120,
      paths: ['.claude/x.md', '.github/ci.yml'],
    },
    { tests_passed: null },
  );
  assert.deepEqual(
    never.reasons.map((r) => r.kind),
    ['checks_failing', 'no_label', 'tests_not_run', 'too_many_lines', 'files_unlisted', 'protected_paths', 'skipped_paths'],
  );
  assert.deepEqual(
    raw({ checks: { total: 0, failing: 0, pending: 0 } }, { test_cmd: null, tests_passed: null }).reasons[0].kind,
    'untested',
  );
  const wait = raw({ checks: { total: 2, failing: 0, pending: 1 }, mergeable: 'UNKNOWN' }, { paused: 'AgentDeck is paused' });
  assert.deepEqual(
    wait.reasons.map((r) => r.kind),
    ['checks_pending', 'mergeability_unknown', 'paused'],
  );
});

const comments = (lines: number, added: number) => ({ files: [], lines, added, percent: (lines / added) * 100 });
const measuredWith = (code_comments: ReturnType<typeof comments>) => ({ lines: 35, paths: ['src/a.ts'], code_comments });
const limited = { ...repoRow, code_comment_max_lines: 5, code_comment_max_percent: 5 };
const withComments = (code_comments: ReturnType<typeof comments>, repo = limited) =>
  autoMergeCheck({ repo, pr_state: 'open', pr: ready, tests_passed: true, paused: null, measured: measuredWith(code_comments) });

test("autoMergeCheck: a branch over the repo's code comment limits needs a person, and one under them does not", () => {
  const over = withComments(comments(12, 150));
  assert.equal(over.verdict, 'never');
  assert.deepEqual(over.reasons, [
    {
      kind: 'too_many_code_comments',
      text: '12 code comment lines added (8%), over the limit of 5 lines or 5%',
      tag: 'code comments +12 (8%)',
    },
  ]);
  assert.equal(withComments(comments(12, 1000)).verdict, 'never');
  assert.equal(withComments(comments(4, 150)).verdict, 'merge');
  assert.equal(withComments(comments(40, 150), { ...limited, code_comment_max_lines: 0, code_comment_max_percent: 0 }).verdict, 'merge');
});

test('the PR body says in one line that a person needs to merge a branch over the code comment limits', async () => {
  const { buildPrBody } = await import('#domain/landing/pull-request/pr.ts');
  const text = '12 code comment lines added (8%), over the limit of 5 lines or 5%';
  assert.ok(buildPrBody({ id: 7 }, [], null, text).includes(`A person needs to merge this: ${text}.`));
  assert.ok(!buildPrBody({ id: 7 }, []).includes('code comment'));
});

test('autoMergeView: the tag comes from the measurement before a PR', () => {
  const repoView = { ...limited, auto_merge: true, auto_approve: false, auto_review: false };
  const task = { auto_merge: null, source: 'manual', pr: null };
  const view = autoMergeView(task, repoView, measuredWith(comments(12, 150)));
  assert.equal(view.code_comments, 'code comments +12 (8%)');
  assert.ok(view.reasons.includes('now 12 code comment lines added (8%), over the limit of 5 lines or 5%'));
  assert.equal(autoMergeView(task, repoView, measuredWith(comments(2, 150))).code_comments, null);
});

test('a merge request reads the findings as auto-merge does, without what only auto-merge asks', () => {
  const pr = { ...ready, labels: [], additions: 5000, checks: { total: 2, failing: 0, pending: 1 } };
  const input = { pr_state: 'open' as const, pr, tests_passed: true };
  assert.deepEqual(mergeRequestCheck(input), {
    verdict: 'wait',
    reasons: [{ kind: 'checks_pending', text: '1 check still running on GitHub' }],
  });
  assert.equal(autoMergeCheck({ ...input, repo: repoRow, paused: null }).verdict, 'never');
});

type ReviewWithComments = import('#domain/landing/review/review.ts').ReviewWithComments;
let reviewIds = 0;
const reviewOf = (
  kind: 'comment' | 'request_changes',
  o: {
    by?: 'person' | 'review_run';
    diff_hash?: string | null;
    body?: string;
    comments?: { body: string; state?: 'open' | 'answered' }[];
  } = {},
): ReviewWithComments => {
  const id = ++reviewIds as ReviewWithComments['id'];
  return {
    id,
    task_id: 1 as TaskId,
    kind,
    by: o.by ?? 'review_run',
    body: o.body ?? 'Summary of the changes',
    head_commit: 'head-1',
    diff_hash: o.diff_hash === undefined ? 'diff-1' : o.diff_hash,
    created_at: '2026-11-08 10:00:00',
    submitted_at: '2026-11-08 10:00:00',
    comments: (o.comments ?? []).map((c, i) => ({
      id: id * 100 + i,
      review_id: id,
      path: 'src/a.ts',
      line: 3 + i,
      side: 'new' as const,
      head_commit: 'head-1',
      body: c.body,
      answer: null,
      state: c.state ?? 'open',
      created_at: '2026-11-08 10:00:00',
      updated_at: '2026-11-08 10:00:00',
    })),
  };
};
const reviewRun = (outcome: string | null, diff_hash = 'diff-1') => ({ kind: 'review', diff_hash, outcome });
const gated = (review: Partial<ReviewFacts>) => check({}, { review: { diff_hash: 'diff-1', reviews: [], runs: [], ...review } });

test('the review gate: with no review run of these changes yet, auto-merge waits for one', () => {
  assert.deepEqual(gated({}), { verdict: 'wait', reasons: ['the review run has not read these changes'] });
  assert.deepEqual(gated({ runs: [reviewRun(null)] }), { verdict: 'wait', reasons: ['the review run is reading these changes'] });
  assert.deepEqual(
    gated({ runs: [reviewRun('rate_limited'), reviewRun('interrupted')] }).reasons,
    ['the review run has not read these changes'],
    'a rate limit or a restart stopped it before it answered: another starts',
  );
  assert.deepEqual(
    gated({ reviews: [reviewOf('comment', { diff_hash: 'diff-0' })], runs: [reviewRun('done', 'diff-0')] }).reasons,
    ['the review run has not read these changes'],
    'a clean review of earlier changes does not count for these',
  );
  assert.equal(raw({}, { review: { diff_hash: 'diff-1', reviews: [], runs: [] } }).reasons[0].kind, 'review_pending');
  assert.deepEqual(check({}, { review: null }), { verdict: 'merge', reasons: [] }, 'auto_review off: no gate');
});

test('the review gate: a review run that asked for changes needs a person, its first blocking finding told', () => {
  const blocking = reviewOf('request_changes', {
    comments: [{ body: 'A style nit' }, { body: 'Blocking: the retry is never\n counted' }, { body: 'Blocking: second' }],
  });
  assert.deepEqual(gated({ reviews: [blocking], runs: [reviewRun('done')] }), {
    verdict: 'never',
    reasons: ['the review run asked for changes: src/a.ts:4: the retry is never counted'],
  });
  assert.equal(raw({}, { review: { diff_hash: 'diff-1', reviews: [blocking], runs: [] } }).reasons[0].kind, 'review_blocking');
  assert.deepEqual(gated({ reviews: [reviewOf('request_changes', { body: 'Misses the goal' })] }).reasons, [
    'the review run asked for changes: Misses the goal',
  ]);
});

test('the review gate: a clean review run of these changes adds nothing', () => {
  assert.deepEqual(gated({ reviews: [reviewOf('comment', { comments: [{ body: 'A style nit' }] })], runs: [reviewRun('done')] }), {
    verdict: 'merge',
    reasons: [],
  });
  assert.deepEqual(
    gated({ reviews: [reviewOf('request_changes', { diff_hash: 'diff-0' }), reviewOf('comment')] }),
    { verdict: 'merge', reasons: [] },
    'an earlier blocking review of other changes is past',
  );
});

test("the review gate: a person's review of these changes counts over the review run's", () => {
  const blocking = reviewOf('request_changes', { comments: [{ body: 'Blocking: wrong' }] });
  const person = reviewOf('comment', { by: 'person', body: 'Read it: fine' });
  assert.deepEqual(gated({ reviews: [blocking, person], runs: [reviewRun('done')] }), { verdict: 'merge', reasons: [] });
  assert.deepEqual(gated({ reviews: [person] }), { verdict: 'merge', reasons: [] }, 'no review run needed once a person read them');
  assert.deepEqual(gated({ reviews: [person, blocking] }), { verdict: 'merge', reasons: [] }, 'whichever came first');
  assert.deepEqual(gated({ reviews: [reviewOf('request_changes', { by: 'person', body: 'Not yet' })] }).reasons, [
    'a person asked for changes: Not yet',
  ]);
  assert.deepEqual(
    gated({ reviews: [blocking, reviewOf('comment', { by: 'person', diff_hash: 'diff-0' })] }).verdict,
    'never',
    "a person's review of other changes does not count",
  );
});

test('the review gate: a review run that left no review, or changes it cannot read, need a person', () => {
  for (const outcome of ['failed', 'cancelled'])
    assert.deepEqual(gated({ runs: [reviewRun(outcome)] }), {
      verdict: 'never',
      reasons: ['the review run of these changes left no review, and no other starts for them'],
    });
  assert.deepEqual(gated({ diff_hash: null }), {
    verdict: 'never',
    reasons: ["the changes could not be read at the PR's head, so no review run can read them"],
  });
});

test('the review gate: asks of earlier reviews the worker left unanswered need a person', () => {
  const earlier = reviewOf('request_changes', {
    diff_hash: 'diff-0',
    comments: [{ body: 'Blocking: handle the empty list' }, { body: 'Blocking: answered', state: 'answered' }, { body: 'A nit' }],
  });
  const asked = reviewOf('request_changes', { by: 'person', diff_hash: 'diff-0', comments: [{ body: 'Rename this' }] });
  const clean = reviewOf('comment');
  assert.deepEqual(gated({ reviews: [earlier, asked, clean] }), {
    verdict: 'never',
    reasons: ['the worker left 2 review comments unanswered: src/a.ts:3: handle the empty list and 1 more'],
  });
  assert.equal(raw({}, { review: { diff_hash: 'diff-1', reviews: [earlier, clean], runs: [] } }).reasons[0].kind, 'review_unanswered');
  assert.deepEqual(
    gated({ reviews: [earlier, reviewOf('comment', { by: 'person' })] }),
    { verdict: 'merge', reasons: [] },
    "a person's review of these changes counts over them too",
  );
});

test('the refresh gates auto-merge on the review run of the PR’s changes in a repo with auto_review on', async () => {
  updateRepo(db, 'demo', { auto_review: true });
  try {
    const branch = `agentdeck/gate-${++n}`;
    sh('checkout', '-q', '-b', branch);
    writeFileSync(join(dir, 'gate.txt'), 'gated\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'gated change');
    const head = sh('rev-parse', 'HEAD');
    sh('checkout', '-q', 'main');
    const url = `https://x/pull/${n}`;
    const t = doneTask(db, repo, { pr: 'open', url, branch });
    db.finishRun(db.startRun(t.id, 1, join(home, `run-${t.id}.log`)), { tests_passed: true });
    details[url] = { ...ready, head };
    const diff_hash = (await db.workspace.diffHash(dir, 'main', head))!;
    assert.ok(diff_hash);

    assert.deepEqual((await refreshPrStates(db)).mergeable, [], 'no review run yet');
    assert.deepEqual(db.getTask(t.id)!.pr?.auto_merge_check?.reasons, [
      { kind: 'review_pending', text: 'the review run has not read these changes' },
    ]);
    const preview = await mergePreview(db, t.id);
    assert.equal(preview.auto_merge?.verdict, 'wait');
    assert.equal(preview.request.verdict, 'merge', "a person's merge request does not wait on the review run");

    const blocking = db.addRunReview(t.id, 'request_changes', 'Misses a case', { head_commit: head, diff_hash });
    db.addComment({ review_id: blocking.id, path: 'gate.txt', line: 1, side: 'new', head_commit: head, body: 'Blocking: empty file' });
    assert.deepEqual((await refreshPrStates(db)).mergeable, []);
    assert.deepEqual(db.getTask(t.id)!.pr?.auto_merge_check?.verdict, 'never');

    const person = db.createReview(t.id);
    assert.ok(db.submitReview(person.id, 'comment', 'Read it: the empty file is fine', { head_commit: head, diff_hash }));
    const found = await refreshPrStates(db);
    assert.deepEqual(
      found.mergeable.map((m) => m.id),
      [t.id],
      "the person's review counts over the review run's",
    );
  } finally {
    updateRepo(db, 'demo', { auto_review: false });
  }
});

test('repo auto-merge settings: off by default, set from the CLI and the API, validated', () => {
  const fresh = db.addRepo({ name: 'fresh', path: join(home, 'fresh'), base_branch: 'main' });
  assert.deepEqual([fresh.auto_merge, fresh.auto_merge_max_lines, fresh.auto_merge_skip], [false, 400, ['.github/']]);
  const set = (key: string, value: string) => updateRepo(db, 'fresh', repoSettingPatch(key, value));
  assert.equal(set('auto_merge', 'on').auto_merge, 1);
  assert.equal(set('auto_merge_max_lines', '120').auto_merge_max_lines, 120);
  assert.equal(set('auto_merge_skip', '.github/, db/schema.ts').auto_merge_skip, '[".github/","db/schema.ts"]');
  assert.throws(() => set('auto_merge_max_lines', '0'), ActionError);
  assert.throws(() => set('auto_merge_max_lines', 'lots'), ActionError);
  assert.throws(() => set('auto_merge', 'maybe'), /on, .* or .*off.*"maybe"/);
  assert.equal(db.findRepo('fresh')!.auto_merge, true);
});

test('a PR the daemon may merge opens with the label; one it may not opens without', async () => {
  const on = doneTask(db, repo, { title: 'labelled', branch: 'agentdeck/labelled' });
  await openPullRequest(db, db.getTask(on.id)!);
  assert.deepEqual(gh.created.at(-1), [AUTO_MERGE_LABEL.name]);
  assert.equal(gh.labelsMade, 1);

  updateRepo(db, 'demo', { auto_merge: false });
  const off = doneTask(db, repo, { title: 'plain', branch: 'agentdeck/plain' });
  await openPullRequest(db, db.getTask(off.id)!);
  assert.deepEqual(gh.created.at(-1), []);

  updateRepo(db, 'demo', { auto_merge: true });
  github.ensureLabel = async () => {
    throw new Error('HTTP 403');
  };
  try {
    const denied = doneTask(db, repo, { title: 'no label allowed', branch: 'agentdeck/denied' });
    const res = await openPullRequest(db, db.getTask(denied.id)!);
    assert.ok(res.url, 'the PR still opens');
    assert.deepEqual(gh.created.at(-1), []);
  } finally {
    github.ensureLabel = async () => void gh.labelsMade++;
  }
});

test('the refresh finds a ready PR and autoMerge merges it, records who did, cleans up and releases its dependents', async () => {
  const t = tested({ title: 'Ship it alone' });
  const later = await addTask(db, { repo: 'demo', prompt: 'after the merge', builds_on: [t.id] });
  assert.ok(waiting(db.getTask(later.id)!));

  const found = await refreshPrStates(db);
  assert.deepEqual(found.mergeable, [auto(t.id)]);
  assert.equal(await autoMerge(db, found.mergeable), t.id);
  assert.deepEqual(gh.merged, [t.url]);
  assert.deepEqual(gh.heads, [ready.head], 'merged pinned to the head the refresh read');
  assert.deepEqual(gh.deleted, [t.branch]);
  assert.equal(db.getTask(t.id)!.pr?.state, 'merged');
  assert.equal(db.eventsForTask(t.id).at(-1)!.reason, 'auto-merged (squash)');
  assert.equal(waiting(db.getTask(later.id)!), null);
  assert.deepEqual(
    db
      .recentNotifications(10)
      .filter((x) => x.task_id === t.id)
      .map((x) => x.kind),
    ['merged'],
  );
  db.applyEvent(later.id, { type: 'cancel' });
});

test('the refresh leaves PRs that need a person or must wait, and the preview says why', async () => {
  const failing = tested();
  details[failing.url] = { ...ready, checks: { total: 2, failing: 1, pending: 0 } };
  const big = tested();
  details[big.url] = { ...ready, additions: 900 };
  const workflow = tested();
  details[workflow.url] = { ...ready, paths: ['.github/workflows/ci.yml', 'src/a.ts'] };
  const unlabelled = tested();
  details[unlabelled.url] = { ...ready, labels: [] };
  const pending = tested();
  details[pending.url] = { ...ready, checks: { total: 2, failing: 0, pending: 2 } };
  const untested = doneTask(db, repo, { pr: 'open', url: `https://x/pull/${++n}` });

  const found = await refreshPrStates(db);
  assert.deepEqual(found.mergeable, []);

  assert.deepEqual((await mergePreview(db, workflow.id)).auto_merge, { verdict: 'never', reasons: ['touches .github/workflows/ci.yml'] });
  assert.deepEqual((await mergePreview(db, pending.id)).auto_merge, { verdict: 'wait', reasons: ['2 checks still running on GitHub'] });
  assert.deepEqual((await mergePreview(db, untested.id)).auto_merge?.reasons, ['the tests have not run']);
});

test('a paused daemon or repo waits; a planner proposal the planner approved itself never merges', async () => {
  const t = tested();
  db.setPaused(true);
  assert.deepEqual((await refreshPrStates(db)).mergeable, []);
  assert.deepEqual((await mergePreview(db, t.id)).auto_merge, { verdict: 'wait', reasons: ['AgentDeck is paused'] });
  db.setPaused(false);
  db.setRepoPaused(repo.id, 'doctor failed');
  assert.deepEqual((await mergePreview(db, t.id)).auto_merge?.reasons, ['the repo is paused: doctor failed']);
  db.setRepoPaused(repo.id, null);

  updateRepo(db, 'demo', { auto_approve: true });
  const proposal = tested({ source: 'planner' });
  assert.equal((await mergePreview(db, proposal.id)).auto_merge, null, 'off: no person saw it');
  assert.deepEqual(
    (await refreshPrStates(db)).mergeable.map((r) => r.id),
    [t.id],
  );
});

test('autoMerge merges one PR per call, skips one that moved on, and tells a refused merge once', async () => {
  const gone = tested();
  db.recordPr(gone.id, { type: 'closed' });
  const a = tested();
  const b = tested();
  const candidates = [gone, a, b].map(({ id }) => auto(id));
  assert.equal(await autoMerge(db, candidates), a.id);
  assert.deepEqual(gh.merged, [a.url], 'b waits for the re-read the merge asks for');

  mergeError = 'Pull request is not mergeable: the base branch policy prohibits the merge';
  const told = new Map<TaskId, string>();
  const logs: string[] = [];
  for (let i = 0; i < 3; i++) assert.equal(await autoMerge(db, [auto(b.id)], { told, log: (m) => logs.push(m) }), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /base branch policy/);
  assert.equal(db.recentNotifications(50).filter((x) => x.task_id === b.id).length, 1);
  assert.equal(db.getTask(b.id)!.status, 'done');
  assert.equal(db.getTask(b.id)!.pr?.state, 'open');
});

test('a merge and a sync never touch one task at once', async () => {
  const a = tested();
  db.setSyncing(a.id, true);
  await assert.rejects(mergeTask(db, a.id), /syncing/);
  assert.equal(await autoMerge(db, [auto(a.id)]), null);
  assert.deepEqual(gh.merged, []);
  assert.equal(db.recentNotifications(50).filter((x) => x.task_id === a.id).length, 0);
  db.setSyncing(a.id, false);

  const b = tested();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const merge = github.merge;
  github.merge = async (pr) => {
    await held;
    return merge(pr);
  };
  try {
    const merging = mergeTask(db, b.id);
    await waitFor(() => isMergeLocked(b.id), { what: `the merge of #${b.id} to take its lock` });
    await assert.rejects(syncNow(db, b.id), /being merged/);
    await assert.rejects(mergeTask(db, b.id), /already being merged/);
    const logs: string[] = [];
    await resolveConflicting(db, [b.id], (m) => logs.push(m));
    assert.deepEqual(logs, []);
    release();
    await merging;
  } finally {
    github.merge = merge;
  }
  assert.deepEqual(gh.merged, [b.url]);
});

const notified = (id: TaskId) => db.recentNotifications(50).filter((x) => x.task_id === id);

test('a merge gh reports failed while GitHub has it merged is recorded with its reason, cleaned up and notified once', async () => {
  const a = tested({ title: 'timed out after merging' });
  mergeError = 'gh timed out after 60s';
  const prDetails = github.prDetails;
  github.prDetails = async () => ({ ...ready, state: 'merged' });
  try {
    assert.equal(await autoMerge(db, [auto(a.id)]), a.id);
  } finally {
    github.prDetails = prDetails;
  }
  assert.equal(db.getTask(a.id)!.pr?.state, 'merged');
  assert.equal(db.eventsForTask(a.id).at(-1)!.reason, 'auto-merged (squash)');
  assert.deepEqual(gh.deleted, [a.branch]);
  assert.deepEqual(
    notified(a.id).map((x) => x.title),
    [`Merged #${a.id}`],
  );
});

test('a merge gh reports failed because someone else merged and recorded it says nothing', async () => {
  const a = tested();
  const { prDetails, merge } = github;
  github.merge = async () => {
    db.recordMerge(a.id, 'merge', 'merged by a person (merge)');
    throw new Error('Pull request is already merged');
  };
  github.prDetails = async () => ({ ...ready, state: 'merged' });
  try {
    assert.equal(await autoMerge(db, [auto(a.id)]), null);
  } finally {
    Object.assign(github, { prDetails, merge });
  }
  assert.equal(db.eventsForTask(a.id).at(-1)!.reason, 'merged by a person (merge)');
  assert.deepEqual(gh.deleted, [], 'the cleanup is the merger’s');
  assert.equal(notified(a.id).length, 0);
});

test('autoMerge skips a PR whose request was withdrawn, or whose auto-merge was turned off, after the refresh', async () => {
  const asked = tested();
  requestMerge(db, asked.id);
  const off = tested();
  const found = await refreshPrStates(db);
  assert.deepEqual(found.mergeable, [
    { id: asked.id, pr: ready, requested: true },
    { id: off.id, pr: ready, requested: false },
  ]);
  cancelMergeRequest(db, asked.id);
  db.setAutoMerge(off.id, false);
  assert.equal(await autoMerge(db, found.mergeable), null);
  assert.deepEqual(gh.merged, [], 'neither falls through to its repo’s auto-merge');
  assert.equal(notified(asked.id).length + notified(off.id).length, 0);
});

test('a head that moved since the refresh leaves the request in place and sends nothing', async () => {
  const fake = fakeCodeHost();
  const real = db.codeHost;
  const app = testApp(db, { codeHost: fake });
  try {
    await headMoved(app, fake);
  } finally {
    testApp(db, { codeHost: real });
  }
});

async function headMoved(app: typeof db, fake: ReturnType<typeof fakeCodeHost>) {
  const t = tested();
  requestMerge(app, t.id);
  const read = { ...READY_PR, head: 'judged-head' };
  fake.details[t.url] = read;
  const found = await refreshPrStates(app);
  assert.deepEqual(found.mergeable, [{ id: t.id, pr: read, requested: true }]);
  assert.equal(await autoMerge(app, found.mergeable), t.id);
  assert.deepEqual(
    fake.merged.map((m) => m.head),
    ['judged-head'],
    'merge is called with the head the refresh read',
  );

  const moved = tested();
  requestMerge(app, moved.id);
  fake.details[moved.url] = read;
  fake.merge = async () => {
    throw new Error('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
  };
  const logs: string[] = [];
  const next = await refreshPrStates(app);
  assert.equal(await autoMerge(app, next.mergeable, { log: (m) => logs.push(m) }), null);
  assert.ok(db.getTask(moved.id)!.pr?.merge_request, 'the request waits for the next round');
  assert.equal(db.getTask(moved.id)!.pr?.state, 'open');
  assert.equal(notified(moved.id).length, 0);
  assert.match(logs.join('\n'), /left for the next refresh: .*Head branch was modified/);
}

test('a transient merge error keeps the merge request; a lasting one drops it and notifies once', async () => {
  const t = tested();
  requestMerge(db, t.id);
  const requested = [{ id: t.id, pr: ready, requested: true }];
  for (const error of [
    'GraphQL: Base branch was modified. Review and try the merge again.',
    'HTTP 502: Bad Gateway',
    'gh timed out after 60s',
  ]) {
    mergeError = error;
    assert.equal(await autoMerge(db, requested), null, error);
    assert.ok(db.getTask(t.id)!.pr?.merge_request, `kept after: ${error}`);
  }
  assert.equal(notified(t.id).length, 0);

  mergeError = 'Pull request is not mergeable: the base branch policy prohibits the merge';
  assert.equal(await autoMerge(db, requested), null);
  assert.equal(db.getTask(t.id)!.pr?.merge_request, null, 'dropped: a person must act');
  assert.deepEqual(
    notified(t.id).map((x) => x.title),
    [`Could not merge #${t.id}`],
  );
  assert.equal(await autoMerge(db, requested), null);
  assert.equal(notified(t.id).length, 1);
});

test('mergeFailure: what passes on its own, and what needs a person', () => {
  const cases: [string, string][] = [
    ['GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)', 'head_moved'],
    ['GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)', 'transient'],
    ['HTTP 502: Bad Gateway (https://api.github.com/graphql)', 'transient'],
    ['HTTP 503: Service Unavailable', 'transient'],
    ['gh timed out after 60s', 'transient'],
    ['Post "https://api.github.com/graphql": read: connection reset by peer', 'transient'],
    ['Pull request is not mergeable: the base branch policy prohibits the merge', 'lasting'],
    ['GraphQL: Pull Request is not mergeable (mergePullRequest)', 'lasting'],
    ['HTTP 403: Resource not accessible by integration', 'lasting'],
    ['merge #502 refused', 'lasting'],
  ];
  for (const [message, failure] of cases) assert.equal(mergeFailure(message), failure, message);
});

test('setAutoMerge overrides the repo for one task and moves the label on its open PR', async () => {
  const t = tested();
  assert.deepEqual(await setAutoMerge(db, t.id, { auto_merge: false }), { auto_merge: false });
  assert.equal(db.getTask(t.id)!.auto_merge, false);
  assert.deepEqual(gh.labelled, [{ url: t.url, on: false }]);
  assert.equal((await mergePreview(db, t.id)).auto_merge, null);

  updateRepo(db, 'demo', { auto_merge: false });
  assert.deepEqual(await setAutoMerge(db, t.id, { auto_merge: true }), { auto_merge: true });
  assert.equal(gh.labelsMade, 1, 'the label is made before it is added');
  assert.deepEqual(gh.labelled.at(-1), { url: t.url, on: true });

  assert.deepEqual(await setAutoMerge(db, t.id, { auto_merge: null }), { auto_merge: false }, "back to the repo's: off");
  assert.equal(db.getTask(t.id)!.auto_merge, null);
  await assert.rejects(setAutoMerge(db, t.id, { auto_merge: 'yes' as never }), ActionError);

  github.setLabel = async () => {
    throw new Error('HTTP 403');
  };
  try {
    assert.deepEqual(await setAutoMerge(db, t.id, { auto_merge: true }), { auto_merge: true, label_error: 'HTTP 403' });
    assert.equal(db.getTask(t.id)!.auto_merge, true, 'the setting is kept');
  } finally {
    github.setLabel = async (url, _cwd, _label, on) => void gh.labelled.push({ url, on });
  }
});

test('the scheduler merges a ready PR on its own refresh, and tells a merge that keeps failing once', async () => {
  const { Scheduler } = await import('#application/scheduler/scheduler.ts');
  const stuck = tested({ title: 'refused' });
  mergeError = 'the base branch policy prohibits the merge';
  const told = () => db.recentNotifications(50).filter((x) => x.task_id === stuck.id).length;
  const logs: string[] = [];
  const scheduler = new Scheduler(db, { tickMs: 10, prRefreshMs: 10, autoPropose: false, log: (m) => logs.push(m) });
  const running = scheduler.run();
  let t: ReturnType<typeof tested>;
  try {
    await waitFor(() => told() > 0, { what: 'the failed auto-merge to be told' });
    await sleep(200);
    assert.equal(logs.filter((l) => l.includes(`task ${stuck.id}: auto-merge failed`)).length, 1);
    assert.equal(told(), 1, 'told once, not every refresh');

    mergeError = null;
    t = tested({ title: 'merge me' });
    await waitFor(() => db.getTask(t.id)!.pr?.state === 'merged', { what: `the PR of #${t.id} to be merged` });
  } finally {
    scheduler.stop();
    await running;
  }
  assert.equal(db.getTask(t.id)!.pr?.state, 'merged');
});
