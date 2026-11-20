// A run whose worker crashes, and whose settle then crashes too, logs both and still frees its slot.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-start-runs-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { startReview, startUnblock, startWork } = await import('#application/scheduler/start-runs.ts');
const { brokenApp, testApp } = await import('#test/fixtures/fixtures.ts');

test('a worker that crashes on a closed database logs the crash, then the settle that crashed after it, and still ends', async () => {
  const db = testApp(openDb(join(home, 'crash.db')));
  const dir = join(home, 'demo');
  mkdirSync(dir, { recursive: true });
  const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });
  const added = db.addTask({ repo_id: repo.id, title: 'crashes', prompt: 'never runs' });
  const task = db.getTask(added.id);
  assert.ok(task);
  db.close();
  const lines: string[] = [];
  let ended = false;
  await startWork(
    db,
    task,
    (m) => lines.push(m),
    () => (ended = true),
  );
  assert.ok(ended, 'the slot is freed');
  assert.ok(
    lines.some((l) => l.startsWith(`task ${task.id}: worker crashed:`)),
    lines.join('\n'),
  );
  assert.ok(
    lines.some((l) => l.startsWith(`task ${task.id}: settling crashed:`)),
    lines.join('\n'),
  );
});

type WorkTask = Parameters<typeof startWork>[1];
type UnblockTask = Parameters<typeof startUnblock>[1];
type ReviewTarget = Parameters<typeof startReview>[1];
const gone = brokenApp('the app is gone');
const task = { id: 7, title: 'crashes', attempts: 1 } as unknown as WorkTask;

test('a crash that throws no Error is logged as the value thrown, for work, its settle, unblock and review runs', async () => {
  const lines: string[] = [];
  let ended = 0;
  const log = (m: string) => lines.push(m);
  const done = () => ended++;
  await startWork(gone, task, log, done);
  await startUnblock(gone, task as unknown as UnblockTask, log, done);
  await startReview(gone, { task } as unknown as ReviewTarget, log, done);
  assert.equal(ended, 3, 'every run frees its slot');
  for (const line of [
    'task 7: worker crashed: the app is gone',
    'task 7: settling crashed: the app is gone',
    'task 7: unblock run crashed: the app is gone',
    'task 7: review run crashed: the app is gone',
  ])
    assert.ok(lines.includes(line), `${line}\n in:\n${lines.join('\n')}`);
});
