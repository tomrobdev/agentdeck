// What `pnpm check:task` (scripts/check-task.mjs) runs beyond check:fast, from the paths a task's branch changes.
// Pure: the script finds the changed paths with git and runs the checks this returns.

export type ExtraCheck = {
  /** The check's name, as printed. */
  name: 'crash test' | 'check:rust';
  /** The command and its arguments, run from the repo root. */
  command: string[];
  /** The path prefixes that call for it. */
  prefixes: string[];
};

/** Crash-test iterations a task's branch runs (`pnpm check` runs more). */
export const TASK_CRASH_ITERATIONS = 5;

/** The checks a change may call for, in the order they run. A prefix ending in `/` is a folder, any other an exact file. */
export const EXTRA_CHECKS: ExtraCheck[] = [
  {
    name: 'crash test',
    command: ['node', 'daemon/scripts/crash-test.mjs', String(TASK_CRASH_ITERATIONS)],
    prefixes: [
      'daemon/src/application/runs/',
      'daemon/src/application/scheduler/',
      'daemon/src/adapters/processes.ts',
      'daemon/src/adapters/claude.ts',
      'daemon/src/db/',
    ],
  },
  { name: 'check:rust', command: ['pnpm', 'check:rust'], prefixes: ['app/src-tauri/'] },
];

export type ChosenCheck = ExtraCheck & {
  /** The changed paths that call for it, sorted. */
  because: string[];
};

function matches(path: string, prefix: string): boolean {
  return prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix;
}

/** The extra checks the changed paths (repo-relative, `/`-separated) call for, each with the paths that call for it. */
export function extraChecks(changed: readonly string[]): ChosenCheck[] {
  const paths = [...new Set(changed.map((p) => p.replace(/^\.\//, '')))].sort();
  return EXTRA_CHECKS.flatMap((check) => {
    const because = paths.filter((p) => check.prefixes.some((prefix) => matches(p, prefix)));
    return because.length ? [{ ...check, because }] : [];
  });
}

/** One line saying why a check runs: the first few paths that call for it. */
export function reasonLine(check: ChosenCheck, shown = 3): string {
  const more = check.because.length - shown;
  const paths = check.because.slice(0, shown).join(', ');
  return `${check.name}: the branch changes ${paths}${more > 0 ? ` and ${more} more` : ''}`;
}

/** The line saying an extra check does not run. */
export function skipLine(check: ExtraCheck): string {
  return `${check.name}: skipped, the branch changes none of ${check.prefixes.join(', ')}`;
}
