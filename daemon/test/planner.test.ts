// Planner and always-on pieces: real SQLite and git, fake claude.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-planner-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const actions = await import('../src/application/actions.ts');
const { plannerDue } = await import('../src/application/planner.ts');
const { buildPlannerPrompt } = await import('../src/domain/planner/proposals.ts');
const { renderPlist, servicePath, LABEL } = await import('../src/adapters/service.ts');

const db = openDb(join(home, 'test.db'));

function makeRepo(name: string) {
  const path = join(home, name);
  mkdirSync(path);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: path });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(path, 'README.md'), name);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return path;
}

let repoId = 0;
before(async () => {
  repoId = (await actions.addRepo(db, { path: makeRepo('alpha') })).id;
});
after(() => db.close());

test('planner is due only with goals, an empty queue, and after the interval', () => {
  let repo = db.getRepo(repoId)!;
  assert.equal(plannerDue(db, repo), null, 'no goals yet');

  actions.updateRepo(db, repoId, { goals: '# Goals\n- greet people' });
  repo = db.getRepo(repoId)!;
  assert.equal(plannerDue(db, repo), 'queue is empty');

  const t = db.addTask({ repo_id: repoId, title: 'busy', prompt: 'x' });
  assert.equal(plannerDue(db, repo), null, 'open work exists');
  db.applyEvent(t.id, { type: 'cancel' });

  db.updateRepo(repoId, { planned_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  assert.equal(plannerDue(db, db.getRepo(repoId)!), null, 'planned recently');
  db.updateRepo(repoId, { planned_at: null });
});

test('proposing tasks yields capped, de-duplicated tasks that wait for approval', async () => {
  const prior = db.addTask({ repo_id: repoId, title: 'Add a greeting helper!', prompt: 'already done' });
  db.applyEvent(prior.id, { type: 'claim' });
  db.applyEvent(prior.id, { type: 'finish', outcome: 'done' });
  actions.updateSettings(db, { planner: { max_tasks: 2 } });

  const res = await actions.proposeNow(db, 'alpha');
  assert.equal(res.outcome, 'proposed');
  assert.deepEqual(
    res.tasks.map((t) => t.title),
    ['Document the CLI', 'Add input validation'],
  );
  assert.deepEqual(res.skipped, ['Add a greeting helper', 'Tidy the README']);
  assert.ok(res.tasks.every((t) => t.status === 'proposed' && t.source === 'planner'));

  const [run] = db.plannerRuns(repoId);
  assert.equal(run.outcome, 'proposed');
  assert.equal(run.proposed, 2);
  assert.equal(run.note, 'looked at src/');
  assert.ok(db.getRepo(repoId)!.planned_at);
  assert.equal(db.recentNotifications(1)[0].kind, 'proposed');

  // The scheduler never picks up proposals.
  assert.equal(db.claimNextTask(), undefined);
});

test('approve queues a proposal, reject cancels it, neither works twice', () => {
  const [a, b] = db.listTasks().filter((t) => t.status === 'proposed');
  actions.approveTask(db, a.id);
  actions.rejectTask(db, b.id);
  assert.equal(db.getTask(a.id)!.status, 'queued');
  assert.equal(db.getTask(b.id)!.status, 'cancelled');
  assert.throws(() => actions.approveTask(db, a.id), /not a proposal/);
  db.applyEvent(a.id, { type: 'cancel' });
});

test('an empty plan is recorded as nothing', async () => {
  actions.updateRepo(db, repoId, { goals: 'FAKE_PLAN_EMPTY' });
  const res = await actions.proposeNow(db, repoId);
  assert.equal(res.outcome, 'nothing');
  assert.equal(res.note, 'goals already met');
  assert.equal(db.plannerRuns(repoId)[0].outcome, 'nothing');
});

test('prompt lists open and recent tasks', () => {
  const repo = db.getRepo(repoId)!;
  const prompt = buildPlannerPrompt(repo, 'ship it', db.tasksForRepo(repoId), 3);
  assert.match(prompt, /at most 3 new tasks/);
  assert.match(prompt, /## Recently finished\n.*Add input validation/s);
});

test('with auto-approve, the scheduler plans an empty queue and runs the tasks', async () => {
  const repoB = await actions.addRepo(db, { path: makeRepo('beta'), test: 'test -f fake-output.txt' });
  actions.updateRepo(db, repoB.id, { goals: 'make greetings', auto_approve: true });
  actions.updateSettings(db, { planner: { max_tasks: 1 } });

  await new Scheduler(db, { once: true, autoPlan: true, tickMs: 50, log: () => {} }).run();

  const tasks = db.tasksForRepo(repoB.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].source, 'planner');
  assert.equal(tasks[0].model, 'haiku');
  assert.equal(tasks[0].status, 'done');
});

test('old databases gain the new columns', () => {
  const path = join(home, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE repos (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE,
    base_branch TEXT NOT NULL DEFAULT 'main', test_cmd TEXT, allowed_tools TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO repos (name, path) VALUES ('legacy', '/tmp/legacy');`);
  old.close();
  const migrated = openDb(path);
  assert.equal(migrated.findRepo('legacy')!.auto_approve, 0);
  migrated.close();
});

test('launchd plist runs this daemon with a usable PATH', () => {
  const plist = renderPlist();
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /src\/cli\.ts<\/string>\s*<string>daemon<\/string>/);
  assert.ok(servicePath().split(':').includes('/opt/homebrew/bin'));
  assert.match(plist, new RegExp(`<key>AGENTDECK_HOME</key><string>${home}</string>`), 'custom home is passed through');
});
