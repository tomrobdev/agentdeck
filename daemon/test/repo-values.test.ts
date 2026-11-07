// A repo's flags are booleans and its JSON columns arrays: read by `toRepo`, written by `repoColumns`, and flattened for the API by `repoView`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoView } from '../src/application/repos/repo-view.ts';
import { repoColumns, toRepo } from '../src/db/mappers.ts';
import { openDb } from '../src/db/index.ts';

const FLAGS = ['auto_approve', 'auto_resolve', 'auto_unblock', 'sandbox', 'auto_merge'] as const;
const LISTS = ['allowed_tools', 'network', 'auto_merge_skip'] as const;

function repoRow() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  return { db, repo };
}

test('a new repo has its defaults as values', () => {
  const { db, repo } = repoRow();
  assert.deepEqual(
    [repo.auto_approve, repo.auto_resolve, repo.auto_unblock, repo.sandbox, repo.auto_merge],
    [false, true, false, true, false],
  );
  assert.deepEqual([repo.allowed_tools, repo.network, repo.auto_merge_skip], [null, [], ['.github/']]);
  db.close();
});

test('each flag round-trips through the store', () => {
  const { db, repo } = repoRow();
  for (const flag of FLAGS) {
    for (const value of [!repo[flag], repo[flag]]) {
      db.updateRepo(repo.id, { [flag]: value });
      assert.equal(db.getRepo(repo.id)![flag], value, `${flag} ${value}`);
    }
  }
  db.close();
});

test('each list round-trips through the store', () => {
  const { db, repo } = repoRow();
  const lists = {
    allowed_tools: ['Read', 'Bash(make*)'],
    network: ['registry.npmjs.org', '*.github.com'],
    auto_merge_skip: ['db/', 'a.ts'],
  };
  for (const key of LISTS) {
    db.updateRepo(repo.id, { [key]: lists[key] });
    assert.deepEqual(db.getRepo(repo.id)![key], lists[key], key);
  }
  db.updateRepo(repo.id, { auto_merge_skip: [], network: [] });
  assert.deepEqual([db.getRepo(repo.id)!.auto_merge_skip, db.getRepo(repo.id)!.network], [[], []]);
  db.close();
});

test('a repo registered with its own tool rules keeps them, and none leaves them null', () => {
  const db = openDb(':memory:');
  assert.deepEqual(db.addRepo({ name: 'a', path: '/tmp/a', base_branch: 'main', allowed_tools: ['Read'] }).allowed_tools, ['Read']);
  assert.equal(db.addRepo({ name: 'b', path: '/tmp/b', base_branch: 'main', allowed_tools: [] }).allowed_tools, null);
  db.close();
});

test('a legacy malformed list reads as its default', () => {
  const { db, repo } = repoRow();
  const row = (over: Record<string, unknown>) => ({ ...repoColumns(repo), ...over }) as never;
  assert.deepEqual(toRepo(row({ network: 'not json' })).network, []);
  assert.deepEqual(toRepo(row({ network: '{"a":1}' })).network, []);
  assert.deepEqual(toRepo(row({ network: '["a.com", 7]' })).network, ['a.com']);
  assert.deepEqual(toRepo(row({ auto_merge_skip: 'nonsense' })).auto_merge_skip, ['.github/']);
  assert.deepEqual(toRepo(row({ auto_merge_skip: '[]' })).auto_merge_skip, []);
  assert.deepEqual(toRepo(row({ allowed_tools: 'not json' })).allowed_tools, [], 'unreadable rules allow nothing, not the defaults');
  assert.equal(toRepo(row({ allowed_tools: null })).allowed_tools, null);
  db.close();
});

test('repoColumns is the way back from toRepo', () => {
  assert.deepEqual(repoColumns({ sandbox: false, auto_merge: true, network: ['a.com'], allowed_tools: null }), {
    sandbox: 0,
    auto_merge: 1,
    network: '["a.com"]',
    allowed_tools: null,
  });
});

test('repoView keeps the flat shape of the columns', () => {
  const { db, repo } = repoRow();
  db.updateRepo(repo.id, { auto_merge: true, network: ['a.com'], sandbox: false });
  const view = repoView(db.getRepo(repo.id)!);
  assert.deepEqual(
    [view.auto_merge, view.sandbox, view.auto_resolve, view.network, view.auto_merge_skip, view.allowed_tools],
    [1, 0, 1, '["a.com"]', '[".github/"]', null],
  );
  db.close();
});
