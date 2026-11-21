// The context map, on small sample sources.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextMapBody } from '#scripts/lib/architecture-docs.ts';
import { contextMap } from '#scripts/lib/graphs.ts';
import { parseSource } from '#scripts/lib/sources.ts';

const src = (path: string, text: string) => parseSource(path, text);

test('context map: a type-only edge is drawn dotted, a runtime one solid', () => {
  const sources = [
    src('domain/task/a.ts', "import { x } from '#domain/repo/b.ts';\nimport type { Y } from '#domain/run/c.ts';\nexport const a = 1;"),
    src('domain/repo/b.ts', 'export const x = 1;'),
    src('domain/run/c.ts', 'export type Y = 1;'),
  ];
  const map = contextMap(sources);
  assert.deepEqual(
    map.edges.map((e) => [e.from, e.to, e.typeOnly]),
    [
      ['domain/task', 'domain/repo', false],
      ['domain/task', 'domain/run', true],
    ],
  );
  const body = contextMapBody(sources);
  assert.match(body, /domain_task --> domain_repo/);
  assert.match(body, /domain_task -\.-> domain_run/);
  assert.match(body, /No cycles\./);
});

test('context map: a cycle is marked, a runtime import beside a type-only one makes the edge runtime', () => {
  const sources = [
    src('domain/task/a.ts', "import { b } from '#domain/repo/b.ts';\nimport type { B } from '#domain/repo/b.ts';\nexport const a = 1;"),
    src('domain/repo/b.ts', "import type { A } from '#domain/task/a.ts';\nexport const b = 1;"),
    src('domain/run/c.ts', "import { a } from '#domain/task/a.ts';\nexport const c = 1;"),
  ];
  const map = contextMap(sources);
  assert.deepEqual(map.cycles, [['domain/repo', 'domain/task']]);
  assert.deepEqual(
    map.edges.map((e) => [e.from, e.to, e.typeOnly, e.inCycle]),
    [
      ['domain/repo', 'domain/task', true, true],
      ['domain/run', 'domain/task', false, false],
      ['domain/task', 'domain/repo', false, true],
    ],
  );
  const body = contextMapBody(sources);
  assert.match(body, /domain_task -->\|cycle\| domain_repo/);
  assert.match(body, /domain_repo -\.->\|cycle\| domain_task/);
  assert.match(body, /`domain\/repo` ↔ `domain\/task`/);
});
