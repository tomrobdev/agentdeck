// What a blocked task's worker said it needs, and what an unblock run asked a person.

/** What an unblock run left on a task it did not retry (the task's `question`). */
export interface UnblockQuestion {
  question: string;
  options: string[];
}

export type NeedsKind = 'deps' | 'host' | 'edit';
const NEEDS_KINDS: string[] = ['deps', 'host', 'edit'];

/** What a blocked worker needs before it can go on: packages, network hosts, or files it may not edit. */
export interface Needs {
  kind: NeedsKind;
  items: string[];
}

export const INSTALL_NOTE = 'AgentDeck installed';

export function parseNeeds(reason: string | undefined): Needs | undefined {
  const m = reason?.match(/^NEEDS\s+(deps|host|edit)\s*:\s*(.*)$/i);
  if (!m) return undefined;
  const items = m[2].split(/[\s,]+/).filter(Boolean);
  return items.length ? { kind: m[1].toLowerCase() as NeedsKind, items } : undefined;
}

export const isNeeds = (n: unknown): n is Needs => {
  const v = n as Partial<Needs> | null;
  return !!v && typeof v.kind === 'string' && NEEDS_KINDS.includes(v.kind) && Array.isArray(v.items);
};

export const INSTALLERS = ['pnpm', 'yarn', 'npm'];
export const LOCKFILES: Record<string, string> = { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', npm: 'package-lock.json' };

export const canInstallWith = (toolchain: string | null | undefined): boolean => INSTALLERS.includes(toolchain ?? '');

const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._^~*+-]*)?$/;

const isDevFlag = (item: string) => item === '--dev' || item === '-D';

export function depsRequest(items: string[]): { packages: string[]; dev: boolean } {
  return { packages: items.filter((i) => !isDevFlag(i)), dev: items.some(isDevFlag) };
}

export function depsRequestError(items: string[]): string | null {
  const { packages } = depsRequest(items);
  if (!packages.length) return 'the request names no packages';
  const bad = packages.filter((p) => !PACKAGE_SPEC.test(p));
  return bad.length ? `not a valid package name: ${bad.join(' ')}` : null;
}

export function installArgs(toolchain: string, packages: string[], dev: boolean): string[] {
  return toolchain === 'npm' ? ['install', dev ? '--save-dev' : '--save', ...packages] : ['add', ...(dev ? ['-D'] : []), ...packages];
}
