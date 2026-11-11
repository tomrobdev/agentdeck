import ts from 'typescript';
import type { Source } from './sources.ts';

export interface Floor {
  lines: number;
  branches: number;
}

export interface Counts {
  lines: { hit: number; found: number };
  branches: { hit: number; found: number };
}

export interface FileCoverage extends Counts {
  path: string;
}

export interface GroupCoverage extends Counts {
  group: string;
  files: number;
}

export const RAISE_MARGIN = 2;

export const DASHBOARD_LIB = 'dashboard/lib/';

export function groupOf(path: string): string {
  const parts = path.split('/');
  if (path.startsWith(DASHBOARD_LIB)) return `${DASHBOARD_LIB}${parts[2]}`;
  if (parts.length === 1) return 'src';
  if ((parts[0] === 'domain' || parts[0] === 'application') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function srcPath(file: string): string | null {
  const normal = file.replace(/\\/g, '/');
  const lib = normal.lastIndexOf('app/src/lib/');
  if (lib >= 0) return `${DASHBOARD_LIB}${normal.slice(lib + 'app/src/lib/'.length)}`;
  const at = normal.lastIndexOf('daemon/src/');
  if (at >= 0) return normal.slice(at + 'daemon/src/'.length);
  return normal.startsWith('src/') ? normal.slice('src/'.length) : null;
}

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

export function withUnloaded(files: FileCoverage[], lib: { path: string; lines: number }[]): FileCoverage[] {
  const seen = new Set(files.map((f) => f.path));
  const missing = lib
    .map((f) => ({ path: `${DASHBOARD_LIB}${f.path}`, lines: { hit: 0, found: f.lines }, branches: { hit: 0, found: 0 } }))
    .filter((f) => !seen.has(f.path) && f.lines.found > 0);
  return [...files, ...missing];
}

export function dashboardLibGroups(paths: string[]): string[] {
  return [...new Set(paths.map((p) => groupOf(`${DASHBOARD_LIB}${p}`)))].sort();
}

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

export const percent = (c: { hit: number; found: number }) => (c.found ? (100 * c.hit) / c.found : 100);

export const showPercent = (p: number) => `${(Math.floor(p * 10) / 10).toFixed(1)}%`;

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

export function groupsWithCode(sources: Source[]): string[] {
  return [...new Set(sources.filter(hasRuntimeCode).map((s) => groupOf(s.path)))].sort();
}
