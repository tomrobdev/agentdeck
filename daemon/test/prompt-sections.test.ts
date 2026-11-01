import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePromptSections, promptSection, SECTION_NAMES } from '../src/domain/task/sections.ts';
import { PROMPT_SECTIONS } from '../src/domain/task/task.ts';

const heading = `## Goal
Cache reads.

## Context
See daemon/src/db/tasks.ts.

- one
- two

## Definition of done
Tests pass.`;

const old = `Goal: Cache reads.
Context: See daemon/src/db/tasks.ts.

- one
- two
Definition of done: Tests pass.`;

test('heading form splits into sections', () => {
  const p = parsePromptSections(heading);
  assert.equal(p.preamble, '');
  assert.deepEqual(
    p.sections.map((s) => s.name),
    ['Goal', 'Context', 'Definition of done'],
  );
  assert.equal(p.sections[1].body, 'See daemon/src/db/tasks.ts.\n\n- one\n- two');
});

test('old "Goal:" form gives the same sections', () => {
  const p = parsePromptSections(old);
  assert.deepEqual(
    p.sections.map((s) => [s.name, s.body.split('\n')[0]]),
    [
      ['Goal', 'Cache reads.'],
      ['Context', 'See daemon/src/db/tasks.ts.'],
      ['Definition of done', 'Tests pass.'],
    ],
  );
  assert.equal(promptSection(old, 'Definition of done'), 'Tests pass.');
});

test('promptSection finds a section by name in either form, case-insensitively', () => {
  assert.equal(promptSection(heading, 'Goal'), 'Cache reads.');
  assert.equal(promptSection(heading, 'out of scope'), null);
  assert.equal(promptSection(old, 'goal'), 'Cache reads.');
});

test('text before the first section is the preamble; no sections leaves it all there', () => {
  assert.equal(parsePromptSections('Intro line\n## Goal\nx').preamble, 'Intro line');
  assert.deepEqual(parsePromptSections('just do it'), { preamble: 'just do it', sections: [] });
});

test('other headings and colons stay in the body; fenced code is left alone', () => {
  const p = parsePromptSections('## Goal\nNote: be kind\n### Sub\nmore\n```\nGoal: fake\n## Change\n```\n');
  assert.deepEqual(
    p.sections.map((s) => s.name),
    ['Goal'],
  );
  assert.match(p.sections[0].body, /Note: be kind\n### Sub\nmore\n```\nGoal: fake\n## Change\n```/);
});

test('PROMPT_SECTIONS lists every section name as a heading, in order', () => {
  const headings = [...PROMPT_SECTIONS.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, SECTION_NAMES);
});
