// The Claude Code settings each worker run gets with `--settings`.
import { textList } from '#domain/shared/index.ts';

export interface WorkerSettings {
  sandbox: {
    enabled: boolean;
    failIfUnavailable?: boolean;
    allowUnsandboxedCommands?: boolean;
    network?: { allowedDomains: string[]; strictAllowlist: boolean; allowLocalBinding: boolean };
  };
  permissions: { allow: string[] };
}

export function worktreeFileRules(worktree: string): string[] {
  const root = worktree.replace(/\/+$/, '');
  return [`Edit(/${root}/**)`];
}

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

export function withoutUnscopedFileTools(allowed: string[]): string[] {
  return allowed.filter((t) => t !== 'Edit' && t !== 'Write');
}

export function settingsPath(logPath: string): string {
  return logPath.replace(/\.jsonl$/, '') + '.settings.json';
}

export function normalizeNetwork(input: string | string[]): string[] {
  return textList(input);
}
