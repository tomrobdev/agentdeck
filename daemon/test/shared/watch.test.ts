import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchSource } from '#adapters/macos/watch.ts';
import { waitFor } from '#test/fixtures/fixtures.ts';

const MARK = 'zz-mark-';
let marks = 0;

function watcher(dir: string) {
  const calls: string[] = [];
  const stop = watchSource(dir, (file) => calls.push(file));
  const mark = async () => {
    const name = `${MARK}${++marks}.ts`;
    await waitFor(() => (writeFileSync(join(dir, name), 'x'), calls.includes(name)), { what: `the change to ${name}` });
  };
  const changed = () => calls.filter((f) => !f.startsWith(MARK));
  return { calls, stop, mark, changed };
}

async function watched() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-watch-')));
  mkdirSync(join(dir, 'sub'));
  const w = watcher(dir);
  await w.mark();
  return {
    ...w,
    dir,
    write: (file: string, text = 'x') => writeFileSync(join(dir, file), text),
    close() {
      w.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a change to a .ts file calls back with its path relative to the watched folder', async () => {
  const w = await watched();
  try {
    w.write('sub/a.ts');
    await waitFor(() => w.calls.includes(join('sub', 'a.ts')), { what: 'the change to sub/a.ts' });
    await w.mark();
    assert.deepEqual(new Set(w.changed()), new Set([join('sub', 'a.ts')]), 'only the changed file is named');
  } finally {
    w.close();
  }
});

test('a burst of saves to one file names only that file', async () => {
  const w = await watched();
  try {
    for (let i = 0; i < 20; i++) w.write('sub/a.ts', String(i));
    await w.mark();
    assert.ok(w.changed().length >= 1, 'the burst calls back');
    assert.deepEqual(new Set(w.changed()), new Set([join('sub', 'a.ts')]));
  } finally {
    w.close();
  }
});

test('a change outside .ts files does not call back', async () => {
  const w = await watched();
  try {
    w.write('notes.md');
    w.write('sub/view.tsx');
    w.write('sub/data.json');
    w.write('sub/a.ts.bak');
    await w.mark();
    assert.deepEqual(w.changed(), []);
  } finally {
    w.close();
  }
});

test('after stopping, a change calls back no more', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-watch-')));
  const stopped = watcher(dir);
  const live = watcher(dir);
  try {
    await stopped.mark();
    await live.mark();
    stopped.stop();
    writeFileSync(join(dir, 'a.ts'), 'x');
    await live.mark();
    assert.ok(live.changed().includes('a.ts'), 'the live watcher saw the change');
    assert.deepEqual(stopped.changed(), []);
  } finally {
    live.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
