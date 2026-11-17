// Workers and test runs find cargo: rustup's directories join their PATH when they exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUST_DIRS, msFrom, rustDirs, withToolchainPath } from '#src/config.ts';

test('an existing rustup directory is added to PATH, a missing one is left out', () => {
  const [cargoBin, brewBin] = RUST_DIRS;
  const only = (dir: string) => (p: string) => p === dir;

  const withBrew = withToolchainPath({ PATH: '/usr/bin:/bin', KEEP: 'x' }, only(brewBin!));
  assert.equal(withBrew.PATH, `/usr/bin:/bin:${brewBin}`);
  assert.equal(withBrew.KEEP, 'x');

  const withCargo = withToolchainPath({ PATH: '/usr/bin' }, only(cargoBin!));
  assert.equal(withCargo.PATH, `/usr/bin:${cargoBin}`);

  assert.equal(withToolchainPath({ PATH: '/usr/bin' }, () => false).PATH, '/usr/bin');
  assert.deepEqual(
    rustDirs(() => false),
    [],
  );
});

test('a directory already on PATH is not added twice', () => {
  const env = withToolchainPath({ PATH: `${RUST_DIRS[1]}:/usr/bin` }, () => true);
  assert.equal(env.PATH, `${RUST_DIRS[1]}:/usr/bin:${RUST_DIRS[0]}`);
});

test('a timing set from the environment takes a positive number of milliseconds, else the default', () => {
  assert.equal(msFrom('50', 2_000), 50);
  for (const text of [undefined, '', '0', '-5', 'soon']) assert.equal(msFrom(text, 2_000), 2_000, String(text));
});
