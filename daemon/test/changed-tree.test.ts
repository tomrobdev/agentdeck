// The Changes tab's file tree, built from a task's changed files. The dashboard has no test runner, so its pure helpers are
// tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '../src/api/contract.ts';
import { changedTree } from '../../app/src/lib/changedTree.ts';

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  old_path: null,
  status: 'M',
  additions: 1,
  deletions: 0,
  binary: false,
  ...over,
});

test('a chain of single-child folders is one node', () => {
  const tree = changedTree([file('daemon/src/a.ts'), file('daemon/src/b.ts')]);
  assert.deepEqual(
    tree.get('')?.map((n) => [n.name, n.path, n.type]),
    [['daemon/src', 'daemon/src', 'dir']],
  );
  assert.deepEqual(
    tree.get('daemon/src')?.map((n) => n.path),
    ['daemon/src/a.ts', 'daemon/src/b.ts'],
  );
  assert.equal(tree.get('daemon'), undefined);
});

test('a folder with files or several folders is not joined', () => {
  const tree = changedTree([file('app/x.ts'), file('app/src/y.ts'), file('app/lib/z.ts')]);
  assert.deepEqual(
    tree.get('')?.map((n) => n.name),
    ['app'],
  );
  assert.deepEqual(
    tree.get('app')?.map((n) => n.name),
    ['lib', 'src', 'x.ts'],
  );
});

test('folders come before files, each sorted by name', () => {
  const tree = changedTree([file('z.md'), file('b/one.ts'), file('a.md'), file('a/two.ts')]);
  assert.deepEqual(
    tree.get('')?.map((n) => n.name),
    ['a', 'b', 'a.md', 'z.md'],
  );
});

test('a file carries its status as a badge, and its counts or "bin"', () => {
  const tree = changedTree([
    file('new.ts', { status: 'A', additions: 4, deletions: 0 }),
    file('gone.ts', { status: 'D', additions: 0, deletions: 9 }),
    file('logo.png', { status: 'M', binary: true, additions: 0, deletions: 0 }),
    file('moved.ts', { status: 'R', old_path: 'old.ts', additions: 1, deletions: 1 }),
  ]);
  const byName = new Map(tree.get('')!.map((n) => [n.name, n]));
  assert.deepEqual(byName.get('new.ts'), {
    name: 'new.ts',
    path: 'new.ts',
    type: 'file',
    badge: 'A',
    badgeTitle: 'added',
    meta: undefined,
    delta: { add: 4, del: 0 },
  });
  assert.equal(byName.get('gone.ts')?.badgeTitle, 'deleted');
  assert.deepEqual(byName.get('gone.ts')?.delta, { add: 0, del: 9 });
  assert.equal(byName.get('logo.png')?.meta, 'bin');
  assert.equal(byName.get('logo.png')?.delta, undefined);
  assert.equal(byName.get('moved.ts')?.badge, 'R');
  assert.equal(byName.get('moved.ts')?.badgeTitle, 'renamed');
});

test('no changed files is an empty root', () => {
  assert.deepEqual(changedTree([]).get(''), []);
});
