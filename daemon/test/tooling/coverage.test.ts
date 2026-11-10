import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { groupCoverage, groupOf, groupsWithCode, judgeCoverage, parseLcov, showPercent } from '../../scripts/lib/coverage.ts';
import { COVERAGE_FLOORS } from '../../scripts/lib/progress.ts';
import { parseSource, readSources } from '../../scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../../src');

const record = (file: string, lf: number, lh: number, brf: number, brh: number) =>
  [`SF:${file}`, 'DA:1,1', `LF:${lf}`, `LH:${lh}`, `BRF:${brf}`, `BRH:${brh}`, 'end_of_record'].join('\n');

test('[coverage-floors] COVERAGE_FLOORS names every group of daemon/src that has code, and nothing else', () => {
  const groups = groupsWithCode(readSources(SRC));
  const floors = Object.keys(COVERAGE_FLOORS).sort();
  assert.deepEqual(
    groups.filter((g) => !floors.includes(g)),
    [],
    'add these groups to COVERAGE_FLOORS in daemon/scripts/lib/progress.ts, at the numbers `pnpm coverage` prints, rounded down',
  );
  assert.deepEqual(
    floors.filter((g) => !groups.includes(g)),
    [],
    'COVERAGE_FLOORS names groups daemon/src no longer has: remove them',
  );
});

test('[coverage-floors] every floor is a whole percent from 0 to 100', () => {
  const bad = Object.entries(COVERAGE_FLOORS)
    .flatMap(([g, f]) => [
      [g, 'lines', f.lines],
      [g, 'branches', f.branches],
    ])
    .filter(([, , n]) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 100)
    .map(([g, m, n]) => `${g}.${m} is ${n}`);
  assert.deepEqual(bad, []);
});

test('coverage: a file belongs to its context, its layer, or the top of src', () => {
  assert.equal(groupOf('domain/work/read/files.ts'), 'domain/work');
  assert.equal(groupOf('application/landing/settle.ts'), 'application/landing');
  assert.equal(groupOf('application/actions.ts'), 'application');
  assert.equal(groupOf('db/tasks.ts'), 'db');
  assert.equal(groupOf('api/routes/tasks.ts'), 'api');
  assert.equal(groupOf('compose.ts'), 'src');
});

test('coverage: an lcov report is read per file under daemon/src and summed per group', () => {
  const lcov = [
    'TN:',
    record('src/domain/work/task.ts', 10, 9, 4, 2),
    record('src/domain/work/plan.ts', 10, 10, 0, 0),
    record('daemon/src/db/tasks.ts', 5, 5, 2, 2),
    record('test/fixtures.ts', 100, 0, 10, 0),
  ].join('\n');
  const files = parseLcov(lcov);
  assert.deepEqual(
    files.map((f) => f.path),
    ['domain/work/task.ts', 'domain/work/plan.ts', 'db/tasks.ts'],
  );
  assert.deepEqual(groupCoverage(files), [
    { group: 'db', files: 1, lines: { hit: 5, found: 5 }, branches: { hit: 2, found: 2 } },
    { group: 'domain/work', files: 2, lines: { hit: 19, found: 20 }, branches: { hit: 2, found: 4 } },
  ]);
});

test('coverage: a group below its floor fails, one beaten by more than 2 points is told to rise, and floors must match the groups', () => {
  const groups = groupCoverage(parseLcov([record('src/db/a.ts', 100, 90, 100, 80), record('src/cli/b.ts', 100, 50, 10, 10)].join('\n')));
  const { failures, raise } = judgeCoverage(groups, {
    db: { lines: 91, branches: 77 },
    'domain/gone': { lines: 50, branches: 50 },
  });
  assert.deepEqual(failures, [
    'cli has no floor: add it to COVERAGE_FLOORS in daemon/scripts/lib/progress.ts, at its numbers rounded down',
    'db: lines 90.0% is below its floor of 91%: add tests, never lower the floor',
    'domain/gone is on COVERAGE_FLOORS but no measured file is in it: remove the entry',
  ]);
  assert.deepEqual(raise, ['db: branches 80.0% beats its floor of 77%: raise it to 80']);
  assert.deepEqual(judgeCoverage(groups, { db: { lines: 90, branches: 78 }, cli: { lines: 50, branches: 100 } }), {
    failures: [],
    raise: [],
  });
});

test('coverage: a percent shows rounded down, and a file of types alone has no group', () => {
  assert.equal(showPercent(99.96), '99.9%');
  assert.equal(showPercent(100), '100.0%');
  const types = parseSource('domain/x/types.ts', "import type { A } from './a.ts';\nexport interface B { a: A }\nexport type C = B;\n");
  const code = parseSource('domain/y/code.ts', 'export const one = 1;\n');
  assert.deepEqual(groupsWithCode([types, code]), ['domain/y']);
});
