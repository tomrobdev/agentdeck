// What a blocked task's worker said it needs. A task holds it in its `needs`. Pure: no I/O.

export type NeedsKind = 'deps' | 'host' | 'edit';
const NEEDS_KINDS: string[] = ['deps', 'host', 'edit'];

/** What a blocked worker needs before it can go on: packages, network hosts, or files it may not edit. */
export interface Needs {
  kind: NeedsKind;
  items: string[];
}

/** How the note on the retry after a person's `install-needs` begins; the stats count that retry as an install, not as a note. */
export const INSTALL_NOTE = 'AgentDeck installed';

/** "NEEDS deps: a b" / "NEEDS host: h" / "NEEDS edit: path" at the start of a blocked reason. */
export function parseNeeds(reason: string | undefined): Needs | undefined {
  const m = reason?.match(/^NEEDS\s+(deps|host|edit)\s*:\s*(.*)$/i);
  if (!m) return undefined;
  const items = m[2].split(/[\s,]+/).filter(Boolean);
  return items.length ? { kind: m[1].toLowerCase() as NeedsKind, items } : undefined;
}

/** Whether a stored value is a `Needs`: a known kind and a list of items. */
export const isNeeds = (n: unknown): n is Needs => {
  const v = n as Partial<Needs> | null;
  return !!v && typeof v.kind === 'string' && NEEDS_KINDS.includes(v.kind) && Array.isArray(v.items);
};

/** Package managers the daemon installs with on a person's request, each with the lockfile it writes. */
export const INSTALLERS = ['pnpm', 'yarn', 'npm'];
export const LOCKFILES: Record<string, string> = { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', npm: 'package-lock.json' };

/** Whether the daemon can install packages in a repo with this toolchain. */
export const canInstallWith = (toolchain: string | null | undefined): boolean => INSTALLERS.includes(toolchain ?? '');

/** An npm package spec: `name`, `@scope/name` or either with `@version-or-tag`. No shell metacharacters, no leading dash. */
const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._^~*+-]*)?$/;

const isDevFlag = (item: string) => item === '--dev' || item === '-D';

/** The packages a deps request names and whether they go in devDependencies (`--dev` or `-D` among the items). */
export function depsRequest(items: string[]): { packages: string[]; dev: boolean } {
  return { packages: items.filter((i) => !isDevFlag(i)), dev: items.some(isDevFlag) };
}

/** Why a deps request can't be installed (no packages, or a name that isn't a package spec), or null when it can. */
export function depsRequestError(items: string[]): string | null {
  const { packages } = depsRequest(items);
  if (!packages.length) return 'the request names no packages';
  const bad = packages.filter((p) => !PACKAGE_SPEC.test(p));
  return bad.length ? `not a valid package name: ${bad.join(' ')}` : null;
}

/** The arguments that install `packages` with an installer from INSTALLERS. */
export function installArgs(toolchain: string, packages: string[], dev: boolean): string[] {
  return toolchain === 'npm' ? ['install', dev ? '--save-dev' : '--save', ...packages] : ['add', ...(dev ? ['-D'] : []), ...packages];
}
