import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashPatterns, matchesRule, refusedCommands, splitCommand } from '#domain/repos/tool-rules.ts';
import { ALWAYS_DISALLOWED_TOOLS } from '#domain/repos/tools.ts';
import { claudeArgs, workerSystemPrompt } from '#domain/runs/prompt.ts';

test('every run is started without the tools that schedule a wake-up', () => {
  for (const tool of ['ScheduleWakeup', 'CronCreate', 'CronDelete']) assert.ok(ALWAYS_DISALLOWED_TOOLS.includes(tool), tool);
  const args = claudeArgs({ model: 'm', max_turns: 5 }, ['Read'], 'p', null, 's');
  const disallowed = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const tool of ['ScheduleWakeup', 'CronCreate', 'CronDelete']) assert.ok(disallowed.includes(tool), tool);
});

test("the worker's system prompt says to wait for a background command by its completion notice", () => {
  assert.match(workerSystemPrompt(null), /completion notice[^\n]*never[^\n]*ScheduleWakeup/);
});

test('splitCommand splits on &&, ||, ; and |', () => {
  const table: [string, string[]][] = [
    ['pnpm test', ['pnpm test']],
    ['  pnpm test  ', ['pnpm test']],
    ['pnpm install && pnpm test', ['pnpm install', 'pnpm test']],
    ['a || b', ['a', 'b']],
    ['a; b', ['a', 'b']],
    ['a | b | c', ['a', 'b', 'c']],
    ['a && b || c; d | e', ['a', 'b', 'c', 'd', 'e']],
    ['a\nb', ['a', 'b']],
    ['a &&  && b', ['a', 'b']],
    ['', []],
    [' ; ', []],
    ['echo "a && b" && ls', ['echo "a && b"', 'ls']],
    ["grep 'x|y' file | wc", ["grep 'x|y' file", 'wc']],
    ['echo "say \\"hi; bye\\""; ls', ['echo "say \\"hi; bye\\""', 'ls']],
    ['echo a\\;b', ['echo a\\;b']],
    ['pnpm test 2>&1 | tail', ['pnpm test 2>&1', 'tail']],
  ];
  for (const [cmd, want] of table) assert.deepEqual(splitCommand(cmd), want, JSON.stringify(cmd));
});

test('matchesRule: a trailing * is a prefix match, otherwise the command must be exact', () => {
  const table: [string, string, boolean][] = [
    ['pnpm test', 'pnpm test*', true],
    ['pnpm test --watch', 'pnpm test*', true],
    ['pnpm testing', 'pnpm test*', true],
    ['pnpm tes', 'pnpm test*', false],
    ['pnpm run lint', 'pnpm run *', true],
    ['pnpm run', 'pnpm run *', false],
    ['pnpm test', 'pnpm test', true],
    ['pnpm test --watch', 'pnpm test', false],
    ['git status', '*', true],
    ['', 'git status*', false],
  ];
  for (const [cmd, pattern, want] of table) assert.equal(matchesRule(cmd, pattern), want, `${cmd} vs ${pattern}`);
});

test('bashPatterns reads Bash(...) rules and ignores other tools', () => {
  assert.deepEqual(bashPatterns(['Read', 'Edit', 'Bash(git status*)', 'Bash(pnpm run *)']), ['git status*', 'pnpm run *']);
  assert.deepEqual(bashPatterns(['Bash']), ['*'], 'a bare Bash rule allows everything');
  assert.deepEqual(bashPatterns(['Read', 'WebFetch(domain:x.com)']), []);
});

test('refusedCommands lists the parts of a command that no rule allows', () => {
  const tools = ['Read', 'Bash(pnpm test*)', 'Bash(pnpm typecheck*)', 'Bash(node scripts/check.mjs)', 'Bash(ls*)'];
  const table: [string, string[]][] = [
    ['pnpm test', []],
    ['pnpm typecheck && pnpm test', []],
    ['pnpm format:check && pnpm typecheck', ['pnpm format:check']],
    ['pnpm check', ['pnpm check']],
    ['pnpm test | tee out.log', ['tee out.log']],
    ['node scripts/check.mjs', []],
    ['node scripts/check.mjs --fix', ['node scripts/check.mjs --fix']],
    ['cd app; pnpm test', ['cd app']],
    ['ls || pnpm install', ['pnpm install']],
    ['pnpm test 2>&1', []],
    ['', []],
  ];
  for (const [cmd, want] of table) assert.deepEqual(refusedCommands(cmd, tools), want, cmd);
  assert.deepEqual(refusedCommands('anything && at all', ['Bash']), []);
  assert.deepEqual(refusedCommands('pnpm test', ['Read']), ['pnpm test'], 'no Bash rules allow nothing');
});
