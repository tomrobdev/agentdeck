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

test('only real paths are picked: dotted identifiers, fences, links, line suffixes, created paths', () => {
  assert.deepEqual(pathsNamedIn('Read `task.prompt` and `permissions.allow`, then `package.json`.'), ['package.json']);
  assert.deepEqual(pathsNamedIn('Run:\n```\ncat src/in-fence.ts\n```\nthen see src/after.ts'), ['src/after.ts']);
  assert.deepEqual(pathsNamedIn('See [the plan](docs/plans/x.html#L12) and [web](https://example.com/a/b.md).'), ['docs/plans/x.html']);
  assert.deepEqual(pathsNamedIn('Edit src/a.ts:12:5 and `src/b.ts#L3-L9`.'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(pathsNamedIn('Create `src/new.ts`. Then test `src/new.ts` in src/new.test.ts.'), ['src/new.test.ts']);
  assert.deepEqual(pathsNamedIn('Add `src/a.ts` and `src/b.ts`, `src/c.ts`. Use src/b.ts.'), []);
  assert.deepEqual(pathsNamedIn('Extract the parser into `src/parse.ts` and move helpers to `src/h.ts`; keep src/old.ts.'), ['src/old.ts']);
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

test('a path that exists only under a subfolder gets the write-it-in-full note', async () => {
  const { db, path } = setup();
  mkdirSync(join(path, 'daemon/src/db'), { recursive: true });
  writeFileSync(join(path, 'daemon/src/db/schema.ts'), 'x');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'schema');
  const t = await addTask(db, { repo: 'demo', prompt: 'Edit `db/schema.ts`, `db/`, and `daemon/src/db/schema.ts`, and docs/nope.md' });
  assert.deepEqual(await promptWarnings(db, t.id), [
    'the prompt names db/schema.ts: found as daemon/src/db/schema.ts; write it in full',
    'the prompt names db/: found as daemon/src/db/; write it in full',
    "the prompt names docs/nope.md, which isn't on main and no task it builds on adds it",
  ]);
});

test('paths are checked against origin/<base>, where a worker starts: a local-only file warns', async () => {
  const { db, path } = setup();
  const origin = mkdtempSync(join(tmpdir(), 'agentdeck-promptpaths-origin-'));
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(path, 'remote', 'add', 'origin', origin);
  git(path, 'push', '-q', 'origin', 'main');
  git(path, 'fetch', '-q', 'origin');
  writeFileSync(join(path, 'docs/local.md'), 'x');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'local only');
  const t = await addTask(db, { repo: 'demo', prompt: 'Follow docs/local.md and docs/committed.md' });
  assert.deepEqual(await promptWarnings(db, t.id), [
    "the prompt names docs/local.md, which isn't on origin/main and no task it builds on adds it",
  ]);
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
