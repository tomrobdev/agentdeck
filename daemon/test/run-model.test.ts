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
const { DEFAULT_REVIEW_MODEL, DEFAULT_SUPPORT_MODEL, runModel } = await import('../src/domain/runs/index.ts');
const { measureByModel } = await import('../src/domain/insights/index.ts');
const { UNKNOWN_MODEL, interventionModel } = await import('../src/domain/insights/by-model.ts');
const { repoCommands } = await import('../src/cli/repos/repos.ts');
const { statsCommands } = await import('../src/cli/insights/stats.ts');
const { taskCommands } = await import('../src/cli/work/tasks.ts');
const { daemonCommands } = await import('../src/cli/operations/daemon.ts');
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

test('runModel: a work run takes the task’s model, a resolve or unblock run the support model, a review run the review model', () => {
  const task = { model: 'sonnet' };
  const models = { support_model: 'haiku', review_model: 'opus' };
  assert.equal(runModel('work', task, models), 'sonnet');
  assert.equal(runModel('resolve', task, models), 'haiku');
  assert.equal(runModel('unblock', task, models), 'haiku');
  assert.equal(runModel('review', task, models), 'opus');
  assert.equal(DEFAULT_REVIEW_MODEL, 'opus', 'a reviewer at least as strong as the worker');
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

  // Since 11:00: only runs begun then count, an intervention goes to the older run before it, and a person's event that
  // is no intervention (a plain retry) leaves no row for a model with no runs since.
  const since = measureByModel({
    runs,
    tasks: [1, 2, 3].map(scorecardTask),
    events: [
      { ...retry(2, '2026-10-01 09:30:00'), reason: 'before since' },
      retry(2, '2026-10-01 11:00:00'),
      { ...retry(3, '2026-10-01 11:30:00'), reason: null },
    ],
    since: '2026-10-01 11:00:00',
  });
  assert.deepEqual(
    since.map((r) => [r.model, r.measures.runs, r.interventions]),
    [
      ['opus', 1, 0],
      ['sonnet', 0, 1],
    ],
    'sonnet ran before since, and task 3’s plain retry is no intervention, so unknown has no row',
  );
});

test('interventionModel: the run before the event, else the task’s first, else unknown', () => {
  const at = (started_at: string, model: string | null) => ({ started_at, model }) as never;
  const e = { at: '2026-10-01 10:00:00' } as never;
  assert.equal(interventionModel(e, [at('2026-10-01 09:00:00', 'opus'), at('2026-10-01 11:00:00', 'haiku')]), 'opus');
  assert.equal(interventionModel(e, [at('2026-10-01 11:00:00', 'haiku')]), 'haiku', 'an edit before any run');
  assert.equal(interventionModel(e, [at('2026-10-01 09:00:00', null)]), UNKNOWN_MODEL);
  assert.equal(interventionModel(e, []), UNKNOWN_MODEL);
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
  const logged = readFileSync(join(home, 'fake-claude-args.log'), 'utf8').trim().split('\n');
  assert.ok(
    logged.every((l) => (JSON.parse(l) as string[]).includes('--strict-mcp-config')),
    'every run on the fake claude passes --strict-mcp-config',
  );

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

/** Runs a CLI command in this process, with what it prints, and `exit <code>` thrown where it would exit. */
async function inProcess(command: (ctx: never) => void | Promise<void>, rest: string[], flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  const { log, error } = console;
  const exit = process.exit;
  console.log = (m: unknown) => void out.push(String(m));
  console.error = (m: unknown) => void out.push(String(m));
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never;
  try {
    const repoName = (id: number) => db.listRepos().find((r) => r.id === id)?.name ?? '?';
    await command({ db, cmd: 'test', rest, flags, repoName } as never);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  return out.join('\n');
}

test('in process: repo set model, add names where its model came from, settings shows the two models, stats --by model', async () => {
  assert.equal(await inProcess(repoCommands.repo, ['set', 'demo', 'model', 'opus']), 'demo: model opus');
  assert.match(await inProcess(repoCommands.repo, ['ls']), /model=opus/);
  const fromRepo = await inProcess(taskCommands.add, ['in process from the repo'], { repo: 'demo', propose: true });
  assert.match(fromRepo, /\(opus: the repo's default, /);

  assert.equal(await inProcess(repoCommands.repo, ['set', 'demo', 'model', '']), 'demo: model (none)');
  assert.match(await inProcess(repoCommands.repo, ['ls']), /model=- /);
  assert.equal(await inProcess(daemonCommands.set, ['default_model', 'haiku']), 'default_model = haiku');
  assert.match(
    await inProcess(taskCommands.add, ['in process from the setting'], { repo: 'demo', propose: true }),
    /\(haiku: the default_model setting, /,
  );
  assert.match(await inProcess(taskCommands.add, ['in process asked'], { repo: 'demo', model: 'opus', propose: true }), /\(opus, /);

  assert.equal(await inProcess(daemonCommands.set, ['support_model', 'opus']), 'support_model = opus');
  const settings = await inProcess(daemonCommands.settings, []);
  assert.match(settings, /^default_model {3}haiku$/m);
  assert.match(settings, /^support_model {3}opus \(resolve and unblock runs\)$/m);
  assert.match(settings, /^governor {8}/m);
  updateSettings(db, { default_model: 'sonnet', support_model: 'sonnet' });

  const table = await inProcess(statsCommands.stats, [], { by: 'model' });
  assert.match(table, /^model +tasks +runs /m);
  assert.match(table, /^opus +2 +2 /m);
  const json = JSON.parse(await inProcess(statsCommands.stats, [], { by: 'model', json: true })) as { models: { model: string }[] };
  assert.deepEqual(
    json.models.map((m) => m.model),
    ['opus', 'unknown'],
  );
  assert.doesNotMatch(await inProcess(statsCommands.stats, [], { since: '2026-10-01' }), /^model /m, 'no model table unless asked for');
  await assert.rejects(inProcess(statsCommands.stats, [], { by: 'day' }), /exit 1/);
  await assert.rejects(inProcess(statsCommands.stats, [], { since: 'last tuesday' }), /exit 1/);
});
