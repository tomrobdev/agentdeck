// A task's model must be one claude accepts; a repo's unreadable tool rules allow nothing.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-model-'));

const { openDb } = await import('../../fixtures/open-db.ts');
const { addTask, editTask } = await import('../../../src/application/work/tasks.ts');
const { isModel } = await import('../../../src/domain/work/task/task.ts');
const { allowedTools } = await import('../../../src/domain/repos/tools.ts');

test('a model is an alias or a full claude model id', () => {
  for (const m of ['haiku', 'sonnet', 'opus', 'claude-sonnet-5-5', 'claude-3.5-haiku']) assert.ok(isModel(m), m);
  for (const m of ['sonet', 'gpt-4', 'claude-', 'Claude-Opus', 'opus --dangerously']) assert.ok(!isModel(m), m);
});

test('adding or editing a task refuses a model claude would reject', async () => {
  const db = openDb(':memory:');
  db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  await assert.rejects(addTask(db, { prompt: 'do it', model: 'sonet' }), /model must be haiku, sonnet, opus/);
  const t = await addTask(db, { prompt: 'do it', model: 'opus' });
  assert.equal(t.model, 'opus');
  await assert.rejects(editTask(db, t.id, { model: 'gpt-4' }), /model must be/);
  assert.equal((await editTask(db, t.id, { model: 'claude-sonnet-5-5' })).model, 'claude-sonnet-5-5');
});

test("a repo's own tool rules replace the defaults", () => {
  const root = { files: ['package.json'], scripts: ['test'] };
  assert.deepEqual(allowedTools({ allowed_tools: ['Read', 'Bash(make*)'], toolchain: null }, root), ['Read', 'Bash(make*)']);
  assert.deepEqual(allowedTools({ allowed_tools: [], toolchain: null }, root), []);
});
