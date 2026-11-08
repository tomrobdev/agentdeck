// The review areas (docs/review-areas.md) stay current: every path they list exists, and every source file is in an area,
// so an area review never starts from a stale map and a new file is never left out of every review.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '../..');
const MAP = 'docs/review-areas.md';

/** Source files no area covers, each with why. Prefer adding the file to an area. */
const UNMAPPED: Record<string, string> = {};

/** The areas in the map, in order, each with its path prefixes and the line each is on. */
function readAreas(): { name: string; paths: { path: string; line: number }[] }[] {
  const areas: ReturnType<typeof readAreas> = [];
  for (const [i, line] of readFileSync(join(ROOT, MAP), 'utf8').split('\n').entries()) {
    const heading = /^## (\S+)\s*$/.exec(line);
    if (heading) areas.push({ name: heading[1], paths: [] });
    const item = /^- (\S+)\s*$/.exec(line);
    if (item && areas.length) areas.at(-1)!.paths.push({ path: item[1], line: i + 1 });
  }
  return areas;
}

/** The source files git tracks, or would once added: what an area review can be asked about. */
function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'daemon/src', 'app/src'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((f) => f && existsSync(join(ROOT, f)));
}

const covers = (prefix: string, file: string): boolean => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix);

test('[review-areas] every path the review areas list exists', () => {
  const missing = readAreas().flatMap((a) =>
    a.paths.filter((p) => !existsSync(join(ROOT, p.path))).map((p) => `${MAP}:${p.line} (${a.name}): ${p.path}`),
  );
  assert.deepEqual(missing, [], `paths in ${MAP} that no longer exist; move them to where the code went:\n${missing.join('\n')}`);
});

test('[review-areas] every source file is in a review area', () => {
  const areas = readAreas();
  const prefixes = areas.flatMap((a) => a.paths.map((p) => ({ area: a.name, path: p.path })));
  const unmapped = sourceFiles().filter((f) => !UNMAPPED[f] && !prefixes.some((p) => covers(p.path, f)));
  /** The areas holding the most files from the same folder: where a new file most likely belongs. */
  const nearest = (file: string): string => {
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    const near = [...new Set(prefixes.filter((p) => p.path.startsWith(dir)).map((p) => p.area))];
    return near.length ? ` (its folder is in ${near.join(', ')})` : '';
  };
  assert.deepEqual(
    unmapped.map((f) => `${f}${nearest(f)}`),
    [],
    `source files in no area of ${MAP}; add each under the area it belongs to:\n${unmapped.map((f) => `${f}${nearest(f)}`).join('\n')}`,
  );
});

test('[review-areas] the unmapped list names only files that exist and no area covers', () => {
  const prefixes = readAreas().flatMap((a) => a.paths.map((p) => p.path));
  const stale = Object.keys(UNMAPPED).filter((f) => !existsSync(join(ROOT, f)) || prefixes.some((p) => covers(p, f)));
  assert.deepEqual(stale, [], `entries on UNMAPPED that no longer apply: ${stale.join(', ')}`);
});

test('[review-areas] area names are unique', () => {
  const names = readAreas().map((a) => a.name);
  assert.deepEqual(
    names.filter((n, i) => names.indexOf(n) !== i),
    [],
    'each area needs a name of its own: refs/reviewed/<name> marks its last review',
  );
});
