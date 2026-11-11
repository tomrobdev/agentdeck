// Every function a domain context exports is used in a pure test, and a test that touches db, application, adapters, fixtures or the file system does not count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type DomainExport,
  checkDomainTests,
  domainNamesUsed,
  impureImports,
  readDomainFunctions,
  readTestFiles,
} from '../../scripts/lib/domain-tests.ts';
import { parseSource } from '../../scripts/lib/sources.ts';
import { UNTESTED_DOMAIN_EXPORTS } from '../../scripts/lib/progress.ts';

const exported = readDomainFunctions();
const tests = readTestFiles();

const sample = (path: string, text: string) => ({ path, source: parseSource(path, text) });
const one: DomainExport = { context: 'work', name: 'stageOf', file: 'daemon/src/domain/work/task/stage.ts' };

test('[domain-tests] every exported domain function is used in a pure test, beyond the listed ones, and no entry is stale', () => {
  const { found, stale } = checkDomainTests(exported, tests, UNTESTED_DOMAIN_EXPORTS);
  assert.deepEqual([...found, ...stale], []);
});

test('[domain-tests] the contexts export functions, and only functions are counted', () => {
  assert.ok(exported.length > 100);
  assert.ok(exported.some((e) => e.context === 'work' && e.name === 'stageOf'));
  assert.ok(!exported.some((e) => e.name === 'RULES'));
});

test('[domain-tests] a function used in no pure test fails, naming it and its file', () => {
  const { found, stale } = checkDomainTests([one], [], []);
  assert.deepEqual(stale, []);
  assert.equal(found.length, 1);
  assert.match(found[0], /^daemon\/src\/domain\/work\/task\/stage\.ts: stageOf .*pure test.*UNTESTED_DOMAIN_EXPORTS/);
});

test('[domain-tests] a function imported and used in a pure test passes, also through an alias or a namespace', () => {
  const pure = sample('work/a.test.ts', "import { stageOf as s } from '../../src/domain/work/index.ts';\ns({});\n");
  assert.deepEqual(checkDomainTests([one], [pure], []), { found: [], stale: [] });
  const space = sample('work/b.test.ts', "import * as work from '../../src/domain/work/index.ts';\nwork.stageOf({});\n");
  assert.deepEqual(checkDomainTests([one], [space], []), { found: [], stale: [] });
});

test('[domain-tests] an import alone, or a type-only import, is not a use', () => {
  const unused = sample('work/a.test.ts', "import { stageOf } from '../../src/domain/work/index.ts';\n");
  const typed = sample('work/b.test.ts', "import type { stageOf } from '../../src/domain/work/index.ts';\nlet x: typeof stageOf;\n");
  assert.deepEqual([...domainNamesUsed(unused.source)], []);
  assert.deepEqual([...domainNamesUsed(typed.source)], []);
});

test('[domain-tests] a test that imports db, application, adapters, fixtures, node:fs or node:child_process is not pure', () => {
  for (const spec of [
    '../../src/db/index.ts',
    '../../src/application/work/tasks.ts',
    '../../src/adapters/git/git.ts',
    '../fixtures/fixtures.ts',
    'node:fs',
    'node:fs/promises',
    'node:child_process',
  ]) {
    const impure = sample('work/a.test.ts', `import { stageOf } from '../../src/domain/work/index.ts';\nimport '${spec}';\nstageOf({});\n`);
    assert.deepEqual(impureImports(impure.source), [spec]);
    assert.equal(checkDomainTests([one], [impure], []).found.length, 1, spec);
  }
});

test('[domain-tests] a listed function with no test passes; one that now has a test, or is gone, is stale', () => {
  assert.deepEqual(checkDomainTests([one], [], ['work/stageOf']), { found: [], stale: [] });
  const pure = sample('work/a.test.ts', "import { stageOf } from '../../src/domain/work/index.ts';\nstageOf({});\n");
  const now = checkDomainTests([one], [pure], ['work/stageOf', 'work/gone']);
  assert.equal(now.stale.length, 2);
  assert.match(now.stale[0], /work\/stageOf is on UNTESTED_DOMAIN_EXPORTS but has a pure test now/);
  assert.match(now.stale[1], /work\/gone is on UNTESTED_DOMAIN_EXPORTS but is no longer exported/);
});
