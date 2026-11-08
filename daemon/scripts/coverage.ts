// pnpm coverage: runs the daemon tests with coverage, prints line and branch coverage per layer and context, and fails when a group is
// below its floor in COVERAGE_FLOORS (scripts/lib/progress.ts) or when the tests fail. `--lcov <file>` judges a report already written
// instead of running the tests. The report is left in daemon/coverage/lcov.info (git ignores it).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RAISE_MARGIN, groupCoverage, judgeCoverage, parseLcov, percent, showPercent } from './lib/coverage.ts';
import { COVERAGE_FLOORS } from './lib/progress.ts';

const DAEMON = join(import.meta.dirname, '..');
const given = process.argv.indexOf('--lcov');
let lcov = join(DAEMON, 'coverage/lcov.info');
let testsFailed = false;

if (given >= 0) {
  const path = process.argv[given + 1];
  if (!path) throw new Error('usage: pnpm coverage [--lcov <file>]');
  lcov = resolve(path);
} else {
  mkdirSync(dirname(lcov), { recursive: true });
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-timeout=60000',
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      '--test-reporter=dot',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      `--test-reporter-destination=${lcov}`,
      'test/',
    ],
    { cwd: DAEMON, stdio: 'inherit', env: { ...process.env, AGENTDECK_NO_NOTIFY: '1' } },
  );
  testsFailed = run.status !== 0;
}

const groups = groupCoverage(parseLcov(readFileSync(lcov, 'utf8')));
const cell = (c: { hit: number; found: number }) => showPercent(percent(c));
const floor = (group: string, metric: 'lines' | 'branches') => (COVERAGE_FLOORS[group] ? `${COVERAGE_FLOORS[group][metric]}%` : '-');
const rows = [
  ['Group', 'Files', 'Lines', 'Floor', 'Branches', 'Floor'],
  ...groups.map((g) => [g.group, String(g.files), cell(g.lines), floor(g.group, 'lines'), cell(g.branches), floor(g.group, 'branches')]),
];
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
console.log();
for (const r of rows) console.log(r.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  '));

const { failures, raise } = judgeCoverage(groups, COVERAGE_FLOORS);
if (raise.length) {
  console.log(`\nFloors beaten by more than ${RAISE_MARGIN} points: raise them in COVERAGE_FLOORS (daemon/scripts/lib/progress.ts).`);
  for (const r of raise) console.log(`  ${r}`);
}
if (failures.length) {
  console.error('\nCoverage fails:');
  for (const f of failures) console.error(`  ${f}`);
}
if (testsFailed) console.error('\nThe tests failed, so coverage fails too: fix them first.');
if (failures.length || testsFailed) process.exit(1);
console.log('\ncoverage: every group is at or above its floor');
