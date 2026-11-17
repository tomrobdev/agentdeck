// Code comments a branch adds: the syntax table, the exceptions, the repo's two limits, the git port and the repo setting.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-code-comments-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { codeCommentsOver, countCodeComments, parseAddedLines } = await import('#domain/landing/merge/code-comments.ts');
const { ActionError, updateRepo } = await import('#application/actions.ts');
const { repoSettingPatch } = await import('#cli/operations/settings-args.ts');
const { repoCommands } = await import('#cli/repos/repos.ts');
const { openDb } = await import('#test/fixtures/open-db.ts');

const commentsIn = (path: string, lines: string[]): number => countCodeComments({ [path]: lines }).lines;

test('each syntax in the table counts its own comment lines and not its code', () => {
  const table: { paths: string[]; comment: string[]; code: string[] }[] = [
    {
      paths: ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.rs', 'a.go', 'a.swift', 'a.kt', 'A.java', 'a.c', 'a.cpp', 'a.h', 'a.cs'],
      comment: ['// a note', '/// docs', '/* block */', '/**', ' * a line', ' */'],
      code: ['const a = 1;', 'return x * y;', 'let url = "https://example.com";'],
    },
    { paths: ['a.vue', 'a.svelte'], comment: ['// a note', '<!-- markup -->', '/* style */'], code: ['<div>{{ x }}</div>'] },
    {
      paths: ['a.py', 'a.rb', 'a.sh', 'a.yaml', 'a.yml', 'a.toml'],
      comment: ['# a note', '  # indented'],
      code: ['x = 1', 'key: "a#b"'],
    },
    { paths: ['a.sql'], comment: ['-- a note', '/* block */'], code: ['SELECT 1;'] },
    { paths: ['a.lua'], comment: ['-- a note', '--[[ block ]]'], code: ['local x = 1'] },
    { paths: ['a.ini', 'a.clj'], comment: ['; a note'], code: ['key = value'] },
    { paths: ['index.html', 'a.xml'], comment: ['<!-- a note -->'], code: ['<p>hi</p>'] },
  ];
  for (const { paths, comment, code } of table) {
    for (const path of paths) {
      assert.equal(commentsIn(path, comment), comment.length, `${path}: comments`);
      assert.equal(commentsIn(path, code), 0, `${path}: code`);
    }
  }
});

test('a block comment counts every line up to its close, blank lines left out', () => {
  assert.equal(commentsIn('a.ts', ['/*', 'first', '', 'second', '*/', 'const a = 1;']), 4);
  assert.equal(commentsIn('a.html', ['<!--', 'note', '-->', '<p>hi</p>']), 3);
  assert.equal(commentsIn('a.lua', ['--[[', 'note', ']]', 'local x = 1']), 3);
});

test('a trailing // or # after code counts, a marker without a space before it does not', () => {
  assert.equal(commentsIn('a.ts', ['const a = 1; // why']), 1);
  assert.equal(commentsIn('a.py', ['x = 1  # why']), 1);
  assert.equal(commentsIn('a.ts', ['fetch("http://x");', 'a //b']), 0);
  assert.equal(commentsIn('a.sql', ['SELECT 1; # not sql']), 0);
});

test('an unknown extension and a prose file count zero', () => {
  const lines = ['// a', '# b', '<!-- c -->'];
  for (const path of ['notes.unknownext', 'Makefile', 'README.md', 'docs/notes.txt', 'docs/plan.html', 'app/docs/x.html'])
    assert.equal(commentsIn(path, lines), 0, path);
  const count = countCodeComments({ 'README.md': ['# Title', 'text'], 'a.ts': ['// a', 'const a = 1;'] });
  assert.deepEqual(count, { files: [{ path: 'a.ts', lines: 1 }], lines: 1, added: 2, percent: 50 });
});

test('the shebang, #include and // @ts-expect-error are not code comments', () => {
  assert.equal(commentsIn('run.sh', ['#!/bin/sh', 'echo hi']), 0);
  assert.equal(commentsIn('main.py', ['#!/usr/bin/env python3']), 0);
  assert.equal(commentsIn('a.c', ['#include <stdio.h>', '#define N 3']), 0);
  assert.equal(commentsIn('a.ts', ['// @ts-expect-error the type is wrong upstream', 'call(x);']), 0);
  assert.equal(commentsIn('a.ts', ['// @ts-ignore']), 1);
});

test('the count sums the files and gives the share of the added lines', () => {
  const count = countCodeComments({ 'a.ts': ['// one', 'a();', 'b();', ''], 'b.py': ['# two', '# three', 'x = 1'] });
  assert.deepEqual(count.files, [
    { path: 'a.ts', lines: 1 },
    { path: 'b.py', lines: 2 },
  ]);
  assert.equal(count.lines, 3);
  assert.equal(count.added, 6);
  assert.equal(count.percent, 50);
  assert.deepEqual(countCodeComments({}), { files: [], lines: 0, added: 0, percent: 0 });
});

test('a diff is over when it adds more lines than the first limit or a greater share than the second, and 0 turns each off', () => {
  const limits = (lines: number, percent: number) => ({ code_comment_max_lines: lines, code_comment_max_percent: percent });
  assert.equal(codeCommentsOver({ lines: 5, percent: 5 }, limits(5, 5)), false, 'at both limits');
  assert.equal(codeCommentsOver({ lines: 6, percent: 1 }, limits(5, 5)), true, 'more lines');
  assert.equal(codeCommentsOver({ lines: 1, percent: 6 }, limits(5, 5)), true, 'a greater share');
  assert.equal(codeCommentsOver({ lines: 6, percent: 1 }, limits(0, 5)), false, 'lines off');
  assert.equal(codeCommentsOver({ lines: 1, percent: 60 }, limits(5, 0)), false, 'share off');
  assert.equal(codeCommentsOver({ lines: 900, percent: 100 }, limits(0, 0)), false, 'both off');
});

test('parseAddedLines reads the added lines per path from a -U0 diff', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,0 +2,2 @@',
    '+// note',
    '++++ not a header',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-old',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), { 'a.ts': ['// note', '+++ not a header'] });
});

const db = openDb(join(home, 'agentdeck.db'));
after(() => db.close());

const dir = join(home, 'demo');
mkdirSync(dir);
const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'test@example.com');
sh('config', 'user.name', 'test');
writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'base');
const demo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });

test("the workspace reads a branch's added lines per path against the base", async () => {
  sh('checkout', '-q', '-b', 'task');
  writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n// why\nconst b = 2;\n');
  writeFileSync(join(dir, 'b file.py'), '# note\nx = 1\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'work');
  sh('checkout', '-q', 'main');
  writeFileSync(join(dir, 'c.ts'), '// on main only\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'main moves on');
  const added = await db.workspace.addedLines(dir, 'main', 'task');
  assert.deepEqual(added, { 'a.ts': ['// why', 'const b = 2;'], 'b file.py': ['# note', 'x = 1'] });
  assert.equal(countCodeComments(added!).lines, 2);
  assert.equal(await db.workspace.addedLines(dir, 'nope', 'task'), null);
});

test('repo code comment limits: 5 and 5 by default, set from the CLI, shown by repo ls, validated with the range', async () => {
  assert.deepEqual([demo.code_comment_max_lines, demo.code_comment_max_percent], [5, 5]);
  assert.equal(await inProcess(['set', 'demo', 'code_comment_max_lines', '3']), 'demo: code_comment_max_lines 3');
  assert.equal(db.findRepo('demo')!.code_comment_max_lines, 3);
  assert.match(await inProcess(['ls']), /code_comments=3 lines\/5%/);
  const set = (key: string, value: string) => updateRepo(db, 'demo', repoSettingPatch(key, value));
  assert.equal(set('code_comment_max_percent', '0').code_comment_max_percent, 0);
  assert.equal(set('code_comment_max_lines', '0').code_comment_max_lines, 0);
  assert.match(await inProcess(['ls']), /code_comments=off/);
  assert.throws(() => set('code_comment_max_lines', '-1'), /code_comment_max_lines must be a whole number from 0 to 10000/);
  assert.throws(() => set('code_comment_max_percent', '101'), /code_comment_max_percent must be a whole number from 0 to 100/);
  assert.throws(() => set('code_comment_max_lines', 'lots'), ActionError);
});

async function inProcess(rest: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (m: unknown) => void out.push(String(m));
  try {
    await repoCommands.repo({ db, cmd: 'repo', rest, flags: {}, repoName: () => 'demo' } as never);
  } finally {
    console.log = log;
  }
  return out.join('\n');
}
