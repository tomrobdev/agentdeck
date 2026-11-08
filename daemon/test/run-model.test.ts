// Models: a new task's model from one default (the repo's, else the default_model setting), resolve and unblock runs on
// the support_model setting, the model recorded on every run, and `agentdeck stats --by model` read from those records.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-models-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { addTask, editTask, pilotStats, syncNow, updateRepo, updateSettings } = await import('../src/application/actions.ts');
const { DEFAULT_MODEL, modelSourceText, newTaskModel } = await import('../src/domain/work/index.ts');
const { DEFAULT_SUPPORT_MODEL, runModel } = await import('../src/domain/runs/index.ts');
const { measureByModel } = await import('../src/domain/insights/index.ts');
const { asRepoId, asTaskId, testApp } = await import('./fixtures.ts');
const { fakeCodeHost } = await import('./fakes.ts');

// --- The decisions, pure ---

test('newTaskModel: the model asked for, else the repo’s, else the default_model setting', () => {
  assert.deepEqual(newTaskModel('haiku', { model: 'opus' }, 'sonnet'), { model: 'haiku', source: 'asked' });
  assert.deepEqual(newTaskModel(undefined, { model: 'opus' }, 'sonnet'), { model: 'opus', source: 'repo' });
  assert.deepEqual(newTaskModel('', { model: 'opus' }, 'sonnet'), { model: 'opus', source: 'repo' }, 'empty asks for none');
  assert.deepEqual(newTaskModel(undefined, { model: null }, 'haiku'), { model: 'haiku', source: 'setting' });
  assert.equal(modelSourceText('repo'), "the repo's default");
  assert.equal(modelSourceText('setting'), 'the default_model setting');
  assert.equal(modelSourceText('asked'), null);
});

test('runModel: a work run takes the task’s model, a resolve or unblock run the support model', () => {
  const task = { model: 'opus' };
  assert.equal(runModel('work', task, 'haiku'), 'opus');
  assert.equal(runModel('resolve', task, 'haiku'), 'haiku');
  assert.equal(runModel('unblock', task, 'haiku'), 'haiku');
});

test('measureByModel: a row per recorded model, unknown last, and interventions go to the run before them', () => {
  const run = (task: number, model: string | null, started_at: string, outcome = 'done', task_status = 'done') => ({
    repo_id: asRepoId(1),
    task_id: asTaskId(task),
    attempt: 1,
    outcome,
    started_at,
    ended_at: started_at.replace(':00:', ':10:'),
    cost_usd: 1,
    denials: 0,
    task_status,
    model,
  });
  const retry = (task: number, at: string) => ({
    task_id: asTaskId(task),
    repo_id: asRepoId(1),
    type: 'retry',
    from_status: 'blocked',
    to_status: 'queued',
    reason: 'try the other file',
    at,
  });
  const scorecardTask = (id: number) => ({
    id: asTaskId(id),
    repo_id: asRepoId(1),
    created_at: '2026-10-01 09:00:00',
    auto_merge: null,
    repo_auto_merge: false,
    pr_checks_opened: null,
  });
  const runs = [
    run(1, 'opus', '2026-10-01 10:00:00'),
    run(2, 'sonnet', '2026-10-01 10:00:00', 'blocked', 'blocked'),
    { ...run(2, 'opus', '2026-10-01 12:00:00'), attempt: 2 },
    run(3, null, '2026-10-01 10:00:00'),
  ];
  // The retry with a note came after task 2's sonnet run, before its opus one: it counts against sonnet.
  const rows = measureByModel({ runs, tasks: [1, 2, 3].map(scorecardTask), events: [retry(2, '2026-10-01 11:00:00')] });
  assert.deepEqual(
    rows.map((r) => [r.model, r.measures.runs, r.measures.first_runs, r.measures.first_run_done, r.interventions]),
    [
      ['opus', 2, 1, 1, 0],
      ['sonnet', 1, 1, 0, 1],
      ['unknown', 1, 1, 1, 0],
    ],
  );
  assert.equal(rows[0].measures.cost_per_done_task, 1, 'opus: two runs over two done tasks');
});

test('the defaults are the settings’ defaults', () => {
  assert.equal(DEFAULT_MODEL, 'sonnet');
  assert.equal(DEFAULT_SUPPORT_MODEL, 'sonnet');
});

// --- Through the database, the scheduler, the fake claude and the CLI ---

const db = testApp(openDb(join(home, 'agentdeck.db')), { codeHost: fakeCodeHost() });
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
const lines = (middle: string) => `line one\n${middle}\nline three\n`;
writeFileSync(join(dir, 'shared.txt'), lines('line two'));
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });

const CLI = join(import.meta.dirname, '../src/cli.ts');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_HOME: home, AGENTDECK_TASK_ID: '', AGENTDECK_PLANNER: '' },
  });
/** The --model of each fake claude run whose prompt starts with `start`. */
const modelsStarted = (start: string) =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[])
    .filter((args) => args[args.indexOf('-p') + 1].startsWith(start))
    .map((args) => args[args.indexOf('--model') + 1]);

test('a task added with no model takes its repo’s model, else default_model, and the CLI says which', async () => {
  updateRepo(db, 'demo', { model: 'opus' });
  const fromRepo = await addTask(db, { repo: 'demo', prompt: 'from the repo' });
  assert.equal(fromRepo.model, 'opus');
  assert.equal(fromRepo.model_source, 'repo');

  updateRepo(db, 'demo', { model: null });
  updateSettings(db, { default_model: 'haiku' });
  const fromSetting = await addTask(db, { repo: 'demo', prompt: 'from the setting' });
  assert.equal(fromSetting.model, 'haiku');
  assert.equal(fromSetting.model_source, 'setting');

  const asked = await addTask(db, { repo: 'demo', prompt: 'asked', model: 'opus' });
  assert.equal(asked.model, 'opus');
  assert.equal(asked.model_source, 'asked');

  assert.throws(() => updateRepo(db, 'demo', { model: 'gpt-9' }), /model must be/);
  assert.throws(() => updateSettings(db, { support_model: 'gpt-9' }), /model must be/);
  for (const id of [fromRepo.id, fromSetting.id, asked.id]) db.raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);

  const set = cli('repo', 'set', 'demo', 'model', 'opus');
  assert.equal(set.status, 0, set.stderr);
  const viaRepo = cli('add', 'cli from the repo', '--repo', 'demo', '--propose');
  assert.equal(viaRepo.status, 0, viaRepo.stderr);
  assert.match(viaRepo.stdout, /\(opus: the repo's default, /);

  assert.equal(cli('repo', 'set', 'demo', 'model', '').status, 0);
  const viaSetting = cli('add', 'cli from the setting', '--repo', 'demo', '--propose');
  assert.match(viaSetting.stdout, /\(haiku: the default_model setting, /);

  const viaFlag = cli('add', 'cli asked', '--repo', 'demo', '--model', 'opus', '--propose');
  assert.match(viaFlag.stdout, /\(opus, /, 'a model asked for names no source');
  updateSettings(db, { default_model: 'sonnet' });
});

test('a resolve run of an opus task starts with the support model, and each run row records its model', async () => {
  updateSettings(db, { support_model: 'haiku' });
  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_DONE change line two', model: 'opus' });
  await drain();
  const done = db.getTask(task.id)!;
  assert.equal(done.status, 'done');
  const wt = done.checkout!.worktree!;
  writeFileSync(join(wt, 'shared.txt'), lines('task change'));
  sh(wt, 'commit', '-q', '-am', 'task changes line two');
  writeFileSync(join(dir, 'shared.txt'), lines('main change'));
  sh(dir, 'commit', '-q', '-am', 'main changes line two');

  const r = await syncNow(db, task.id);
  assert.equal(r.outcome, 'resolved');
  assert.deepEqual(modelsStarted('AgentDeck conflict resolution').at(-1), 'haiku', 'the resolve run was started on the support model');

  const [work, resolve] = db.runsForTask(task.id);
  assert.deepEqual([work.kind, work.model, work.model_id], ['work', 'opus', 'claude-opus-5-5']);
  assert.deepEqual([resolve.kind, resolve.model, resolve.model_id], ['resolve', 'haiku', 'claude-haiku-5-5']);
  updateSettings(db, { support_model: 'sonnet' });
});

test('stats --by model: a row per recorded model, unknown for older runs, and an edit leaves a run’s model as it was', async () => {
  const blocked = await addTask(db, { repo: 'demo', prompt: 'FAKE_BLOCKED cannot', model: 'opus', max_attempts: 1 });
  await drain();
  assert.equal(db.getTask(blocked.id)!.status, 'blocked');
  await editTask(db, blocked.id, { model: 'haiku' });
  assert.equal(db.getTask(blocked.id)!.model, 'haiku');
  assert.deepEqual(
    db.runsForTask(blocked.id).map((r) => r.model),
    ['opus'],
    'the run keeps the model it ran on',
  );

  // A run from older code recorded no model.
  const old = db.addTask({ repo_id: db.findRepo('demo')!.id, title: 'old', prompt: 'old', model: 'sonnet' });
  db.finishRun(db.startRun(old.id, 1, join(home, 'old.log')), { outcome: 'done' });

  const report = pilotStats(db, { by: 'model' });
  assert.deepEqual(
    report.models.map((m) => [m.model, m.measures.runs, m.measures.first_run_done]),
    [
      ['opus', 2, 1],
      ['unknown', 1, 1],
    ],
  );
  assert.equal(report.models[0].interventions, 1, 'the edit of the blocked task counts against the model it ran on');
  assert.deepEqual(pilotStats(db).models, [], 'no rows unless asked for');

  const out = cli('stats', '--by', 'model');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^model +tasks +runs +first run done +cost\/done task +min\/done task +interventions$/m);
  assert.match(out.stdout, /^opus +2 +2 /m);
  assert.match(out.stdout, /^unknown +1 +1 /m);
  assert.equal(cli('stats', '--by', 'day').status, 1);
});
