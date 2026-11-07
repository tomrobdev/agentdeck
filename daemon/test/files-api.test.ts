// The git read endpoints against a real repo: /changes, /diff, /tree and /file of a task's branch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { TaskId } from '../src/domain/id/id.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-files-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { startApi } = await import('../src/api/server.ts');

const db = openDb(join(home, 'test.db'));
const server = await startApi({ db, port: 0 });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const repoPath = join(home, 'demo');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath }).toString().trim();

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any };
};

let taskId: TaskId;
let noBranchId: TaskId;
let goneBranchId: TaskId;
let mergeBaseSha = '';
const BIG = 'x'.repeat(99) + '\n'; // 100 bytes a line

before(() => {
  mkdirSync(repoPath);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  writeFileSync(join(repoPath, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repoPath, 'gone.txt'), 'bye\n');
  writeFileSync(join(repoPath, 'old.txt'), 'a file with enough lines\nthat git sees\nthe rename\nfor what it is\n');
  mkdirSync(join(repoPath, 'src/lib'), { recursive: true });
  writeFileSync(join(repoPath, 'src/lib/util.ts'), 'export const x = 1;\n');
  writeFileSync(join(repoPath, 'src/main.ts'), 'console.log(1);\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  mergeBaseSha = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'agentdeck/task-1');
  writeFileSync(join(repoPath, 'a.txt'), 'one\n2\nthree\nfour\n');
  rmSync(join(repoPath, 'gone.txt'));
  renameSync(join(repoPath, 'old.txt'), join(repoPath, 'new.txt'));
  writeFileSync(join(repoPath, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]));
  writeFileSync(join(repoPath, 'added.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Change things');
  writeFileSync(join(repoPath, 'big.txt'), BIG.repeat(6000)); // 600 KB: over both limits
  git('add', '-A');
  git('commit', '-q', '-m', 'Add a big file');

  // main moves on after the branch left it: none of this belongs to the task.
  git('checkout', '-q', 'main');
  writeFileSync(join(repoPath, 'main-only.txt'), 'later\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Later work on main');

  const repo = db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  db.setCheckout(t.id, { branch: 'agentdeck/task-1' });
  taskId = t.id;
  noBranchId = db.addTask({ repo_id: repo.id, title: 'n', prompt: 'p' }).id;
  goneBranchId = db.addTask({ repo_id: repo.id, title: 'g', prompt: 'p' }).id;
  db.setCheckout(goneBranchId, { branch: 'agentdeck/task-404' });
});

after(() => {
  server.close();
  db.close();
});

test('/changes lists added, modified, deleted, renamed and binary files against the merge base', async () => {
  const { status, body } = await get(`/api/tasks/${taskId}/changes`);
  assert.equal(status, 200);
  assert.equal(body.base_ref, 'main');
  assert.equal(body.base, mergeBaseSha);
  assert.equal(body.head, git('rev-parse', 'agentdeck/task-1'));
  const byPath = Object.fromEntries(body.files.map((f: any) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'added.txt', 'big.txt', 'bin.dat', 'gone.txt', 'new.txt']);
  assert.deepEqual(byPath['a.txt'], { path: 'a.txt', old_path: null, status: 'M', additions: 2, deletions: 1, binary: false });
  assert.deepEqual(byPath['added.txt'], { path: 'added.txt', old_path: null, status: 'A', additions: 1, deletions: 0, binary: false });
  assert.deepEqual(byPath['gone.txt'], { path: 'gone.txt', old_path: null, status: 'D', additions: 0, deletions: 1, binary: false });
  assert.deepEqual(byPath['new.txt'], { path: 'new.txt', old_path: 'old.txt', status: 'R', additions: 0, deletions: 0, binary: false });
  assert.deepEqual(byPath['bin.dat'], { path: 'bin.dat', old_path: null, status: 'A', additions: 0, deletions: 0, binary: true });
  assert.deepEqual(
    body.commits.map((c: any) => [c.subject, c.author]),
    [
      ['Add a big file', 'Tester'],
      ['Change things', 'Tester'],
    ],
  );
  assert.match(body.commits[0].sha, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(body.commits[0].at)));
});

test('/diff returns one file patch, pairs renames, and cuts big patches', async () => {
  const a = await get(`/api/tasks/${taskId}/diff?path=a.txt`);
  assert.equal(a.status, 200);
  assert.equal(a.body.path, 'a.txt');
  assert.equal(a.body.truncated, false);
  assert.match(a.body.patch, /^diff --git a\/a\.txt b\/a\.txt\n/);
  assert.match(a.body.patch, /\n-two\n\+2\n three\n\+four\n$/);

  const r = await get(`/api/tasks/${taskId}/diff?path=new.txt`);
  assert.match(r.body.patch, /rename from old\.txt\nrename to new\.txt/);

  const bin = await get(`/api/tasks/${taskId}/diff?path=bin.dat`);
  assert.match(bin.body.patch, /Binary files/);

  const big = await get(`/api/tasks/${taskId}/diff?path=big.txt`);
  assert.equal(big.body.truncated, true);
  assert.ok(Buffer.byteLength(big.body.patch) <= 256 * 1024);
  assert.ok(big.body.patch.endsWith('\n'), 'cut on a line boundary');

  const unchanged = await get(`/api/tasks/${taskId}/diff?path=src/main.ts`);
  assert.equal(unchanged.status, 400);
});

test('/tree lists one level, folders first, at head or base', async () => {
  const root = await get(`/api/tasks/${taskId}/tree?ref=head`);
  assert.equal(root.status, 200);
  assert.equal(root.body.ref, 'head');
  assert.equal(root.body.sha, git('rev-parse', 'agentdeck/task-1'));
  assert.equal(root.body.path, '');
  assert.deepEqual(
    root.body.entries.map((e: any) => [e.name, e.type]),
    [
      ['src', 'dir'],
      ['a.txt', 'file'],
      ['added.txt', 'file'],
      ['big.txt', 'file'],
      ['bin.dat', 'file'],
      ['new.txt', 'file'],
    ],
  );
  assert.deepEqual(root.body.entries[0], { name: 'src', path: 'src', type: 'dir', size: null });
  assert.deepEqual(root.body.entries[1], { name: 'a.txt', path: 'a.txt', type: 'file', size: 17 });

  const src = await get(`/api/tasks/${taskId}/tree?path=src`);
  assert.equal(src.body.ref, 'head', 'ref defaults to head');
  assert.deepEqual(
    src.body.entries.map((e: any) => e.path),
    ['src/lib', 'src/main.ts'],
  );

  const baseRoot = await get(`/api/tasks/${taskId}/tree?ref=base`);
  assert.equal(baseRoot.body.sha, mergeBaseSha);
  assert.deepEqual(
    baseRoot.body.entries.map((e: any) => e.name),
    ['src', 'a.txt', 'gone.txt', 'old.txt'],
    'the merge base, not main as it is now',
  );

  assert.equal((await get(`/api/tasks/${taskId}/tree?path=nope`)).status, 400);
  assert.equal((await get(`/api/tasks/${taskId}/tree?path=a.txt`)).status, 400);
});

test('/file reads text, binary and oversized files from git objects', async () => {
  const a = await get(`/api/tasks/${taskId}/file?ref=head&path=a.txt`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, {
    path: 'a.txt',
    ref: 'head',
    sha: git('rev-parse', 'agentdeck/task-1'),
    size: 17,
    binary: false,
    truncated: false,
    text: 'one\n2\nthree\nfour\n',
  });
  const old = await get(`/api/tasks/${taskId}/file?ref=base&path=a.txt`);
  assert.equal(old.body.text, 'one\ntwo\nthree\n');
  assert.equal(old.body.sha, mergeBaseSha);

  const bin = await get(`/api/tasks/${taskId}/file?path=bin.dat`);
  assert.equal(bin.body.binary, true);
  assert.equal(bin.body.text, null);
  assert.equal(bin.body.size, 10);

  const big = await get(`/api/tasks/${taskId}/file?path=big.txt`);
  assert.equal(big.body.size, 600_000);
  assert.equal(big.body.truncated, true);
  assert.equal(Buffer.byteLength(big.body.text), 512 * 1024);

  // Uncommitted changes in the checkout are never shown.
  git('checkout', '-q', 'agentdeck/task-1');
  writeFileSync(join(repoPath, 'a.txt'), 'dirty\n');
  try {
    assert.equal((await get(`/api/tasks/${taskId}/file?path=a.txt`)).body.text, 'one\n2\nthree\nfour\n');
  } finally {
    git('checkout', '-q', '--', 'a.txt');
    git('checkout', '-q', 'main');
  }

  assert.equal((await get(`/api/tasks/${taskId}/file?path=gone.txt`)).status, 400, 'deleted at head');
  assert.equal((await get(`/api/tasks/${taskId}/file?ref=base&path=gone.txt`)).status, 200, 'still at base');
  assert.equal((await get(`/api/tasks/${taskId}/file?path=src`)).status, 400, 'a folder');
});

test('bad paths and refs are 400s', async () => {
  const bad = [
    'file?path=/etc/passwd',
    'file?path=../outside',
    'file?path=src/../../outside',
    'file?path=a%00b',
    'file?path=-rf',
    'file?path=--output=x',
    'file',
    'diff?path=',
    'diff?path=../a.txt',
    'tree?path=/',
    'tree?path=..',
    'tree?ref=main',
    'file?ref=HEAD~1&path=a.txt',
    'file?ref=origin/main&path=a.txt',
  ];
  for (const q of bad) {
    const { status, body } = await get(`/api/tasks/${taskId}/${q}`);
    assert.equal(status, 400, q);
    assert.equal(typeof body.error, 'string', q);
  }
});

test('a task with no branch, or a branch that is gone, answers 400 task has no branch yet', async () => {
  for (const id of [noBranchId, goneBranchId]) {
    for (const q of ['changes', 'diff?path=a.txt', 'tree', 'file?path=a.txt']) {
      const { status, body } = await get(`/api/tasks/${id}/${q}`);
      assert.equal(status, 400, `${id} ${q}`);
      assert.deepEqual(body, { error: 'task has no branch yet' });
    }
  }
  assert.equal((await get('/api/tasks/9999/changes')).status, 400);
});

test('the base is the newer merge base of the local base branch and origin/<base>', async () => {
  // origin/main is ahead of local main, and the task branch started from it.
  git('checkout', '-q', '-b', 'upstream', 'main');
  writeFileSync(join(repoPath, 'upstream.txt'), 'fetched\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Upstream work');
  const upstream = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', upstream);
  git('checkout', '-q', '-b', 'agentdeck/task-2');
  writeFileSync(join(repoPath, 'task2.txt'), 'mine\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Task two');
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', 'upstream');

  const t = db.addTask({ repo_id: db.findRepo('demo')!.id, title: 't2', prompt: 'p' });
  db.setCheckout(t.id, { branch: 'agentdeck/task-2' });
  const { body } = await get(`/api/tasks/${t.id}/changes`);
  assert.equal(body.base_ref, 'origin/main');
  assert.equal(body.base, upstream);
  assert.deepEqual(
    body.files.map((f: any) => f.path),
    ['task2.txt'],
  );
});
