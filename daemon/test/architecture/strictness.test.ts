// Strict types under daemon/src and app/src, and a deterministic domain, checked with the TypeScript compiler (daemon/scripts/lib/strictness.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STRICTNESS_EXCEPTIONS } from '../../scripts/lib/progress.ts';
import {
  type StrictFile,
  checkStrictness,
  projectOptions,
  readStrictnessOffences,
  strictnessOffences,
} from '../../scripts/lib/strictness.ts';

const offences = readStrictnessOffences();

const sample = (files: StrictFile[]) => checkStrictness(strictnessOffences(files, projectOptions('daemon')), []);

test('[strict-types, domain-deterministic] no any, !, open switch, or clock in domain/, beyond the listed files, and no stale entry', () => {
  const { found, stale } = checkStrictness(offences, STRICTNESS_EXCEPTIONS);
  assert.deepEqual([...found, ...stale], []);
});

test('[strict-types] a sample with an any, a non-null assertion or a switch missing a case fails, naming the file and line', () => {
  const { found } = sample([
    {
      path: 'daemon/src/application/work/x.ts',
      text: [
        'export const x: any = 1;',
        'export const y = (a: { b?: { c: number } }) => a.b!.c;',
        "export type K = 'a' | 'b' | 'c';",
        'export function z(k: K): number {',
        '  switch (k) {',
        "    case 'a':",
        '      return 1;',
        "    case 'b':",
        '      return 2;',
        '    default:',
        '      return 0;',
        '  }',
        '}',
        'export const w = 2 as any;',
        '',
      ].join('\n'),
    },
  ]);
  assert.equal(found.length, 4);
  assert.match(found[0], /^daemon\/src\/application\/work\/x\.ts:1 uses an explicit any.*\(rule:strict-types\)/);
  assert.match(found[1], /^daemon\/src\/application\/work\/x\.ts:2 uses a non-null assertion.*\(rule:strict-types\)/);
  assert.match(found[2], /^daemon\/src\/application\/work\/x\.ts:5 switches on a union of literals.*\(rule:strict-types\)/);
  assert.match(found[3], /^daemon\/src\/application\/work\/x\.ts:14 uses an explicit any/);
});

test('[strict-types] a switch that covers every member, or ends in a default assigning to never, passes; so does one on a string', () => {
  const { found } = sample([
    {
      path: 'daemon/src/application/work/x.ts',
      text: [
        "export type K = 'a' | 'b';",
        'export function all(k: K): number {',
        '  switch (k) {',
        "    case 'a':",
        '      return 1;',
        "    case 'b':",
        '      return 2;',
        '  }',
        '}',
        'export function never(k: K): number {',
        '  switch (k) {',
        "    case 'a':",
        "    case 'b':",
        '      return 1;',
        '    default: {',
        '      const left: never = k;',
        '      return left;',
        '    }',
        '  }',
        '}',
        'export function open(s: string): number {',
        '  switch (s) {',
        "    case 'a':",
        '      return 1;',
        '    default:',
        '      return 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(found, []);
});

test('[domain-deterministic] a sample reading the clock, randomness, crypto or process in domain/ fails; outside domain/ it passes', () => {
  const text = [
    'export const a = Date.now();',
    'export const b = new Date();',
    'export const c = Math.random();',
    'export const d = crypto.randomUUID();',
    'export const e = process.env.HOME;',
    "export const f = new Date('2026-01-01T00:00:00Z');",
    'export const g = { process: 1, now: Date.parse("2026-01-01") };',
    '',
  ].join('\n');
  const { found } = sample([
    { path: 'daemon/src/domain/work/x.ts', text },
    { path: 'daemon/src/application/work/y.ts', text },
  ]);
  assert.equal(found.length, 5);
  for (const [i, line] of [1, 2, 3, 4, 5].entries())
    assert.match(found[i], new RegExp(`^daemon/src/domain/work/x\\.ts:${line} .*\\(rule:domain-deterministic\\)`));
});

test('[strict-types] a listed file may keep its offence; an entry that no longer applies fails', () => {
  const found = [{ file: 'daemon/src/a.ts', line: 3, kind: 'any' as const, rule: 'strict-types' as const, text: 'any' }];
  assert.deepEqual(checkStrictness(found, ['daemon/src/a.ts: any']), { found: [], stale: [] });
  const stale = checkStrictness(found, ['daemon/src/a.ts: any', 'daemon/src/b.ts: non-null']);
  assert.equal(stale.stale.length, 1);
  assert.match(stale.stale[0], /daemon\/src\/b\.ts: non-null" is on STRICTNESS_EXCEPTIONS but no longer applies/);
});
