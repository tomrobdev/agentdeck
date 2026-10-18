// The Claude Code settings each worker run gets with `--settings`. Pure: no I/O.
// See docs/adr/0001-worker-sandbox.md for why the Bash sandbox is on and what it covers.

export interface WorkerSettings {
  sandbox: {
    enabled: boolean;
    failIfUnavailable?: boolean;
    allowUnsandboxedCommands?: boolean;
    network?: { allowedDomains: string[]; strictAllowlist: boolean };
  };
  permissions: { allow: string[] };
}

/**
 * Edit and Write rules that only cover the worktree. Permission rules mark an absolute path with
 * a leading `//` (a single `/` would be relative to the settings file), hence `/` + the absolute path.
 */
export function worktreeFileRules(worktree: string): string[] {
  const root = worktree.replace(/\/+$/, '');
  return [`Edit(/${root}/**)`, `Write(/${root}/**)`];
}

/**
 * With the sandbox on, every Bash command (and what it starts) is confined by the OS to the worktree
 * and to `network` hosts. It must not fall back to running unsandboxed: not when the sandbox can't
 * start (failIfUnavailable), and not command by command (allowUnsandboxedCommands).
 */
export function workerSettings(opts: { worktree: string; sandbox: boolean; network: string[] }): WorkerSettings {
  const permissions = { allow: worktreeFileRules(opts.worktree) };
  if (!opts.sandbox) return { sandbox: { enabled: false }, permissions };
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...opts.network], strictAllowlist: true },
    },
    permissions,
  };
}

/**
 * Bare `Edit` and `Write` rules allow any path, which would undo the worktree-only rules in the
 * settings file, so they are dropped from the allowed tools. Scoped rules a repo set itself stay.
 */
export function withoutUnscopedFileTools(allowed: string[]): string[] {
  return allowed.filter((t) => t !== 'Edit' && t !== 'Write');
}

/** Parse a repo's `network` column: a JSON array of hosts; anything else means no hosts. */
export function parseNetwork(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** A host list from user input: comma or space separated, blanks dropped, duplicates removed. */
export function normalizeNetwork(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(/[\s,]+/);
  return [...new Set(parts.map((d) => d.trim()).filter(Boolean))];
}
