// Workers state what they need on the STATUS line; a block the environment caused gives the attempt back.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-needs-'));

const { openDb } = await import('../src/db/index.ts');
const { isEnvironmentBlock, parseStatus } = await import('../src/domain/run/run.ts');
const { canInstallWith, depsRequest, depsRequestError, installArgs } = await import('../src/domain/task/needs.ts');
const { branchName } = await import('../src/domain/branch/branch.ts');
const { workerSystemPrompt } = await import('../src/domain/run/prompt.ts');

test('each NEEDS form parses', () => {
  assert.deepEqual(parseStatus('x\nSTATUS: BLOCKED: NEEDS deps: tailwindcss @tailwindcss/vite').needs, {
    kind: 'deps',
    items: ['tailwindcss', '@tailwindcss/vite'],
  });
  assert.deepEqual(parseStatus('STATUS: BLOCKED: NEEDS host: registry.example.com').needs, {
    kind: 'host',
    items: ['registry.example.com'],
  });
  assert.deepEqual(parseStatus('STATUS: BLOCKED: NEEDS edit: .claude/skills/x/SKILL.md').needs, {
    kind: 'edit',
    items: ['.claude/skills/x/SKILL.md'],
  });
});

test('a plain BLOCKED reason has no needs', () => {
  const s = parseStatus('STATUS: BLOCKED: need creds');
  assert.equal(s.needs, undefined);
  assert.equal(s.reason, 'need creds');
  assert.equal(parseStatus('STATUS: BLOCKED: NEEDS something').needs, undefined);
  assert.equal(parseStatus('STATUS: DONE').needs, undefined);
});

test('depsRequest splits the --dev flag from the packages', () => {
  assert.deepEqual(depsRequest(['tailwindcss', '@tailwindcss/vite', 'left-pad@1.3.0', '--dev']), {
    packages: ['tailwindcss', '@tailwindcss/vite', 'left-pad@1.3.0'],
    dev: true,
  });
  assert.deepEqual(depsRequest(['-D', 'x']), { packages: ['x'], dev: true });
  assert.deepEqual(depsRequest(['x']), { packages: ['x'], dev: false });
});

test('depsRequestError refuses no packages and anything that is not a package spec', () => {
  assert.equal(depsRequestError(['tailwindcss', '@tailwindcss/vite', 'left-pad@1.3.0', '--dev']), null);
  assert.equal(depsRequestError([]), 'the request names no packages');
  assert.equal(depsRequestError(['--dev']), 'the request names no packages');
  for (const bad of ['a;rm', '$(id)', 'x|y', '-g', 'a b`c`', '../evil', 'a&&b']) {
    assert.equal(depsRequestError(['ok', bad]), `not a valid package name: ${bad}`, bad);
  }
});

test('installArgs: npm installs, pnpm and yarn add', () => {
  assert.deepEqual(installArgs('npm', ['a', 'b'], false), ['install', '--save', 'a', 'b']);
  assert.deepEqual(installArgs('npm', ['a'], true), ['install', '--save-dev', 'a']);
  assert.deepEqual(installArgs('pnpm', ['a'], true), ['add', '-D', 'a']);
  assert.deepEqual(installArgs('yarn', ['a'], false), ['add', 'a']);
});

test('canInstallWith: the JS package managers only', () => {
  assert.equal(canInstallWith('pnpm'), true);
  assert.equal(canInstallWith('cargo'), false);
  assert.equal(canInstallWith(null), false);
});

test('branchName: the task’s own branch, else the one the daemon will give it', () => {
  assert.equal(branchName({ id: 7, checkout: null }), 'agentdeck/task-7');
  assert.equal(branchName({ id: 7, checkout: { branch: 'feature/x' } }), 'feature/x');
});

test('the worker prompt describes the NEEDS forms', () => {
  assert.match(workerSystemPrompt(null), /NEEDS deps/);
});

test('isEnvironmentBlock: needs, denials or a setup failure', () => {
  assert.equal(isEnvironmentBlock({ needs: { kind: 'host', items: ['h'] } }), true);
  assert.equal(isEnvironmentBlock({ denials: 2 }), true);
  assert.equal(isEnvironmentBlock({ setupFailed: true }), true);
  assert.equal(isEnvironmentBlock({ denials: 0 }), false);
});

function blockedTask(environment: boolean) {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  db.claimNextTask();
  assert.equal(db.getTask(t.id)!.attempts, 1);
  const needs = { kind: 'deps' as const, items: ['left-pad'] };
  const after = db.applyEvent(t.id, { type: 'finish', outcome: 'blocked', environment }, { reason: 'NEEDS deps: left-pad', needs })!;
  return { db, id: t.id, after };
}

test('stored needs, question and plan steps are read in the mapper; malformed JSON reads as null', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r-mapper', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const store = (needs: string | null, question: string | null, plan_steps: string | null) =>
    db.raw
      .prepare('UPDATE tasks SET needs = ?, question = ?, plan_steps = ?, plan_task = ? WHERE id = ?')
      .run(needs, question, plan_steps, t.id, t.id);

  store('{"kind":"deps","items":["zod"]}', '{"question":"Which?","options":["a",1]}', '["a",2,"b"]');
  const read = db.getTask(t.id)!;
  assert.deepEqual(read.needs, { kind: 'deps', items: ['zod'] });
  assert.deepEqual(read.question, { question: 'Which?', options: ['a', '1'] });
  assert.deepEqual(read.plan, { task: t.id, steps: ['a', 'b'] });

  for (const bad of ['not json', '{"kind":"nope","items":[]}', '{"kind":"deps"}', '42', '']) {
    store(bad, bad, bad);
    const task = db.getTask(t.id)!;
    assert.deepEqual([task.needs, task.question, task.plan?.steps], [null, null, null], bad);
  }
  store(null, null, null);
  assert.deepEqual([db.getTask(t.id)!.needs, db.getTask(t.id)!.question, db.getTask(t.id)!.plan?.steps], [null, null, null]);

  db.raw.prepare('UPDATE tasks SET auto_merge = ? WHERE id = ?').run(1, t.id);
  assert.equal(db.getTask(t.id)!.auto_merge, true);
  db.raw.prepare('UPDATE tasks SET auto_merge = ? WHERE id = ?').run(0, t.id);
  assert.equal(db.getTask(t.id)!.auto_merge, false);
  db.close();
});

test('an environment block gives the attempt back and records the needs', () => {
  const { db, id, after } = blockedTask(true);
  assert.equal(after.status, 'blocked');
  assert.equal(after.attempts, 0);
  assert.deepEqual(after.needs, { kind: 'deps', items: ['left-pad'] });
  assert.equal(db.eventsForTask(id).at(-1)!.type, 'environment_block');
  // Queued again: the needs are cleared.
  assert.equal(db.applyEvent(id, { type: 'retry' })!.needs, null);
  db.close();
});

test('a task-caused block uses its attempt', () => {
  const { db, id, after } = blockedTask(false);
  assert.equal(after.attempts, 1);
  assert.equal(db.eventsForTask(id).at(-1)!.type, 'finish');
  db.close();
});
