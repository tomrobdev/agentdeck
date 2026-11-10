// The review run's decisions, pure: its prompt, the schema and parsing of its answer, its verdict and how it is stored.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { asTaskId } from '../../../src/domain/shared/id.ts';
import {
  REVIEW_ANSWER_SCHEMA,
  buildReviewPrompt,
  parseReviewAnswer,
  promptSection,
  reviewDiffCommand,
  reviewRecord,
  reviewSchemaArgs,
  reviewVerdict,
} from '../../../src/domain/runs/review.ts';
import { diffHash } from '../../../src/adapters/git/diffs.ts';

const PROMPT = `## Goal
Count the words in a file.

## Context
src/count.ts.

## Out of scope
Anything else.

## Definition of done
- count('a b') is 2
- the test command passes`;

const PLAN = `<!doctype html>
<html data-agentdeck-plan="1"><head><title>Counting</title></head><body>
  <p data-plan-summary>Count things.</p>
  <section data-plan-step id="words" data-status="done"><h2>Count words</h2><p>Split on whitespace.</p>
    <ul data-plan-done><li>Empty input counts 0</li><li>Tabs split words</li></ul></section>
  <section data-plan-step id="lines" data-status="todo"><h2>Count lines</h2><p>Not this task.</p></section>
</body></html>`;

const task = { id: asTaskId(7), title: 'Count words', prompt: PROMPT };
const ctx = { plan: { name: '1-counting.html', html: PLAN, steps: ['words'] }, from: 'abc123', head: 'def456' };

test('promptSection reads one ## section of a task prompt, or null', () => {
  assert.equal(promptSection(PROMPT, 'Goal'), 'Count the words in a file.');
  assert.equal(promptSection(PROMPT, 'definition of done'), "- count('a b') is 2\n- the test command passes");
  assert.equal(promptSection(PROMPT, 'Change'), null);
  assert.equal(promptSection('## Goal\n\n## Change\nx', 'Goal'), null, 'an empty section is none');
});

test("the prompt has the task's Goal, Definition of done, linked plan steps with their done criteria, and the diff command", () => {
  const prompt = buildReviewPrompt(task, ctx);
  assert.match(prompt, /^AgentDeck review run for task #7: "Count words"\./);
  assert.match(prompt, /## Goal\nCount the words in a file\./);
  assert.match(prompt, /## Definition of done\n- count\('a b'\) is 2\n- the test command passes/);
  assert.match(prompt, /## Plan steps\nThe task's plan steps \(1-counting\.html\):/);
  assert.match(
    prompt,
    /Step "words": Count words \(status: done\)\nSplit on whitespace\.\nDone when:\n- Empty input counts 0\n- Tabs split words/,
  );
  assert.doesNotMatch(prompt, /Count lines/, 'only the linked steps');
  assert.equal(reviewDiffCommand(ctx), 'git diff abc123 def456');
  assert.ok(prompt.includes('`git diff abc123 def456`'));
  assert.doesNotMatch(prompt, /## Context|src\/count\.ts/, 'only what the changes are judged against');
});

test('a prompt with no Goal reads the whole task; no plan and no Definition of done leave their sections out', () => {
  const prompt = buildReviewPrompt({ ...task, prompt: 'Just fix the typo.' }, { ...ctx, plan: null });
  assert.match(prompt, /## Goal\nJust fix the typo\./);
  assert.doesNotMatch(prompt, /## Definition of done|## Plan steps/);
  const unread = buildReviewPrompt(task, { ...ctx, plan: { name: 'x.html', html: null, steps: null } });
  assert.match(unread, /follows the plan x\.html, which could not be read/);
});

test('the answer schema requires a non-empty summary and every field of a finding, and goes to claude as --json-schema', () => {
  assert.deepEqual(REVIEW_ANSWER_SCHEMA.required, ['summary', 'findings']);
  assert.equal(REVIEW_ANSWER_SCHEMA.properties.summary.minLength, 1);
  assert.deepEqual(REVIEW_ANSWER_SCHEMA.properties.findings.items.required, ['path', 'line', 'side', 'body', 'blocking']);
  assert.deepEqual(REVIEW_ANSWER_SCHEMA.properties.findings.items.properties.side.enum, ['old', 'new']);
  const args = reviewSchemaArgs();
  assert.equal(args[0], '--json-schema');
  assert.deepEqual(JSON.parse(args[1]), REVIEW_ANSWER_SCHEMA);
});

const good = {
  summary: 'Counts words; misses tabs.',
  findings: [
    { path: 'src/count.ts', line: 3, side: 'new', body: 'Split on /\\s+/ so tabs count.', blocking: true },
    { path: 'src/count.ts', line: 1, side: 'old', body: 'The old import is unused.', blocking: false },
  ],
};

test('parseReviewAnswer: a good answer, as structured output, JSON text or a fenced block', () => {
  assert.deepEqual(parseReviewAnswer(good), good);
  assert.deepEqual(parseReviewAnswer(JSON.stringify(good)), good);
  assert.deepEqual(parseReviewAnswer(`Here it is:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n`), good);
  assert.deepEqual(parseReviewAnswer({ summary: '  All good.  ', findings: [] }), { summary: 'All good.', findings: [] });
});

test('parseReviewAnswer: a partial answer keeps what it can, and a finding that does not say blocks', () => {
  const answer = parseReviewAnswer({
    summary: 'Mostly fine.',
    findings: [
      { path: 'a.ts', line: 2, body: 'no side, no blocking' },
      { path: 'b.ts', line: '4', side: 'old', body: 'line as text', blocking: false },
      { path: '', line: 1, body: 'no path', blocking: true },
      { path: 'c.ts', line: 0, body: 'no line', blocking: true },
      { path: 'd.ts', line: 1.5, body: 'not a whole line', blocking: true },
      { path: 'e.ts', line: 1, body: '   ', blocking: true },
      'not a finding',
    ],
  });
  assert.deepEqual(answer, {
    summary: 'Mostly fine.',
    findings: [
      { path: 'a.ts', line: 2, side: 'new', body: 'no side, no blocking', blocking: true },
      { path: 'b.ts', line: 4, side: 'old', body: 'line as text', blocking: false },
    ],
  });
  assert.deepEqual(parseReviewAnswer({ summary: 'No findings field.' }), { summary: 'No findings field.', findings: [] });
});

test('parseReviewAnswer: garbage is null', () => {
  for (const raw of [null, undefined, '', 'LGTM', '{not json', '[]', 42, [good], { findings: [] }, { summary: '  ', findings: [] }]) {
    assert.equal(parseReviewAnswer(raw), null, JSON.stringify(raw));
  }
});

test('reviewVerdict: clean when no finding blocks', () => {
  assert.equal(reviewVerdict({ findings: [] }), 'clean');
  assert.equal(reviewVerdict({ findings: [{ ...good.findings[1], side: 'old' }] }), 'clean');
  assert.equal(reviewVerdict(parseReviewAnswer(good)!), 'blocking');
});

test('reviewRecord: a clean answer is a Comment, a blocking one Request changes, with the summary as its note', () => {
  const clean = reviewRecord({ summary: 'Fine.', findings: [{ path: 'a.ts', line: 1, side: 'new', body: 'nit', blocking: false }] });
  assert.deepEqual(clean, { kind: 'comment', body: 'Fine.', comments: [{ path: 'a.ts', line: 1, side: 'new', body: 'nit' }] });
  const blocking = reviewRecord(parseReviewAnswer(good)!);
  assert.equal(blocking.kind, 'request_changes');
  assert.equal(blocking.body, 'Counts words; misses tabs.');
  assert.deepEqual(
    blocking.comments.map((c) => c.body),
    ['Blocking: Split on /\\s+/ so tabs count.', 'The old import is unused.'],
  );
});

test("diffHash: the patch-id of a branch's changes, kept by a sync that only brings in the base", () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-review-hash-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return (async () => {
    assert.equal(await diffHash(dir, 'main', 'main'), null, 'no changes, no hash');
    git('checkout', '-q', '-b', 'task');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    git('commit', '-q', '-am', 'task work');
    const before = await diffHash(dir, 'main', 'task');
    assert.match(before ?? '', /^[0-9a-f]{40}$/);

    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'b.txt'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base moves on');
    git('checkout', '-q', 'task');
    git('merge', '-q', '--no-edit', 'main');
    assert.equal(await diffHash(dir, 'main', 'task'), before, 'the sync brought in only the base');

    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    git('commit', '-q', '-am', 'more work');
    assert.notEqual(await diffHash(dir, 'main', 'task'), before, 'new changes, new hash');
  })();
});
