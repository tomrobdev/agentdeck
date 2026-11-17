// Archiving a repo hides it and its tasks and stops its work; unarchiving brings it all back.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-archive-'));
process.env.AGENTDECK_HOME = home;

const { openDb } = await import('#test/fixtures/open-db.ts');
const { openPr } = await import('#test/fixtures/fixtures.ts');
const actions = await import('#application/actions.ts');
const { plannerDue } = await import('#application/proposals/planner.ts');
const db = openDb(join(home, 'test.db'));

after(() => db.close());

test('an archived repo and its tasks disappear everywhere, and come back unchanged', () => {
  const keep = db.addRepo({ name: 'keep', path: '/tmp/keep', base_branch: 'main' });
  const gone = db.addRepo({ name: 'gone', path: '/tmp/gone', base_branch: 'main' });
  const kept = db.addTask({ repo_id: keep.id, title: 'kept', prompt: 'x' });
  const queued = db.addTask({ repo_id: gone.id, title: 'queued', prompt: 'x', priority: 9 });
  const done = db.addTask({ repo_id: gone.id, title: 'done', prompt: 'x' });
  assert.equal(db.claimNextTask()?.id, queued.id);
  db.applyEvent(queued.id, { type: 'finish', outcome: 'done' });
  db.applyEvent(done.id, { type: 'claim' });
  db.applyEvent(done.id, { type: 'finish', outcome: 'done' });
  for (const id of [queued.id, done.id]) openPr(db, id, `https://x/${id}`);
  const again = db.addTask({ repo_id: gone.id, title: 'still queued', prompt: 'x', priority: 9 });

  const before = {
    counts: db.countByStatus(),
    review: db.countReview(),
    statuses: db.listTasks().map((t) => [t.id, t.status]),
  };
  assert.equal(before.review, 2);

  actions.archiveRepo(db, 'gone');
  assert.deepEqual(
    db.listRepos().map((r) => r.name),
    ['keep'],
  );
  assert.deepEqual(
    db.listRepos({ archived: true }).map((r) => r.name),
    ['gone'],
  );
  assert.deepEqual(
    db.listTasks().map((t) => t.id),
    [kept.id],
  );
  assert.deepEqual(
    db.listTaskSummaries({ limit: 100 }).map((t) => t.id),
    [kept.id],
  );
  assert.deepEqual(db.countByStatus(), { queued: 1 });
  assert.equal(db.countReview(), 0);
  assert.deepEqual(db.openPrTasks(), []);
  assert.equal(db.claimNextTask()?.id, kept.id, 'only the active repo is claimed');
  assert.equal(db.claimNextTask(), undefined, 'the archived repo’s queued task is never claimed');
  assert.equal(db.hasQueued(), false);

  actions.unarchiveRepo(db, 'gone');
  db.applyEvent(kept.id, { type: 'finish', outcome: 'done' });
  assert.deepEqual(
    db.listTasks().map((t) => [t.id, t.status]),
    [
      [again.id, 'queued'],
      [done.id, 'done'],
      [queued.id, 'done'],
      [kept.id, 'done'],
    ],
  );
  assert.equal(db.countReview(), 2);
  assert.equal(db.claimNextTask()?.id, again.id);
});

test('archiving refuses while a task of the repo is running', () => {
  const repo = db.addRepo({ name: 'busy', path: '/tmp/busy', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 'busy', prompt: 'x' });
  assert.equal(db.claimNextTask()?.id, t.id);
  assert.throws(() => actions.archiveRepo(db, 'busy'), /running/);
  db.applyEvent(t.id, { type: 'cancel' });
  assert.equal(db.getTask(t.id)!.status, 'cancel_requested');
  assert.throws(() => actions.archiveRepo(db, 'busy'), /running/);
  db.applyEvent(t.id, { type: 'finish', outcome: 'cancelled' });
  assert.ok(actions.archiveRepo(db, 'busy').archived_at);
});

test('the planner skips an archived repo', () => {
  const repo = db.addRepo({ name: 'plan', path: '/tmp/plan', base_branch: 'main' });
  actions.updateRepo(db, repo.id, { goals: '# Goals\n- something' });
  assert.equal(plannerDue(db, db.getRepo(repo.id)!), 'queue is empty');
  actions.archiveRepo(db, repo.id);
  assert.equal(plannerDue(db, db.getRepo(repo.id)!), null);
  actions.unarchiveRepo(db, repo.id);
  assert.equal(plannerDue(db, db.getRepo(repo.id)!), 'queue is empty');
});
