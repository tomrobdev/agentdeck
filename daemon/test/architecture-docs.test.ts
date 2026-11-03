// docs/architecture.md: its generated blocks match the code, and its hand-written sections name things that exist.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDocs, renderDocs, section } from '../scripts/lib/architecture-docs.ts';
import { exportedNames, readSources } from '../scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../src');

test('docs/architecture.md matches the code', () => {
  const docs = readDocs();
  assert.ok(renderDocs(docs) === docs, 'docs/architecture.md is stale: run `pnpm docs:gen` and commit the result');
});

test('docs: generating twice changes nothing', () => {
  const once = renderDocs(readDocs());
  assert.equal(renderDocs(once), once);
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
  const unknown: string[] = [];
  for (const heading of ['System context', "One task's run"]) {
    for (const m of section(docs, heading).matchAll(/`([^`\n]+)`/g)) {
      const name = m[1].replace(/\(\)$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name) && !exported.has(name)) unknown.push(`${heading}: \`${m[1]}\``);
    }
  }
  assert.deepEqual(unknown, [], 'not exported from daemon/src; rename it in docs/architecture.md');
});
