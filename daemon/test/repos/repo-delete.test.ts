// Deleting an archived repo removes everything of it, locally, and nothing of another repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-delete-'));
process.env.AGENTDECK_HOME = home;

const { openDb } = await import('#test/fixtures/open-db.ts');
const actions = await import('#application/actions.ts');
const { ensureWorktree } = await import('#adapters/git/worktrees.ts');
const { writeGoals, goalsPath } = await import('#adapters/local/goals.ts');
const { settingsPath } = await import('#domain/runs/translate/sandbox.ts');
const db = openDb(join(home, 'test.db'));

after(() => db.close());

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function makeRepo(name: string) {
  const path = join(home, name);
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return db.addRepo({ name, path, base_branch: 'main' });
}

function fill(repo: ReturnType<typeof makeRepo>, opts: { worktree: boolean }) {
  const task = db.addTask({ repo_id: repo.id, title: 't', prompt: 'x' });
  db.applyEvent(task.id, { type: 'claim' });
  db.applyEvent(task.id, { type: 'finish', outcome: 'done' });
  const logs: string[] = [];
  for (const n of [1, 2]) {
    const log = join(home, `${repo.name}-${task.id}-${n}.jsonl`);
    writeFileSync(log, '{}\n');
    writeFileSync(settingsPath(log), '{}');
    logs.push(log, settingsPath(log));
    db.startRun(task.id, n, log);
  }
  const plog = join(home, `proposals-${repo.name}.jsonl`);
  writeFileSync(plog, '{}\n');
  logs.push(plog);
  db.startPlannerRun(repo.id, plog);
  db.raw.prepare("INSERT INTO task_plans (task_id, name, source, html) VALUES (?, 'plan.html', 'attached', '<html></html>')").run(task.id);
  db.addNotification('done', 't', 'b', task.id);
  const review = db.createReview(task.id);
  db.addComment({ review_id: review.id, path: 'a.txt', line: 1, side: 'new', head_commit: 'abc', body: 'fix' });
  writeGoals(repo, 'goals');
  return { task, logs, worktree: opts.worktree };
}

const count = (sql: string, ...args: number[]) => (db.raw.prepare(sql).get(...args) as { n: number }).n;
const rowsFor = (repoId: number) =>
  [
    'SELECT COUNT(*) n FROM tasks WHERE repo_id = ?',
    'SELECT COUNT(*) n FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)',
    'SELECT COUNT(*) n FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)',
    'SELECT COUNT(*) n FROM task_plans WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)',
    'SELECT COUNT(*) n FROM notifications WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)',
    'SELECT COUNT(*) n FROM reviews WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)',
    'SELECT COUNT(*) n FROM review_comments WHERE review_id IN (SELECT r.id FROM reviews r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ?)',
    'SELECT COUNT(*) n FROM planner_runs WHERE repo_id = ?',
    'SELECT COUNT(*) n FROM repos WHERE id = ?',
  ].map((sql) => count(sql, repoId));

test('delete refuses an active repo', async () => {
  const repo = makeRepo('active');
  fill(repo, { worktree: false });
  await assert.rejects(actions.deleteRepo(db, 'active'), /not archived/);
  assert.ok(db.getRepo(repo.id));
  assert.ok(rowsFor(repo.id).every((n) => n > 0));
});

test('deleting an archived repo leaves no rows, worktree, branch or files, and spares another repo', async () => {
  const keep = makeRepo('keep');
  const gone = makeRepo('gone');
  const kept = fill(keep, { worktree: false });
  const mine = fill(gone, { worktree: true });
  const { path: worktree, branch } = await ensureWorktree(gone, db.getTask(mine.task.id)!);
  db.setCheckout(mine.task.id, { worktree, branch });
  assert.ok(existsSync(worktree));
  const keptBefore = rowsFor(keep.id);

  actions.archiveRepo(db, 'gone');
  const preview = actions.repoDeletionPreview(db, 'gone');
  assert.deepEqual([preview.tasks, preview.runs, preview.worktrees], [1, 2, 1]);

  const res = await actions.deleteRepo(db, 'gone');
  assert.deepEqual(res.leftover, []);
  assert.deepEqual(rowsFor(gone.id), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(gone.path, 'branch', '--list', branch), '');
  assert.equal(git(gone.path, 'worktree', 'list').split('\n').length, 1);
  for (const f of [...mine.logs, goalsPath(gone)]) assert.equal(existsSync(f), false, f);

  assert.deepEqual(rowsFor(keep.id), keptBefore);
  for (const f of [...kept.logs, goalsPath(keep)]) assert.ok(existsSync(f), f);
});

test('a missing worktree, branch or log does not stop it', async () => {
  const repo = makeRepo('hollow');
  const { task, logs } = fill(repo, { worktree: false });
  rmSync(logs[0]);
  db.setCheckout(task.id, { worktree: join(home, 'no-such-worktree'), branch: 'agentdeck/task-missing' });
  actions.archiveRepo(db, 'hollow');
  const res = await actions.deleteRepo(db, 'hollow');
  assert.deepEqual(res.leftover, []);
  assert.deepEqual(rowsFor(repo.id), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});
