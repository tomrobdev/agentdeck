// Workers state what they need on the STATUS line; a block the environment caused gives the attempt back.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-needs-'));

const { openDb } = await import('../src/db/index.ts');
const { isEnvironmentBlock, parseStatus, readNeeds } = await import('../src/domain/run/run.ts');
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
  const needs = JSON.stringify({ kind: 'deps', items: ['left-pad'] });
  const after = db.applyEvent(t.id, { type: 'finish', outcome: 'blocked', environment }, { reason: 'NEEDS deps: left-pad', needs })!;
  return { db, id: t.id, after };
}

test('an environment block gives the attempt back and records the needs', () => {
  const { db, id, after } = blockedTask(true);
  assert.equal(after.status, 'blocked');
  assert.equal(after.attempts, 0);
  assert.deepEqual(readNeeds(after.needs), { kind: 'deps', items: ['left-pad'] });
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
