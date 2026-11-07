// The Claude Code settings each worker run gets with `--settings`. Pure: no I/O.
// See docs/adr/0001-worker-sandbox.md for why the Bash sandbox is on and what it covers.
import { textList } from '../text.ts';

export interface WorkerSettings {
  sandbox: {
    enabled: boolean;
    failIfUnavailable?: boolean;
    allowUnsandboxedCommands?: boolean;
    network?: { allowedDomains: string[]; strictAllowlist: boolean; allowLocalBinding: boolean };
  };
  permissions: { allow: string[] };
}

/**
 * The file-tool rule that only covers the worktree. An Edit rule covers every file-editing tool, Write
 * included (Claude Code ignores Write rules). Permission rules mark an absolute path with a leading `//`
 * (a single `/` would be relative to the settings file), hence `/` + the absolute path.
 */
export function worktreeFileRules(worktree: string): string[] {
  const root = worktree.replace(/\/+$/, '');
  return [`Edit(/${root}/**)`];
}

/**
 * With the sandbox on, every Bash command (and what it starts) is confined by the OS to the worktree
 * and to `network` hosts. It must not fall back to running unsandboxed: not when the sandbox can't
 * start (failIfUnavailable), and not command by command (allowUnsandboxedCommands). Binding a localhost port
 * stays allowed (allowLocalBinding), so tests that start a local server can run; outbound connections still go
 * through the allowlist.
 */
export function workerSettings(opts: { worktree: string; sandbox: boolean; network: string[] }): WorkerSettings {
  const permissions = { allow: worktreeFileRules(opts.worktree) };
  if (!opts.sandbox) return { sandbox: { enabled: false }, permissions };
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...opts.network], strictAllowlist: true, allowLocalBinding: true },
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

/** Where a run's settings file goes: next to its log, outside the worktree so the agent can't rewrite it. */
export function settingsPath(logPath: string): string {
  return logPath.replace(/\.jsonl$/, '') + '.settings.json';
}

/** A host list from user input: comma or space separated, blanks dropped, duplicates removed. */
export function normalizeNetwork(input: string | string[]): string[] {
  return textList(input);
}
