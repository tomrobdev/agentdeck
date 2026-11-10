// Planner and always-on pieces: real SQLite and git, fake claude.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { asRepoId } from '../fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-planner-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../fixtures/open-db.ts');
const { Scheduler } = await import('../../src/application/scheduler/scheduler.ts');
const actions = await import('../../src/application/actions.ts');
const { plannerDue } = await import('../../src/application/proposals/planner.ts');
const { buildPlannerPrompt } = await import('../../src/domain/proposals/proposals.ts');
const { renderPlist, servicePath, LABEL } = await import('../../src/adapters/macos/service.ts');

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

let repoId = asRepoId(0);
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

  db.updateRepo(repoId, { proposed_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  assert.equal(plannerDue(db, db.getRepo(repoId)!), null, 'planned recently');
  db.updateRepo(repoId, { proposed_at: null });
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
  assert.ok(db.getRepo(repoId)!.proposed_at);
  assert.equal(db.recentNotifications(1)[0].kind, 'proposed');

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

test('a planner run that throws still ends its row', async () => {
  actions.updateRepo(db, repoId, { goals: 'FAKE_PLAN_EMPTY' });
  const real = db.tasksForRepo;
  db.tasksForRepo = () => {
    throw new Error('boom');
  };
  try {
    await assert.rejects(actions.proposeNow(db, repoId), /boom/);
  } finally {
    db.tasksForRepo = real;
  }
  const [run] = db.plannerRuns(repoId);
  assert.equal(run.outcome, 'failed');
  assert.ok(run.ended_at);
  assert.match(run.note ?? '', /boom/);
  assert.equal(db.countRunningPlannerRuns(), 0);
});

test('repo names that escape the goals folder or read as an id are refused', async () => {
  for (const name of ['../x', 'a/b', '5', '.hidden', '-x']) {
    await assert.rejects(actions.addRepo(db, { path: makeRepo(`n${Math.random().toString(36).slice(2)}`), name }), /repo name/);
  }
  const five = db.addRepo({ name: 'five', path: '/tmp/five', base_branch: 'main' });
  assert.equal(db.findRepo(String(five.id))?.id, five.id);
  assert.equal(db.findRepo(`0x${five.id.toString(16)}`), undefined);
  assert.equal(db.findRepo(`${five.id}e0`), undefined);
});

test('prompt lists open and recent tasks', () => {
  const repo = db.getRepo(repoId)!;
  const prompt = buildPlannerPrompt(repo, 'ship it', db.tasksForRepo(repoId), 3);
  assert.match(prompt, /at most 3 new tasks/);
  assert.match(prompt, /## Recently finished\n.*Add input validation/s);
});

test('the planner asks for prompts with markdown section headings, shown below its own headings', () => {
  const prompt = buildPlannerPrompt(db.getRepo(repoId)!, 'ship it', [], 3);
  for (const name of ['Goal', 'Context', 'Change', 'Out of scope', 'Constraints', 'Definition of done']) {
    assert.match(prompt, new RegExp(`^### ${name}$`, 'm'));
    assert.doesNotMatch(prompt, new RegExp(`^## ${name}$`, 'm'));
  }
  assert.match(prompt, /^## Goals$/m);
  assert.match(prompt, /"##" heading/);
  assert.doesNotMatch(prompt, /^Goal:/m);
  assert.doesNotMatch(prompt, /--plan/, 'the planner proposes no plans');
});

test('with auto-approve, the scheduler plans an empty queue and runs the tasks', async () => {
  const repoB = await actions.addRepo(db, { path: makeRepo('beta'), test: 'test -f fake-output.txt' });
  actions.updateRepo(db, repoB.id, { goals: 'make greetings', auto_approve: true });
  actions.updateSettings(db, { planner: { max_tasks: 1 } });

  await new Scheduler(db, { once: true, autoPropose: true, tickMs: 50, log: () => {} }).run();

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
  assert.equal(migrated.findRepo('legacy')!.auto_approve, false);
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

test("the plist carries the installing shell's SDKROOT and DEVELOPER_DIR, and leaves out unset ones", () => {
  const saved = { SDKROOT: process.env.SDKROOT, DEVELOPER_DIR: process.env.DEVELOPER_DIR };
  try {
    process.env.SDKROOT = '/sdks/MacOSX26.5.sdk';
    delete process.env.DEVELOPER_DIR;
    const plist = renderPlist();
    assert.match(plist, /<key>SDKROOT<\/key><string>\/sdks\/MacOSX26\.5\.sdk<\/string>/);
    assert.doesNotMatch(plist, /DEVELOPER_DIR/);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
