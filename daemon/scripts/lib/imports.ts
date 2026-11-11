// The # subpath imports of the daemon and the app, read from the package.json files (the root's exports included): the folder each prefix names, both ways.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const REPO = join(import.meta.dirname, '../../..');

export const PACKAGE_DIRS = ['daemon', 'app'];

export interface Alias {
  pkg: string;
  prefix: string;
  dir: string;
}

export interface Manifest {
  dir: string;
  name: string;
  imports: Record<string, string>;
  exports: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  const json = JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')) as Partial<Manifest>;
  return { dir, name: json.name ?? dir, imports: json.imports ?? {}, exports: json.exports ?? {} };
}

const located = (pkgDir: string, target: string) => {
  const path = posix.join(pkgDir, target.replace(/\/?\*$/, ''));
  return target.endsWith('*') ? `${path}/` : path;
};

export function aliasesOf(manifests: Manifest[]): Alias[] {
  return manifests.flatMap((m) =>
    Object.entries(m.imports).flatMap(([key, target]): Alias[] => {
      const prefix = key.replace(/\*$/, '');
      if (target.startsWith('./')) return [{ pkg: m.dir, prefix, dir: located(m.dir, target) }];
      const [name, ...rest] = target.split('/');
      const sub = rest.join('/').replace(/\*$/, '');
      const other = manifests.find((o) => o.name === name);
      if (!other) return [];
      return Object.entries(other.exports)
        .filter(([exported]) => exported.startsWith(`./${sub}`))
        .map(([exported, to]) => ({
          pkg: m.dir,
          prefix: prefix + exported.slice(2 + sub.length).replace(/\*$/, ''),
          dir: located(other.dir, to),
        }));
    }),
  );
}

export const ALIASES: Alias[] = aliasesOf(['', ...PACKAGE_DIRS].map(readManifest));

export const packageOf = (repoPath: string): string | null => PACKAGE_DIRS.find((d) => repoPath.startsWith(`${d}/`)) ?? null;

export function resolveAlias(spec: string, pkg: string | null, aliases: Alias[] = ALIASES): { alias: Alias; path: string } | null {
  const hits = aliases.filter((a) => spec.startsWith(a.prefix) && (pkg === null || a.pkg === pkg));
  const best = hits.sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return best ? { alias: best, path: best.dir + spec.slice(best.prefix.length) } : null;
}

export function aliasFor(repoPath: string, pkg: string, aliases: Alias[] = ALIASES): string | null {
  const hits = aliases.filter((a) => a.pkg === pkg && repoPath.startsWith(a.dir));
  const best = hits.sort((a, b) => b.dir.length - a.dir.length)[0];
  return best ? best.prefix + repoPath.slice(best.dir.length) : null;
}
