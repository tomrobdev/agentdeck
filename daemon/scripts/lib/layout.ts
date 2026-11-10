import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LayoutFile {
  path: string;
  lines: number;
}

export const LAYOUT_ROOTS = ['daemon/src', 'app/src', 'daemon/test'];

export const MAX_FOLDER_FILES = 12;
export const MAX_FILE_LINES = 400;

const SKIP = new Set(['node_modules', 'dist', 'target', '.DS_Store']);

export function readLayout(repoRoot: string): LayoutFile[] {
  const out: LayoutFile[] = [];
  for (const root of LAYOUT_ROOTS) {
    for (const rel of readdirSync(join(repoRoot, root), { recursive: true, encoding: 'utf8' })) {
      const path = `${root}/${rel}`;
      if (path.split('/').some((p) => SKIP.has(p)) || !statSync(join(repoRoot, path)).isFile()) continue;
      const lines = /\.(ts|vue)$/.test(path) ? readFileSync(join(repoRoot, path), 'utf8').split('\n').length - 1 : 0;
      out.push({ path, lines });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function filesByFolder(files: LayoutFile[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f.path);
    map.set(dir, [...(map.get(dir) ?? []), f.path]);
  }
  return map;
}

export function folderSizes(files: LayoutFile[]): Map<string, number> {
  return new Map(
    [...filesByFolder(files)].filter(([, list]) => list.length > MAX_FOLDER_FILES).map(([dir, list]) => [dir, list.length] as const),
  );
}

export function longFiles(files: LayoutFile[]): Map<string, number> {
  return new Map(
    files.filter((f) => f.lines > MAX_FILE_LINES && !f.path.startsWith('daemon/test/')).map((f) => [f.path, f.lines] as const),
  );
}

function checkList(
  now: Map<string, number>,
  allowed: string[],
  list: string,
  what: string,
  limit: string,
  fix: string,
): { found: string[]; stale: string[] } {
  return {
    found: [...now].filter(([path]) => !allowed.includes(path)).map(([path, n]) => `${path} has ${n} ${what}, over ${limit}: ${fix}`),
    stale: allowed.filter((path) => !now.has(path)).map((path) => `${path} is on ${list} but is within the limit: remove the entry`),
  };
}

export function checkFolderSize(files: LayoutFile[], allowed: string[]): { found: string[]; stale: string[] } {
  return checkList(
    folderSizes(files),
    allowed,
    'OVERSIZED_FOLDERS',
    'files',
    `${MAX_FOLDER_FILES}`,
    'split it into context folders (rule:folder-size)',
  );
}

export function checkFileSize(files: LayoutFile[], allowed: string[]): { found: string[]; stale: string[] } {
  return checkList(
    longFiles(files),
    allowed,
    'LONG_FILES',
    'lines',
    `${MAX_FILE_LINES}`,
    'split it into files of one concern each (rule:file-size)',
  );
}

export const CONTEXT_FOLDERS = ['work', 'runs', 'landing', 'repos', 'capacity', 'proposals', 'operations', 'insights', 'shared'];

export const PLACED_FOLDERS: Record<string, { shared: Record<string, string>; folders: string[] }> = {
  'daemon/src/db': {
    shared: {
      'index.ts': 'merges the stores into one Db and runs the migrations',
      'orm.ts': 'the Drizzle connection every store uses',
      'sql.ts': 'the raw SQL helpers every store uses',
      'schema.ts': 'the migrations, one list for every table',
      'tables.ts': 'the tables, one schema for every context',
      'mappers.ts': 'the row to model mappers of every store',
      'types-check.ts': 'checks tables, migrations and domain types agree, for every table',
      'changes.ts': 'the change feed every store writes to',
    },
    folders: CONTEXT_FOLDERS,
  },
  'daemon/src/adapters': {
    shared: {},
    folders: ['claude', 'process', 'git', 'github', 'macos', 'local'],
  },
  'daemon/src/api/routes': { shared: {}, folders: CONTEXT_FOLDERS },
  'daemon/src/cli': {
    shared: {
      'commands.ts': 'lists the commands of every group',
      'context.ts': 'parses the command line and carries the context every command gets',
      'help.ts': 'the help text of every command',
      'format.ts': 'the output helpers every command group prints with',
    },
    folders: CONTEXT_FOLDERS,
  },
  'daemon/test': {
    shared: {},
    folders: [...CONTEXT_FOLDERS, 'architecture', 'tooling', 'e2e', 'fixtures', 'api', 'cli', 'db', 'dashboard'],
  },
};

export function unplaced(files: LayoutFile[], folder: string, rule = PLACED_FOLDERS[folder]): { files: string[]; folders: string[] } {
  const prefix = `${folder}/`;
  const direct = files.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/')).map((f) => f.path);
  const sub = new Set(
    files
      .filter((f) => f.path.startsWith(prefix) && f.path.slice(prefix.length).includes('/'))
      .map((f) => f.path.slice(prefix.length).split('/')[0]),
  );
  return {
    files: direct.filter((p) => !(p.slice(prefix.length) in rule.shared)),
    folders: [...sub].filter((s) => !rule.folders.includes(s)).map((s) => `${prefix}${s}`),
  };
}

export function checkContextFolders(files: LayoutFile[], allowed: string[], placed = PLACED_FOLDERS): { found: string[]; stale: string[] } {
  const found: string[] = [];
  const stale: string[] = [];
  for (const folder of Object.keys(placed)) {
    const u = unplaced(files, folder, placed[folder]);
    const open = u.files.length + u.folders.length > 0;
    if (u.folders.length) found.push(`${folder}/ has folders that are not context folders: ${u.folders.join(', ')} (rule:context-folders)`);
    if (open && !allowed.includes(folder))
      found.push(
        `${folder}/ has ${u.files.length} files outside a context folder, such as ${u.files.slice(0, 3).join(', ')} (rule:context-folders)`,
      );
    if (!open && allowed.includes(folder))
      stale.push(`${folder} is on UNPLACED_FOLDERS but holds only shared files and context folders: remove the entry`);
  }
  for (const entry of allowed)
    if (!(entry in placed)) stale.push(`${entry} is on UNPLACED_FOLDERS but is not a placed folder: remove the entry`);
  return { found, stale };
}
