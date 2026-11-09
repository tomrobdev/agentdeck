// Ids are branded numbers (domain/shared/id.ts). The compile checks run in `pnpm typecheck`: a line marked @ts-expect-error that compiles fails it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { type PlannerRunId, type RepoId, type TaskId, asRepoId, asTaskId, parseId } from '../src/domain/shared/id.ts';
import { lineOf, readSources } from '../scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../src');

const takesTask = (id: TaskId): TaskId => id;
const takesRepo = (id: RepoId): RepoId => id;

test('[branded-ids] a RepoId passed where a TaskId is wanted fails the type check', () => {
  const repo = asRepoId(1);
  // @ts-expect-error a RepoId is not a TaskId
  takesTask(repo);
  const task = asTaskId(1);
  // @ts-expect-error a TaskId is not a RepoId
  takesRepo(task);
  // @ts-expect-error a plain number is not an id
  takesTask(1);
  const run: PlannerRunId | null = null;
  // @ts-expect-error a PlannerRunId is not a TaskId
  takesTask(run);
  assert.equal(takesTask(task), 1);
});

test('[branded-ids] parseId reads a whole number above 0, with or without #', () => {
  assert.equal(parseId<TaskId>('12'), 12);
  assert.equal(parseId<TaskId>('#12'), 12);
  assert.equal(parseId<TaskId>(12), 12);
  for (const bad of ['0', '-1', '1.5', 'x', '', 1.5, 0, null, undefined, {}]) assert.equal(parseId<TaskId>(bad), null, String(bad));
});

test('[branded-ids] a domain or contract field named …_id or …Id is not typed number', () => {
  const found: string[] = [];
  const named = /(_ids?|Ids?)$/;
  const isNumber = (t: ts.TypeNode): boolean =>
    t.kind === ts.SyntaxKind.NumberKeyword ||
    (ts.isArrayTypeNode(t) && isNumber(t.elementType)) ||
    (ts.isUnionTypeNode(t) && t.types.some(isNumber)) ||
    (ts.isParenthesizedTypeNode(t) && isNumber(t.type));
  for (const s of readSources(SRC)) {
    if (!s.path.startsWith('domain/') && !s.path.startsWith('api/contract/')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertySignature(node) && node.type && ts.isIdentifier(node.name) && named.test(node.name.text) && isNumber(node.type)) {
        found.push(
          `${s.path}:${lineOf(s.ast, node)} ${node.name.text} is typed number: use TaskId, RepoId, RunId, ReviewId or PlannerRunId`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  assert.deepEqual(found, []);
});
