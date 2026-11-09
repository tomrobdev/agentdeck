// rule:coverage-floors. Line and branch coverage of daemon/src, grouped by layer and context, against the floors in COVERAGE_FLOORS
// (`progress.ts`). Pure: `pnpm coverage` (scripts/coverage.ts) runs the tests and hands the lcov text here.
import ts from 'typescript';
import type { Source } from './sources.ts';

/** A group's floors: the least line and branch coverage it may have, in whole percents. */
export interface Floor {
  lines: number;
  branches: number;
}

/** Hit and found counts of one file, or of a group of files. */
export interface Counts {
  lines: { hit: number; found: number };
  branches: { hit: number; found: number };
}

export interface FileCoverage extends Counts {
  /** Relative to daemon/src, e.g. `domain/work/task/task.ts`. */
  path: string;
}

export interface GroupCoverage extends Counts {
  group: string;
  files: number;
}

/** A floor beaten by more than this many points should be raised. */
export const RAISE_MARGIN = 2;

/**
 * The group a file under daemon/src belongs to: `domain/<context>` and `application/<context>` for their folders, `application` for
 * the files directly in it (`actions.ts`), the layer for `db/`, `adapters/`, `api/` and `cli/`, and `src` for the files at the top.
 */
export function groupOf(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return 'src';
  if ((parts[0] === 'domain' || parts[0] === 'application') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/** A path from an lcov `SF:` line, relative to daemon/src; null for a file outside it. */
function srcPath(file: string): string | null {
  const normal = file.replace(/\\/g, '/');
  const at = normal.lastIndexOf('daemon/src/');
  if (at >= 0) return normal.slice(at + 'daemon/src/'.length);
  return normal.startsWith('src/') ? normal.slice('src/'.length) : null;
}

/** The files of an lcov report under daemon/src, with their line and branch counts. */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (key === 'SF') {
      const path = srcPath(value);
      current = path === null ? null : { path, lines: { hit: 0, found: 0 }, branches: { hit: 0, found: 0 } };
    } else if (key === 'end_of_record') {
      if (current) files.push(current);
      current = null;
    } else if (current) {
      if (key === 'LF') current.lines.found = Number(value);
      else if (key === 'LH') current.lines.hit = Number(value);
      else if (key === 'BRF') current.branches.found = Number(value);
      else if (key === 'BRH') current.branches.hit = Number(value);
    }
  }
  return files;
}

/** The files' counts summed per group, sorted by group. */
export function groupCoverage(files: FileCoverage[]): GroupCoverage[] {
  const groups = new Map<string, GroupCoverage>();
  for (const f of files) {
    const name = groupOf(f.path);
    const g = groups.get(name) ?? { group: name, files: 0, lines: { hit: 0, found: 0 }, branches: { hit: 0, found: 0 } };
    g.files++;
    g.lines.hit += f.lines.hit;
    g.lines.found += f.lines.found;
    g.branches.hit += f.branches.hit;
    g.branches.found += f.branches.found;
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

/** Hit over found as a percent; 100 when there is nothing to hit. */
export const percent = (c: { hit: number; found: number }) => (c.found ? (100 * c.hit) / c.found : 100);

/** A percent to one decimal, rounded down, so 99.96% never shows as a 100% it has not reached. */
export const showPercent = (p: number) => `${(Math.floor(p * 10) / 10).toFixed(1)}%`;

/** The groups below a floor, the groups and floors that do not match up, and the floors to raise. Each message names its group. */
export function judgeCoverage(groups: GroupCoverage[], floors: Record<string, Floor>): { failures: string[]; raise: string[] } {
  const failures: string[] = [];
  const raise: string[] = [];
  for (const g of groups) {
    const floor = floors[g.group];
    if (!floor) {
      failures.push(`${g.group} has no floor: add it to COVERAGE_FLOORS in daemon/scripts/lib/progress.ts, at its numbers rounded down`);
      continue;
    }
    for (const metric of ['lines', 'branches'] as const) {
      const now = percent(g[metric]);
      if (now < floor[metric])
        failures.push(
          `${g.group}: ${metric} ${showPercent(now)} is below its floor of ${floor[metric]}%: add tests, never lower the floor`,
        );
      else if (now - floor[metric] > RAISE_MARGIN)
        raise.push(`${g.group}: ${metric} ${showPercent(now)} beats its floor of ${floor[metric]}%: raise it to ${Math.floor(now)}`);
    }
  }
  for (const group of Object.keys(floors)) {
    if (!groups.some((g) => g.group === group))
      failures.push(`${group} is on COVERAGE_FLOORS but no measured file is in it: remove the entry`);
  }
  return { failures, raise };
}

/** Whether a file has code that runs: anything besides types, interfaces and type-only imports and exports. Type-only files never load. */
function hasRuntimeCode(source: Source): boolean {
  return source.ast.statements.some((stmt) => {
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return false;
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      const bindings = clause?.namedBindings;
      return !(
        clause &&
        (clause.isTypeOnly || (!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every((e) => e.isTypeOnly)))
      );
    }
    if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause;
      return !(stmt.isTypeOnly || (clause && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly)));
    }
    return true;
  });
}

/** The groups of daemon/src that have code that runs, sorted: what COVERAGE_FLOORS must name, read without running the tests. */
export function groupsWithCode(sources: Source[]): string[] {
  return [...new Set(sources.filter(hasRuntimeCode).map((s) => groupOf(s.path)))].sort();
}
