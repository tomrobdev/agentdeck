import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECHECK_BLOCKED_MS, reloadBlock } from '../../src/application/operations/reload-block.ts';

const settle = () => new Promise((r) => setImmediate(r));

test('a block on uncommitted changes lifts within the rate limit once they are committed, with no file change', async () => {
  let dirty = true;
  let t = 1000;
  let computes = 0;
  const logged: string[] = [];
  const block = reloadBlock(
    async () => {
      computes++;
      return dirty ? 'db/schema.ts has uncommitted changes' : null;
    },
    { now: () => t, onNew: (r) => logged.push(r) },
  );
  await block.refresh();
  assert.equal(block.reason, 'db/schema.ts has uncommitted changes');
  dirty = false;
  t += 1000;
  block.recheck();
  await settle();
  assert.equal(computes, 1, 'rate-limited: not looked at again so soon');
  assert.notEqual(block.reason, null);
  t += RECHECK_BLOCKED_MS;
  block.recheck();
  await settle();
  assert.equal(block.reason, null);
  assert.equal(logged.length, 1);
});

test('nothing is re-checked while not blocked', async () => {
  let computes = 0;
  let t = 0;
  const block = reloadBlock(async () => (computes++, null), { now: () => t });
  await block.refresh();
  t += RECHECK_BLOCKED_MS * 5;
  block.recheck();
  await settle();
  assert.equal(computes, 1);
});

test('a refresh that resolves after a newer one is dropped', async () => {
  const pending: Array<(v: string | null) => void> = [];
  const block = reloadBlock(() => new Promise<string | null>((r) => pending.push(r)));
  const first = block.refresh();
  const second = block.refresh();
  pending[1](null);
  await second;
  pending[0]('stale');
  await first;
  assert.equal(block.reason, null);
});
