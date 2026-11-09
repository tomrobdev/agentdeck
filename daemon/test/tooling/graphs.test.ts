// The context map and the adapter-use table, on small sample sources.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterUseBody, contextMapBody } from '../../scripts/lib/architecture-docs.ts';
import { adapterUse, contextMap } from '../../scripts/lib/graphs.ts';
import { parseSource } from '../../scripts/lib/sources.ts';

const src = (path: string, text: string) => parseSource(path, text);

test('context map: a type-only edge is drawn dotted, a runtime one solid', () => {
  const sources = [
    src('domain/task/a.ts', "import { x } from '../repo/b.ts';\nimport type { Y } from '../run/c.ts';\nexport const a = 1;"),
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
    src('domain/task/a.ts', "import { b } from '../repo/b.ts';\nimport type { B } from '../repo/b.ts';\nexport const a = 1;"),
    src('domain/repo/b.ts', "import type { A } from '../task/a.ts';\nexport const b = 1;"),
    src('domain/run/c.ts', "import { a } from '../task/a.ts';\nexport const c = 1;"),
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

test('adapter use: each application area lists the adapters it imports', () => {
  const sources = [
    src('application/run/worker.ts', "import { a } from '../../adapters/git.ts';\nimport { b } from '../../adapters/claude.ts';"),
    src('application/run/other.ts', "import { a } from '../../adapters/git.ts';"),
    src('application/planner.ts', "import { c } from '../adapters/claude.ts';\nimport { d } from '../db/index.ts';"),
    src('application/settings.ts', "import { d } from '../db/index.ts';"),
  ];
  assert.deepEqual(adapterUse(sources), [
    { area: 'planner.ts', adapters: [{ adapter: 'claude.ts', imports: 1 }] },
    {
      area: 'run',
      adapters: [
        { adapter: 'claude.ts', imports: 1 },
        { adapter: 'git.ts', imports: 2 },
      ],
    },
  ]);
  assert.match(adapterUseBody(sources), /`application\/run`\s+\| `claude\.ts`, `git\.ts` \(2\)/);
});
