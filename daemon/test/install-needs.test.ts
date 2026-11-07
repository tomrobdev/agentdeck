// Installing the packages a blocked task asked for, on a person's request, with a fake package manager.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-install-'));
process.env.AGENTDECK_HOME = home;

// A fake `pnpm`: records its arguments, adds them to package.json, writes a lockfile and a stray file.
const bin = join(home, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'pnpm'),
  `#!/bin/sh
echo "$@" > "$PWD/pm-args.txt"
if [ -n "$FAKE_PM_FAIL" ]; then echo "ERR_PNPM_FETCH_404 not found" >&2; exit 1; fi
echo '{"name":"demo","dependencies":{"added":"1.0.0"}}' > package.json
echo 'lockfileVersion: 9' > pnpm-lock.yaml
echo junk > stray.txt
`,
);
chmodSync(join(bin, 'pnpm'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { openDb } = await import('../src/db/index.ts');
const { ensureWorktree } = await import('../src/adapters/git.ts');
const { installNeeds } = await import('../src/application/actions.ts');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dir = join(home, 'demo');
mkdirSync(dir);
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', toolchain: 'pnpm' });

/** A task blocked asking for `items`, with a worktree. */
async function blockedFor(items: string[], kind: 'deps' | 'host' | 'edit' = 'deps') {
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const { branch, path } = await ensureWorktree(repo, t);
  db.setCheckout(t.id, { branch, worktree: path });
  db.claimNextTask();
  db.applyEvent(t.id, { type: 'finish', outcome: 'blocked', environment: true }, { reason: 'NEEDS', needs: { kind, items } });
  return { id: t.id, path };
}

test('names are validated: a shell metacharacter is refused', async () => {
  const { id, path } = await blockedFor(['left-pad', 'x;touch pwned']);
  await assert.rejects(installNeeds(db, id), /not a valid package name/);
  assert.equal(db.getTask(id)!.status, 'blocked');
  assert.throws(() => readFileSync(join(path, 'pm-args.txt')), 'the package manager was never run');
});

test('installs, commits only the manifest and lockfile, and queues the task with a note', async () => {
  const { id, path } = await blockedFor(['added', '--dev']);
  const out = await installNeeds(db, id);
  assert.deepEqual(out, { packages: ['added'], dev: true });
  assert.equal(readFileSync(join(path, 'pm-args.txt'), 'utf8').trim(), 'add -D added');
  assert.deepEqual(sh(path, 'show', '--name-only', '--format=%s', 'HEAD').split('\n'), [
    `agentdeck: add added for task #${id}`,
    '',
    'package.json',
    'pnpm-lock.yaml',
  ]);
  assert.match(sh(path, 'status', '--porcelain'), /stray\.txt/, 'other files are left uncommitted');
  const t = db.getTask(id)!;
  assert.equal(t.status, 'queued');
  assert.equal(t.needs, null);
  assert.match(db.eventsForTask(id).at(-1)!.reason ?? '', /installed added/);
  db.applyEvent(id, { type: 'cancel' }); // so a later claimNextTask finds only its own task
});

test('a failed install keeps the task blocked and says why', async () => {
  const { id } = await blockedFor(['added']);
  process.env.FAKE_PM_FAIL = '1';
  try {
    await assert.rejects(installNeeds(db, id), /failed: ERR_PNPM_FETCH_404/);
  } finally {
    delete process.env.FAKE_PM_FAIL;
  }
  assert.equal(db.getTask(id)!.status, 'blocked');
});

test('a task cancelled while its install runs stays cancelled, and the person is told', async () => {
  const { id } = await blockedFor(['added']);
  // installNeeds runs up to the package manager synchronously, so this cancel lands while the install runs.
  const running = installNeeds(db, id);
  assert.ok(db.applyEvent(id, { type: 'cancel' }));
  await assert.rejects(running, /is now cancelled, so it was not retried/);
  const t = db.getTask(id)!;
  assert.equal(t.status, 'cancelled');
  assert.doesNotMatch(db.eventsForTask(id).at(-1)!.reason ?? '', /installed added/, 'no retry followed the cancel');
});

test('only a blocked task that asked for packages, on a Node toolchain', async () => {
  const host = await blockedFor(['example.com'], 'host');
  await assert.rejects(installNeeds(db, host.id), /has not asked for packages/);
  const cargo = db.addRepo({ name: 'rusty', path: join(home, 'rusty'), base_branch: 'main', toolchain: 'cargo' });
  const t = db.addTask({ repo_id: cargo.id, title: 't', prompt: 'p' });
  db.claimNextTask();
  db.applyEvent(
    t.id,
    { type: 'finish', outcome: 'blocked', environment: true },
    { reason: 'NEEDS', needs: { kind: 'deps', items: ['serde'] } },
  );
  await assert.rejects(installNeeds(db, t.id), /install serde on the branch yourself/);
  await assert.rejects(installNeeds(db, 9999), /no such task/);
});

test('nothing in the worker or scheduler installs', () => {
  for (const file of ['run/worker.ts', 'scheduler/scheduler.ts']) {
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, '../src/application', file), 'utf8'), /installNeeds/);
  }
});
