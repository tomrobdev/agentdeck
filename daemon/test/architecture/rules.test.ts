// Every rule in CLAUDE.md is named by a test or on the unchecked list (daemon/scripts/lib/rules.ts), and every test names real rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPT_CHECKS, UNCHECKED, readRuleLines, readRules, readTestTags } from '#scripts/lib/rules.ts';

test('every bullet in Boundaries and Rules has a rule id', () => {
  const missing = readRuleLines()
    .filter((l) => l.isBullet && !l.ids.length)
    .map((l) => `CLAUDE.md:${l.line} has no <!-- rule:ID --> at the end: ${l.text.slice(0, 50)}…`);
  assert.deepEqual(missing, []);
});

test('rule ids are unique', () => {
  const ids = readRuleLines().flatMap((l) => l.ids);
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
  );
});

test('every rule is named by a test or on the unchecked list', () => {
  const found = readRules()
    .filter((r) => !r.tests.length && r.unchecked === null)
    .map((r) => `rule ${r.id}: no test is named [${r.id}]; add one, or add it to UNCHECKED in daemon/scripts/lib/rules.ts with its reason`);
  assert.deepEqual(found, []);
});

test('a rule is not both checked and unchecked', () => {
  const found = readRules()
    .filter((r) => (r.tests.length || r.script !== null) && r.unchecked !== null)
    .map((r) => `rule ${r.id} is named by ${r.tests[0] ?? r.script} and also on the unchecked list; remove it from UNCHECKED`);
  assert.deepEqual(found, []);
});

test('tests and the unchecked list name only rules CLAUDE.md has', () => {
  const known = new Set(readRuleLines().flatMap((l) => l.ids));
  const found = [
    ...readTestTags().flatMap((t) => t.ids.filter((id) => !known.has(id)).map((id) => `${t.file}: "${t.name}" names unknown rule ${id}`)),
    ...Object.keys(UNCHECKED)
      .filter((id) => !known.has(id))
      .map((id) => `UNCHECKED lists unknown rule ${id}`),
    ...Object.keys(SCRIPT_CHECKS)
      .filter((id) => !known.has(id))
      .map((id) => `SCRIPT_CHECKS lists unknown rule ${id}`),
  ];
  assert.deepEqual(found, []);
});
