// docs/architecture.md and docs/reference/: the generated parts match the code, and the hand-written parts name things that exist.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REFERENCE_DIR, generateReference, readDocs, renderDocs, section } from '../scripts/lib/architecture-docs.ts';
import { exportedNames, readSources } from '../scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../src');
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
  assert.ok(lines <= 150, `docs/architecture.md is ${lines} lines; keep it at 150 or fewer and move detail to docs/reference/`);
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
  const missing = readdirSync(join(SRC, 'adapters'))
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
    ["One task's run", section(docs, "One task's run")],
    ['reference/runs.md', readFileSync(join(REFERENCE_DIR, 'runs.md'), 'utf8')],
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
