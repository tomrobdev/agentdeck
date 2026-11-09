import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkedOutBranch as currentBranch, hasUncommittedChanges } from '../../src/adapters/git.ts';

test('an uncommitted change to db/schema.ts blocks until it is committed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reload-guard-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'daemon/src/db'), { recursive: true });
    const schema = join(dir, 'daemon/src/db/schema.ts');
    writeFileSync(schema, 'export const steps = [1];\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    assert.equal(await hasUncommittedChanges(schema), false);
    assert.equal(await currentBranch(dir), 'main');
    writeFileSync(schema, 'export const steps = [1, 2];\n');
    assert.equal(await hasUncommittedChanges(schema), true);
    git('commit', '-qam', 'step 2');
    assert.equal(await hasUncommittedChanges(schema), false);
    git('checkout', '-qb', 'other');
    assert.equal(await currentBranch(dir), 'other');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
