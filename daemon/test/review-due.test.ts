// Area reviews due: the pure decision from a repo's refs/reviewed/* marks, the git adapter on a temp repo whose mark
// moves, the once-a-day reminder, the doctor's warning, and the review_due_days and review_due_lines settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-review-due-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { reviewDue, remindReviewDue, reviewDueNotification, DEFAULT_REVIEW_DUE } = await import('../src/domain/operations/index.ts');
const { checkReviews } = await import('../src/domain/operations/review-due.ts');
const { judgeHealth } = await import('../src/domain/operations/health.ts');
const { headline } = await import('../src/domain/operations/headline.ts');
const { checkReviewsDue } = await import('../src/application/operations/review-due.ts');
const { getSettings, status, updateSettings } = await import('../src/application/actions.ts');
const { daemonCommands } = await import('../src/cli/daemon.ts');
const { openDb } = await import('./open-db.ts');
const { asRepoId } = await import('./fixtures.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const repo = { id: asRepoId(1), name: 'demo' };
const settings = DEFAULT_REVIEW_DUE;

// --- The decision, pure ---

test('reviewDue: fresh, old, many lines and no marks', () => {
  const table = [
    { name: 'fresh', marks: [{ area: 'plan', at: NOW - 2 * DAY }], commits: 4, lines: 120, due: null },
    {
      name: 'old',
      marks: [
        { area: 'plan', at: NOW - 2 * DAY },
        { area: 'sync', at: NOW - 9 * DAY },
      ],
      commits: 115,
      lines: 900,
      due: 'area review due: 9 days, 115 commits since the last',
    },
    { name: 'exactly a week', marks: [{ area: 'plan', at: NOW - 7 * DAY }], commits: 3, lines: 10, due: null },
    {
      name: 'many lines',
      marks: [{ area: 'plan', at: NOW - DAY }],
      commits: 40,
      lines: 3001,
      due: 'area review due: 1 day, 40 commits since the last',
    },
    { name: 'no marks, few lines', marks: [], commits: 10, lines: 3000, due: null },
    {
      name: 'no marks, many lines',
      marks: [],
      commits: 52,
      lines: 4200,
      due: 'area review due: none yet, 52 commits (4,200 lines) merged since the repo was added',
    },
  ];
  for (const row of table) {
    const got = reviewDue(repo, { marks: row.marks, commits: row.commits, lines: row.lines }, settings, NOW);
    assert.equal(got?.line ?? null, row.due, row.name);
  }
  const old = reviewDue(repo, { marks: [{ area: 'sync', at: NOW - 9 * DAY }], commits: 1, lines: 1 }, settings, NOW);
  assert.deepEqual(
    { area: old?.area, days: old?.days, repo_id: old?.repo_id },
    { area: 'sync', days: 9, repo_id: repo.id },
    'names the oldest mark',
  );
  assert.equal(
    reviewDue(repo, { marks: [{ area: 'plan', at: NOW - 4 * DAY }], commits: 1, lines: 1 }, { days: 3, lines: 3000 }, NOW)?.days,
    4,
  );
});

test('a person is reminded at most once a day', () => {
  assert.equal(remindReviewDue(null, NOW), true);
  assert.equal(remindReviewDue(NOW - 60_000, NOW), false);
  assert.equal(remindReviewDue(NOW - DAY + 1, NOW), false);
  assert.equal(remindReviewDue(NOW - DAY, NOW), true);
});

test('the notification, the headline and the doctor name the due repo; the doctor only warns', () => {
  const due = reviewDue(repo, { marks: [{ area: 'sync', at: NOW - 9 * DAY }], commits: 115, lines: 900 }, settings, NOW)!;
  const n = reviewDueNotification(due);
  assert.equal(n.kind, 'review_due');
  assert.equal(n.title, 'demo: area review due');
  assert.match(n.body, /^9 days, 115 commits since the last\. The oldest mark is refs\/reviewed\/sync\. .*review-area/);

  const h = headline(
    {
      paused: false,
      rate_limited_until: null,
      governor: { allow: true, reason: null, until: null },
      running: 0,
      need_you: { proposed: 0, blocked: 0, review: 0 },
      attention: [],
      review_due: [due],
    } as never,
    NOW / 1000,
  );
  assert.deepEqual(h.review_due, [{ repo: 'demo', line: 'area review due: 9 days, 115 commits since the last' }]);

  assert.deepEqual(checkReviews([]), { name: 'area reviews', ok: true, reason: 'none due', fix: null });
  const warned = checkReviews([due]);
  assert.equal(warned.ok, true, 'a warning, never a failure');
  assert.equal(warned.warning, true);
  assert.match(warned.reason, /demo: area review due: 9 days/);
  assert.match(warned.fix ?? '', /review-area/);
  assert.ok(
    judgeHealth({ ...healthyFacts(), reviews: [due] } as never).some((c) => c.name === 'area reviews' && c.warning),
    'judgeHealth lists it',
  );
});

/** Facts on which every other doctor check passes. */
function healthyFacts() {
  return {
    service: { installed: true, loaded: true, running: true, pid: 1, plist: null, lastExit: null },
    api: { ok: true, commit: 'abc', started_at: NOW / 1000, reload: { pending: false, blocked: null, waiting: 0 } },
    head: 'abc',
    behind: null,
    processes: [],
    tasks: [],
    log: { problems: [], lastStop: null },
    gh: { ok: true, output: 'Logged in' },
  };
}

// --- On a real repo ---

const db = openDb(join(home, 'agentdeck.db'));
after(() => db.close());

const sh = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

/** A commit of `lines` new lines, committed at `at` (ms). */
function commit(dir: string, name: string, lines: number, at: number): string {
  writeFileSync(join(dir, name), `${Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')}\n`);
  const date = new Date(at).toISOString();
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  sh(dir, env, 'add', '-A');
  sh(dir, env, 'commit', '-q', '-m', name);
  return sh(dir, {}, 'rev-parse', 'HEAD');
}

const dir = join(home, 'demo');
mkdirSync(dir);
sh(dir, {}, 'init', '-q', '-b', 'main');
sh(dir, {}, 'config', 'user.email', 'test@example.com');
sh(dir, {}, 'config', 'user.name', 'test');
const reviewed = commit(dir, 'a.txt', 10, NOW - 10 * DAY);
commit(dir, 'b.txt', 20, NOW - 3 * DAY);
const tip = commit(dir, 'c.txt', 30, NOW - DAY);
sh(dir, {}, 'update-ref', 'refs/reviewed/plan', reviewed);
const demo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });

const reviewDueNotes = () => db.recentNotifications(50).filter((n) => n.kind === 'review_due');

test('the git adapter reads the marks, and the commits and lines merged since the oldest', async () => {
  const facts = await db.workspace.reviewFacts(dir, 'main', NOW);
  assert.deepEqual(facts, {
    marks: [{ area: 'plan', at: Date.parse(new Date(NOW - 10 * DAY).toISOString().slice(0, 19) + 'Z') }],
    commits: 2,
    lines: 50,
  });
  sh(dir, {}, 'update-ref', 'refs/reviewed/sync', tip);
  const both = await db.workspace.reviewFacts(dir, 'main', NOW);
  assert.equal(both?.marks.length, 2);
  assert.equal(both?.commits, 2, 'counted from the oldest mark');
  sh(dir, {}, 'update-ref', '-d', 'refs/reviewed/sync');
});

test('a due repo is reminded once over two ticks a minute apart, and again the next day', async () => {
  assert.ok(db.notifySettings().events.includes('review_due'), 'on by default');
  const first = await checkReviewsDue(db, NOW);
  assert.deepEqual(
    first.map((d) => d.line),
    ['area review due: 10 days, 2 commits since the last'],
  );
  assert.equal(first[0].repo_id, demo.id);
  assert.deepEqual(
    status(db).headline.review_due,
    [{ repo: 'demo', line: 'area review due: 10 days, 2 commits since the last' }],
    'the headline shows it',
  );
  assert.equal(reviewDueNotes().length, 1);

  await checkReviewsDue(db, NOW + 60_000);
  assert.equal(reviewDueNotes().length, 1, 'not again a minute later');

  await checkReviewsDue(db, NOW + DAY + 60_000);
  assert.equal(reviewDueNotes().length, 2, 'again the next day');
  assert.match(reviewDueNotes()[0].title, /^demo: area review due$/);
});

test('moving the mark clears the repo on the next check', async () => {
  sh(dir, {}, 'update-ref', 'refs/reviewed/plan', tip);
  assert.deepEqual(await checkReviewsDue(db, NOW), []);
  assert.deepEqual(status(db).headline.review_due, []);
});

test('a repo with no mark is due once more than review_due_lines lines merged since it was added', async () => {
  sh(dir, {}, 'update-ref', '-d', 'refs/reviewed/plan');
  // The repo was added just now, so every commit above is from before it: nothing merged since.
  assert.deepEqual(await checkReviewsDue(db, Date.now()), []);
  // Counted from the base as it was when the repo was added; from the empty tree when it is older than every commit.
  assert.deepEqual(await db.workspace.reviewFacts(dir, 'main', NOW - 5 * DAY), { marks: [], commits: 2, lines: 50 });
  assert.deepEqual(await db.workspace.reviewFacts(dir, 'main', NOW - 30 * DAY), { marks: [], commits: 3, lines: 60 });
  assert.equal(reviewDue(repo, { marks: [], commits: 3, lines: 60 }, { days: 7, lines: 50 }, NOW)?.days, null);
  sh(dir, {}, 'update-ref', 'refs/reviewed/plan', tip);
});

// --- The settings ---

test('agentdeck set review_due_days and review_due_lines, shown by agentdeck settings', async () => {
  assert.deepEqual(getSettings(db).review_due, { days: 7, lines: 3000 });
  assert.equal(await inProcess(daemonCommands.set, ['review_due_days', '3']), 'review_due_days = 3');
  assert.equal(await inProcess(daemonCommands.set, ['review_due_lines', '500']), 'review_due_lines = 500');
  assert.deepEqual(getSettings(db).review_due, { days: 3, lines: 500 });
  const shown = await inProcess(daemonCommands.settings, []);
  assert.match(shown, /^review_due_days {2}3 /m);
  assert.match(shown, /^review_due_lines 500 /m);
  assert.throws(() => updateSettings(db, { review_due: { days: 0 } }), /review_due_days/);
  assert.throws(() => updateSettings(db, { review_due: { lines: 1.5 } }), /review_due_lines/);

  // Three days with a three-day-old mark: due again.
  sh(dir, {}, 'update-ref', 'refs/reviewed/plan', reviewed);
  const dues = await checkReviewsDue(db, NOW);
  assert.equal(dues.length, 1);
  updateSettings(db, { review_due: { days: 7, lines: 3000 } });
});

/** Run a CLI command in this process on `db`, returning what it printed. */
async function inProcess(command: (ctx: never) => unknown, rest: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (m: unknown) => void out.push(String(m));
  try {
    await command({ db, cmd: 'test', rest, flags: {}, repoName: () => 'demo' } as never);
  } finally {
    console.log = log;
  }
  return out.join('\n');
}
