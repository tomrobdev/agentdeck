// docs/architecture.md and docs/reference/: the generated parts match the code, and the hand-written parts name things that exist.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REFERENCE_DIR, generateReference, readDocs, renderDocs, section } from '#scripts/lib/architecture-docs.ts';
import { NOT_YET_TABLES, STATE_MACHINES, readModels, readStateTypes, readUseCases } from '#scripts/lib/model-docs.ts';
import { exportedNames, readSources } from '#scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../../src');
const fix = 'run `pnpm docs:gen` and commit the result';

test('docs/architecture.md matches the code', () => {
  const docs = readDocs();
  assert.ok(renderDocs(docs) === docs, `docs/architecture.md is stale: ${fix}`);
});

test('docs/reference: each generated file matches the code', () => {
  for (const [name, content] of Object.entries(generateReference())) {
    const path = join(REFERENCE_DIR, name);
    assert.ok(existsSync(path), `docs/reference/${name} is missing: ${fix}`);
    assert.ok(readFileSync(path, 'utf8') === content, `docs/reference/${name} is stale: ${fix}`);
  }
});

test('docs: generating twice changes nothing', () => {
  const once = renderDocs(readDocs());
  assert.equal(renderDocs(once), once);
});

test('docs/architecture.md is short and opens with the layers', () => {
  const docs = readDocs();
  const lines = docs.trimEnd().split('\n').length;
  assert.ok(lines <= 160, `docs/architecture.md is ${lines} lines; keep it at 160 or fewer and move detail to docs/reference/`);
  assert.equal(/^## (.*)$/m.exec(docs)?.[1], 'Layers', 'the first ## of docs/architecture.md must be Layers');
});

test('docs/architecture.md links every file of docs/reference/', () => {
  const docs = readDocs();
  const unlinked = readdirSync(REFERENCE_DIR)
    .filter((f) => f.endsWith('.md') && !docs.includes(`](reference/${f})`))
    .map((f) => `docs/reference/${f}`);
  assert.deepEqual(unlinked, [], 'link these from the Reference section of docs/architecture.md');
});

test('docs: every adapters/*.ts file is named in the system context', () => {
  const context = section(readDocs(), 'System context');
  const missing = readdirSync(join(SRC, 'adapters'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !context.includes(`adapters/${f}`));
  assert.deepEqual(
    missing.map((f) => `adapters/${f}`),
    [],
    'name these in the System context of docs/architecture.md',
  );
});

test('docs: identifiers in backticks in the hand-written sections are exported from daemon/src', () => {
  const exported = new Set(readSources(SRC).flatMap((s) => exportedNames(s.ast)));
  const docs = readDocs();
  const texts: [string, string][] = [
    ['System context', section(docs, 'System context')],
    ['flows.md', readFileSync(join(REFERENCE_DIR, '../flows.md'), 'utf8')],
  ];
  const unknown: string[] = [];
  for (const [where, text] of texts) {
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const name = m[1].replace(/\(\)$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name) && !exported.has(name)) unknown.push(`${where}: \`${m[1]}\``);
    }
  }
  assert.deepEqual(unknown, [], 'not exported from daemon/src; rename it in the docs');
});

test('docs/reference/models.md lists every field of Task', () => {
  const task = readModels().find((m) => m.name === 'Task');
  assert.ok(task);
  const models = readFileSync(join(REFERENCE_DIR, 'models.md'), 'utf8');
  for (const f of task.fields) assert.ok(models.includes(`\`${f.name}\``), `docs/reference/models.md does not list Task.${f.name}: ${fix}`);
});

test('docs/reference/use-cases.md lists every export of actions.ts', async () => {
  const actions = await import('#application/actions.ts');
  const doc = readFileSync(join(REFERENCE_DIR, 'use-cases.md'), 'utf8');
  const names = [...new Set([...Object.keys(actions), ...readUseCases().map((u) => u.name)])];
  const missing = names.filter((n) => !doc.includes(`\`${n}\``));
  assert.deepEqual(missing, [], `these exports of application/actions.ts are not in docs/reference/use-cases.md: ${fix}`);
});

test('[state-as-data] every rule table in domain/ is listed by the generator, and every state type has one or a reason', () => {
  const { states, tables } = readStateTypes();
  const listed = STATE_MACHINES.map((m) => `${m.source.file}:${m.source.constant}`);
  const unlisted = tables.map((t) => `${t.file}:${t.constant}`).filter((t) => !listed.includes(t));
  assert.deepEqual(unlisted, [], 'add these rule tables to STATE_MACHINES in daemon/scripts/lib/model-docs.ts');
  const missing = listed.filter((l) => !tables.some((t) => `${t.file}:${t.constant}` === l));
  assert.deepEqual(missing, [], 'STATE_MACHINES names rule tables that are not in domain/');
  const tabled = STATE_MACHINES.map((m) => m.stateType);
  assert.deepEqual(
    tabled.filter((s) => !states.includes(s)),
    [],
    'STATE_MACHINES names state types that are not in domain/',
  );
  assert.deepEqual(
    tabled.filter((s) => s in NOT_YET_TABLES),
    [],
    'a state type a rule table drives has no entry in NOT_YET_TABLES',
  );
  const undecided = states.filter((s) => !(s in NOT_YET_TABLES) && !tabled.includes(s));
  assert.deepEqual(undecided, [], 'a state type needs a rule table in STATE_MACHINES, or an entry in NOT_YET_TABLES with its reason');
  const stale = Object.keys(NOT_YET_TABLES).filter((s) => !states.includes(s));
  assert.deepEqual(stale, [], 'NOT_YET_TABLES names state types that no longer exist');
});
