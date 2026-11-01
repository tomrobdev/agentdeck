// Paths a prompt names that aren't on the base branch: picking them out, and warning when no task it builds on adds them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-promptpaths-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { addTask, editTask, promptWarnings } = await import('../src/application/actions.ts');
const { pathsNamedIn } = await import('../src/domain/task/prompt-paths.ts');

test('paths in backticks and bare paths are picked, once each', () => {
  assert.deepEqual(pathsNamedIn('Follow `docs/plans/ink-rebrand.html` and read src/domain/ first. See `package.json`.'), [
    'docs/plans/ink-rebrand.html',
    'src/domain/',
    'package.json',
  ]);
  assert.deepEqual(pathsNamedIn('Edit daemon/src/db/tasks.ts:120-140, then daemon/src/db/tasks.ts again (./docs/a.md).'), [
    'daemon/src/db/tasks.ts',
    'docs/a.md',
  ]);
});

test('URLs, globs, absolute paths, plain words and code are ignored', () => {
  assert.deepEqual(
    pathsNamedIn(
      'See https://example.com/docs/a.md and `src/**/*.ts`, /etc/hosts, ~/notes.md, ../up/x.ts, Node.js, e.g. this, and/or that, `git commit -m x`, `foo.bar()`.',
    ),
    [],
  );
});

test('paths the prompt says to create are ignored', () => {
  assert.deepEqual(pathsNamedIn('Create docs/new.md and add `src/new.ts`. Create a new file called `src/other.ts`.'), []);
  assert.deepEqual(pathsNamedIn('Write a new `docs/x.html`, following docs/plan.html.'), ['docs/plan.html']);
  assert.deepEqual(pathsNamedIn('Add tests in src/a.ts'), ['src/a.ts']);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'agentdeck-promptpaths-repo-'));
  git(path, 'init', '-q', '-b', 'main');
  mkdirSync(join(path, 'docs'));
  writeFileSync(join(path, 'docs/committed.md'), 'x');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'init');
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path, base_branch: 'main' });
  return { db, repo, path };
}

test('a prompt naming an uncommitted file warns, on add and on edit; a committed one does not', async () => {
  const { db, path } = setup();
  writeFileSync(join(path, 'docs/dirty.md'), 'not committed');
  const t = await addTask(db, { repo: 'demo', prompt: 'Follow `docs/dirty.md`, and docs/committed.md, and docs/' });
  assert.deepEqual(await promptWarnings(db, t.id), [
    "the prompt names docs/dirty.md, which isn't on main and no task it builds on adds it",
  ]);
  await editTask(db, t.id, { prompt: 'Follow docs/committed.md' });
  assert.deepEqual(await promptWarnings(db, t.id), []);
  await editTask(db, t.id, { prompt: 'Follow docs/missing.md' });
  assert.equal((await promptWarnings(db, t.id)).length, 1);
});

test('a path a builds-on task adds is not a warning; a builds-on task with no branch yet may add it', async () => {
  const { db, repo, path } = setup();
  const dep = db.addTask({ repo_id: repo.id, title: 'mark', prompt: 'make the mark' });
  const later = await addTask(db, { repo: 'demo', prompt: 'Use `assets/mark.svg`', builds_on: [dep.id] });

  const unbranched = await promptWarnings(db, later.id);
  assert.deepEqual(unbranched, [
    `the prompt names assets/mark.svg, which isn't on main; #${dep.id}, which it builds on, has no branch yet and may add it`,
  ]);

  git(path, 'branch', `agentdeck/task-${dep.id}`);
  db.setCheckout(dep.id, { branch: `agentdeck/task-${dep.id}` });
  assert.equal((await promptWarnings(db, later.id)).length, 1, 'a branch that lacks the file does not cover it');
  assert.match((await promptWarnings(db, later.id))[0], /and no task it builds on adds it$/);

  git(path, 'checkout', '-q', `agentdeck/task-${dep.id}`);
  mkdirSync(join(path, 'assets'));
  writeFileSync(join(path, 'assets/mark.svg'), '<svg/>');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'mark');
  git(path, 'checkout', '-q', 'main');
  assert.deepEqual(await promptWarnings(db, later.id), []);

  const after = await addTask(db, { repo: 'demo', prompt: 'Use `assets/mark.svg`', after: [dep.id] });
  assert.equal((await promptWarnings(db, after.id)).length, 1, 'only builds-on links count');
});
