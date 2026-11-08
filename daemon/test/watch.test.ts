// The source watcher (adapters/watch.ts) on a real temporary folder: which file changes reach the callback, and with
// what path. Waiting for "no callback" is done with a marker file: watch events arrive in order, so once a later .ts
// file's change has come, every change made before it has come too.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchSource } from '../src/adapters/watch.ts';
import { waitFor } from './fixtures.ts';

/** The marker files' names start with this, so the paths a test checks can leave them out. */
const MARK = 'zz-mark-';
let marks = 0;

/** A watcher on `dir` and the paths it called back with. */
function watcher(dir: string) {
  const calls: string[] = [];
  const stop = watchSource(dir, (file) => calls.push(file));
  /** Change a marker .ts file until its callback comes: every change made before then has been delivered. */
  const mark = async () => {
    const name = `${MARK}${++marks}.ts`;
    // Written again on each poll: the watcher starts listening a moment after watchSource returns.
    await waitFor(() => (writeFileSync(join(dir, name), 'x'), calls.includes(name)), { what: `the change to ${name}` });
  };
  /** The paths called back with, leaving out the marker files. */
  const changed = () => calls.filter((f) => !f.startsWith(MARK));
  return { calls, stop, mark, changed };
}

/** A temporary folder with a `sub/` folder, watched and listening. */
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
  // A second watcher on the same folder tells when the change has been delivered.
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
