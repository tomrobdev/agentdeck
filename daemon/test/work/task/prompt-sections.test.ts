// A task prompt's sections, pure: one parser for ## headings and Heading: label lines, old names and new, and the shape a saved prompt takes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT_SECTIONS, promptSection, shapePrompt } from '#domain/work/index.ts';
import { parsePrompt } from '#domain/work/task/prompt.ts';

test('the format is Current problem, Expected outcome, Out of scope and Constraints, in that order', () => {
  assert.deepEqual(
    [...PROMPT_SECTIONS.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    ['Current problem', 'Expected outcome', 'Out of scope', 'Constraints'],
  );
});

test('## headings under new names are read as they are, and the text before the first is kept', () => {
  assert.deepEqual(parsePrompt('Intro line.\n\n## Current problem\nBroken.\n\n## Expected outcome\n- fixed'), {
    preamble: 'Intro line.',
    sections: [
      { name: 'Current problem', heading: 'Current problem', body: 'Broken.' },
      { name: 'Expected outcome', heading: 'Expected outcome', body: '- fixed' },
    ],
  });
});

test('label lines and old names map to the new names; Change stays its own section', () => {
  const parsed = parsePrompt('Goal: Ship it.\nContext:\nsrc/a.ts\nChange: Edit a.\nDefinition of done:\n- tests pass');
  assert.deepEqual(
    parsed.sections.map((s) => [s.name, s.heading, s.body]),
    [
      ['Current problem', 'Goal', 'Ship it.'],
      ['Current problem', 'Context', 'src/a.ts'],
      ['Change', 'Change', 'Edit a.'],
      ['Expected outcome', 'Definition of done', '- tests pass'],
    ],
  );
  assert.equal(parsed.preamble, '');
});

test('a label that is not a section name, a label mid-line and a heading in a code fence stay text', () => {
  const parsed = parsePrompt('## Current problem\nNote: this is text.\nSee Goal: here.\n```\n## Goal\n```');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].body, 'Note: this is text.\nSee Goal: here.\n```\n## Goal\n```');
});

test('a prompt with no sections is all preamble', () => {
  assert.deepEqual(parsePrompt('Just fix the typo.\n'), { preamble: 'Just fix the typo.', sections: [] });
  assert.deepEqual(parsePrompt(''), { preamble: '', sections: [] });
});

test('promptSection finds a section by its new name or the heading written, joining sections of one name, or null', () => {
  const prompt = '## Goal\nShip it.\n\n## Context\nsrc/a.ts\n\n## Definition of done\n- passes\n\n## Change\n';
  assert.equal(promptSection(prompt, 'goal'), 'Ship it.');
  assert.equal(promptSection(prompt, 'Current problem'), 'Ship it.\n\nsrc/a.ts');
  assert.equal(promptSection(prompt, 'Expected outcome'), '- passes');
  assert.equal(promptSection(prompt, 'Change'), null, 'an empty section is none');
  assert.equal(promptSection('No sections.', 'Current problem'), null);
});

test('a saved prompt gets ## headings in the new order and names, with the preamble first', () => {
  const shaped = shapePrompt(
    'Read this first.\nConstraints: no deps\nDefinition of done:\n- tests pass\nGoal: Ship it.\n## Notes\nextra\nContext: src/a.ts',
  );
  assert.equal(
    shaped.prompt,
    'Read this first.\n\n## Current problem\nShip it.\n\nsrc/a.ts\n\n## Expected outcome\n- tests pass\n\n## Constraints\nno deps\n\n## Notes\nextra',
  );
  assert.deepEqual(shaped.warnings, []);
  assert.equal(shapePrompt(shaped.prompt).prompt, shaped.prompt, 'shaping twice changes nothing');
});

test('a missing Current problem or Expected outcome is a warning, not a refusal', () => {
  assert.deepEqual(shapePrompt('## Goal\nShip it.').warnings, ['the prompt has no ## Expected outcome section']);
  assert.deepEqual(shapePrompt('## Current problem\n\n## Out of scope\nx').warnings, [
    'the prompt has no ## Current problem section',
    'the prompt has no ## Expected outcome section',
  ]);
});

test('a prompt with no sections is kept as written, with a warning', () => {
  const written = 'Fix the typo\nin README.md  ';
  assert.deepEqual(shapePrompt(written), {
    prompt: written,
    warnings: ['the prompt has no sections; write it under ## Current problem and ## Expected outcome'],
  });
});
