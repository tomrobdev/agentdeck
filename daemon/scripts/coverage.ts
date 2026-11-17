// The daemon tests with V8 coverage against COVERAGE_FLOORS; CI runs them in shards (--shard) and judges the merged counts (--merge).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  RAISE_MARGIN,
  balanceShards,
  groupCoverage,
  judgeCoverage,
  ownScripts,
  parseLcov,
  parseShard,
  percent,
  showPercent,
  withUnloaded,
} from './lib/coverage.ts';
import { COVERAGE_FLOORS } from './lib/progress.ts';

const DAEMON = join(import.meta.dirname, '..');
const ROOT = join(DAEMON, '..');
const RAW = join(DAEMON, 'coverage/v8');
const REPORT = join(DAEMON, 'coverage');
const WEIGHTS = join(DAEMON, 'scripts/lib/test-weights.json');
const MEASURED = ['daemon/src/', 'app/src/lib/'];
const TEST_ENV = { ...process.env, AGENTDECK_NO_NOTIFY: '1', AGENTDECK_CANCEL_POLL_MS: '50' };

const { values: flags } = parseArgs({
  options: { lcov: { type: 'string' }, shard: { type: 'string' }, merge: { type: 'boolean' }, weigh: { type: 'boolean' } },
});

const testFiles = () =>
  readdirSync(join(DAEMON, 'test'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `test/${f}`)
    .sort();

function runTests(paths: string[], tag: string): boolean {
  rmSync(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });
  const run = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-reporter=dot', ...paths], {
    cwd: DAEMON,
    stdio: 'inherit',
    env: { ...TEST_ENV, NODE_V8_COVERAGE: RAW },
  });
  const roots = MEASURED.map((dir) => pathToFileURL(join(ROOT, dir)).href);
  for (const name of readdirSync(RAW)) {
    const path = join(RAW, name);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { result: { url: string }[] };
    rmSync(path);
    const result = ownScripts(raw.result, roots);
    if (result.length) writeFileSync(join(RAW, `${tag}-${name}`), JSON.stringify({ result }));
  }
  return run.status === 0;
}

function writeLcov(): string {
  const c8 = join(DAEMON, 'node_modules/c8/bin/c8.js');
  const include = MEASURED.flatMap((dir) => ['--include', `${dir}**`]);
  const args = [c8, 'report', '--temp-directory', RAW, '--reporter=lcovonly', '--report-dir', REPORT, ...include];
  const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) throw new Error('c8 could not build the coverage report');
  return join(REPORT, 'lcov.info');
}

function judge(lcov: string, testsFailed: boolean): never {
  const libRoot = join(ROOT, 'app/src/lib');
  const libFiles = readdirSync(libRoot, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((path) => ({
      path,
      lines: readFileSync(join(libRoot, path), 'utf8')
        .split('\n')
        .filter((l) => l.trim()).length,
    }));
  const groups = groupCoverage(withUnloaded(parseLcov(readFileSync(lcov, 'utf8')), libFiles));
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
  process.exit(0);
}

if (flags.weigh) {
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--test-timeout=60000',
      `--test-reporter=${join(DAEMON, 'scripts/test-weights-reporter.ts')}`,
      'test/',
    ],
    { cwd: DAEMON, stdio: ['ignore', 'pipe', 'inherit'], env: TEST_ENV, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error('the tests failed, so their durations were not saved');
  writeFileSync(WEIGHTS, run.stdout);
  console.log(`saved each test file's duration to ${WEIGHTS}`);
} else if (flags.shard) {
  const { index, count } = parseShard(flags.shard);
  const weights = existsSync(WEIGHTS) ? (JSON.parse(readFileSync(WEIGHTS, 'utf8')) as Record<string, number>) : {};
  const files = balanceShards(testFiles(), weights, count)[index - 1];
  console.log(`shard ${index}/${count}: ${files.length} test files`);
  process.exit(runTests(files, `shard${index}`) ? 0 : 1);
} else if (flags.merge) {
  judge(writeLcov(), false);
} else if (flags.lcov) {
  judge(resolve(flags.lcov), false);
} else {
  const passed = runTests(['test/'], 'all');
  judge(writeLcov(), !passed);
}
