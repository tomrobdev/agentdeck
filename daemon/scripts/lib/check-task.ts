// What `pnpm check:task` (scripts/check-task.mjs) runs beyond check:fast, from the paths a task's branch changes.

export type ExtraCheck = {
  name: 'crash test' | 'check:rust' | 'test:ui';
  command: string[];
  prefixes: string[];
};

export const TASK_CRASH_ITERATIONS = 5;

export const EXTRA_CHECKS: ExtraCheck[] = [
  {
    name: 'crash test',
    command: ['node', 'daemon/scripts/crash-test.mjs', String(TASK_CRASH_ITERATIONS)],
    prefixes: [
      'daemon/src/application/runs/',
      'daemon/src/application/scheduler/',
      'daemon/src/adapters/process/processes.ts',
      'daemon/src/adapters/claude/claude.ts',
      'daemon/src/db/',
      'daemon/scripts/crash-test.mjs',
    ],
  },
  { name: 'check:rust', command: ['pnpm', 'check:rust'], prefixes: ['app/src-tauri/'] },
  { name: 'test:ui', command: ['pnpm', 'test:ui'], prefixes: ['app/src/', 'app/e2e/', 'app/playwright.config.ts'] },
];

export type ChosenCheck = ExtraCheck & {
  because: string[];
};

function matches(path: string, prefix: string): boolean {
  return prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix;
}

export function extraChecks(changed: readonly string[]): ChosenCheck[] {
  const paths = [...new Set(changed.map((p) => p.replace(/^\.\//, '')))].sort();
  return EXTRA_CHECKS.flatMap((check) => {
    const because = paths.filter((p) => check.prefixes.some((prefix) => matches(p, prefix)));
    return because.length ? [{ ...check, because }] : [];
  });
}

export function reasonLine(check: ChosenCheck, shown = 3): string {
  const more = check.because.length - shown;
  const paths = check.because.slice(0, shown).join(', ');
  return `${check.name}: the branch changes ${paths}${more > 0 ? ` and ${more} more` : ''}`;
}

export function skipLine(check: ExtraCheck): string {
  return `${check.name}: skipped, the branch changes none of ${check.prefixes.join(', ')}`;
}

export const CI_JOB_OF: Record<ExtraCheck['name'], string> = { 'crash test': 'crash', 'check:rust': 'rust', 'test:ui': 'ui' };

export const RUN_ALL_PREFIXES = ['.github/', 'scripts/check-task.mjs', 'daemon/scripts/lib/check-task.ts'];

export function ciJobs(changed: readonly string[] | null): Record<string, boolean> {
  const all = changed === null || changed.some((p) => RUN_ALL_PREFIXES.some((prefix) => matches(p, prefix)));
  const chosen = new Set(all ? EXTRA_CHECKS.map((c) => c.name) : extraChecks(changed).map((c) => c.name));
  return Object.fromEntries(EXTRA_CHECKS.map((c) => [CI_JOB_OF[c.name], chosen.has(c.name)]));
}
