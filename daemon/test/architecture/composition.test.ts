// Which process does what: only the daemon starts claude, and only the composition roots build an App or print and exit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import {
  type Finding,
  appBuilders,
  claudeStarters,
  cliStarterCalls,
  daemonRequestsWithoutClaude,
  loadProgram,
} from '#scripts/lib/claude-starters.ts';
import { lineOf, parseSource } from '#scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../../src');
const program = loadProgram();
const shown = (found: Finding[], rule: string) => found.map((f) => `${f.path}:${f.line} ${f.message} [${rule}]`);
const mayBuildApp = (path: string) => path === 'src/compose.ts' || path.startsWith('test/fixtures/');

test('[cli-in-process] the use cases that start claude are worked out from the code', () => {
  const names = claudeStarters(program).map((s) => s.name);
  for (const name of ['proposeNow', 'syncNow', 'startVerify', 'runTask', 'Scheduler.tick'])
    assert.ok(names.includes(name), `${name} starts claude`);
  for (const name of ['addTask', 'retryTask', 'status', 'repoDetail']) assert.ok(!names.includes(name), `${name} starts no claude`);
});

test('[cli-in-process] the CLI calls no use case that starts claude; it asks the daemon', () => {
  assert.deepEqual(shown(cliStarterCalls(program), 'cli-in-process'), []);
});

test('[cli-in-process] the CLI asks the daemon only for work that starts claude', () => {
  assert.deepEqual(shown(daemonRequestsWithoutClaude(program), 'cli-in-process'), []);
});

test('[cli-in-process] a sample CLI file that proposes in its own process, or asks the daemon to resume a repo, fails', () => {
  const sample = loadProgram(
    {
      'src/cli/repos/sample.ts': [
        "import * as actions from '#application/actions.ts';",
        "import { callDaemon } from '#cli/operations/daemon-client.ts';",
        'export const propose = (db: actions.ComposedApp) => actions.proposeNow(db, 1 as never);',
        "export const resume = () => callDaemon('POST', `/api/repos/${1}/resume`, {});",
        '',
      ].join('\n'),
    },
    program,
  );
  assert.deepEqual(
    cliStarterCalls(sample).map((f) => `${f.path}:${f.line}`),
    ['cli/repos/sample.ts:3'],
  );
  assert.match(cliStarterCalls(sample)[0].message, /calls proposeNow .*which starts claude/);
  assert.deepEqual(
    daemonRequestsWithoutClaude(sample).map((f) => `${f.path}:${f.line}`),
    ['cli/repos/sample.ts:4'],
  );
});

const PRINTS_OR_EXITS = /^(console\.\w+|process\.exit)$/;

const printsOrExits = (s: { path: string; ast: ts.SourceFile }) => {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && PRINTS_OR_EXITS.test(node.getText(s.ast)))
      found.push(
        `${s.path}:${lineOf(s.ast, node)} uses ${node.getText(s.ast)}: runDaemon logs through \`log\` and exits through \`exit\`; cli/operations/daemon.ts prints and exits [composition-root]`,
      );
    ts.forEachChild(node, visit);
  };
  visit(s.ast);
  return found;
};

test('[composition-root] daemon.ts never prints or exits on its own account', () => {
  assert.deepEqual(printsOrExits(parseSource('daemon.ts', readFileSync(join(SRC, 'daemon.ts'), 'utf8'))), []);
});

test('[composition-root] a sample daemon.ts that logs with console.log or calls process.exit fails', () => {
  const sample = parseSource('daemon.ts', "export function runDaemon() {\n  console.log('up');\n  process.exit(0);\n}\n");
  assert.deepEqual(
    printsOrExits(sample).map((f) => f.split(' ')[0]),
    ['daemon.ts:2', 'daemon.ts:3'],
  );
});

test('[composition-root] only src/compose.ts and test/fixtures/ build an App', () => {
  assert.deepEqual(shown(appBuilders(program, mayBuildApp), 'composition-root'), []);
});

test('[composition-root] a sample that builds an App outside compose.ts fails', () => {
  const sample = loadProgram(
    {
      'src/api/sample.ts': [
        "import type { App, Ports } from '#application/ports/app.ts';",
        'export const ports = (): Ports => ({}) as never;',
        'export const app = (db: object) => Object.assign(db, ports()) as App;',
        'export const literal: Ports = { ...ports() };',
        '',
      ].join('\n'),
    },
    program,
  );
  assert.deepEqual(
    appBuilders(sample, mayBuildApp).map((f) => `${f.path}:${f.line}`),
    ['src/api/sample.ts:3', 'src/api/sample.ts:4'],
  );
});
