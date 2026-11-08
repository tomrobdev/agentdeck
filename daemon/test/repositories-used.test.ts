// The repository interfaces in application/ports/repositories.ts list what the use cases call and no more, and the
// database's stores satisfy them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Repositories } from '../src/application/ports/repositories.ts';
import type { Db } from '../src/db/index.ts';
import { readSources } from '../scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../src');

/** Compile-time: what `openDb` returns satisfies `Repositories`. */
export const satisfied = (db: Db): Repositories => db;

test('[layers] every method an interface declares is called by a use case', () => {
  const ports = readFileSync(join(SRC, 'application/ports/repositories.ts'), 'utf8');
  // Interface members are the lines at two spaces' indent that name a method: `name(` or `name<`.
  const declared = [...ports.matchAll(/^export interface (\w+Repository) \{([\s\S]*?)^\}/gm)].flatMap((m) =>
    [...m[2].matchAll(/^  (\w+)[(<]/gm)].map((n) => ({ repository: m[1], name: n[1] })),
  );
  assert.ok(declared.length > 50, 'found the interfaces');
  const code = readSources(SRC)
    .filter((s) => s.path.startsWith('application/') && !s.path.startsWith('application/ports/'))
    .map((s) => readFileSync(join(SRC, s.path), 'utf8'))
    .join('\n');
  const unused = declared.filter((d) => !new RegExp(`\\.${d.name}\\b`).test(code)).map((d) => `${d.repository}.${d.name}`);
  assert.deepEqual(unused, [], 'declared in a repository interface but no use case calls it: remove it from the interface');
});
