import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-cli-'));

const { repoCommands } = await import('../../src/cli/repos.ts');
const { taskCommands } = await import('../../src/cli/tasks.ts');

test('the old command names still run the renamed commands', () => {
  assert.equal(repoCommands.plan, repoCommands.propose);
  assert.equal(taskCommands.resolve, taskCommands.sync);
});

test('repo plan and repo propose reach the propose command', async () => {
  const ctx = { cmd: 'repo', flags: {}, repoName: () => '', db: {} } as never;
  const original = process.exit;
  const errors: string[] = [];
  const err = console.error;
  console.error = (m: string) => void errors.push(String(m));
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never;
  try {
    for (const sub of ['propose', 'plan']) {
      await assert.rejects(async () => repoCommands.repo({ ...(ctx as object), rest: [sub] } as never), /exit 1/);
    }
  } finally {
    process.exit = original;
    console.error = err;
  }
  assert.deepEqual(errors, ['agentdeck: usage: agentdeck propose <repo>', 'agentdeck: usage: agentdeck propose <repo>']);
});
