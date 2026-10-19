import { rootInfo } from '../adapters/repo-root.ts';
import { writeSettings } from '../adapters/run-log.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { allowedTools } from '../domain/repo/tools.ts';
import { parseNetwork, settingsPath, workerSettings } from '../domain/run/sandbox.ts';

/** The tool rules a worker gets in `dir`, a checkout of `repo` (see domain/repo/tools.ts). */
export function effectiveTools(repo: Repo, dir: string): string[] {
  return allowedTools(repo, rootInfo(dir));
}

/**
 * Write the sandbox and file-rule settings for a claude run in `worktree` (docs/adr/0001-worker-sandbox.md)
 * next to its log, and return their path for `--settings`.
 */
export function runSettings(repo: Repo, worktree: string, logPath: string): string {
  const path = settingsPath(logPath);
  writeSettings(path, workerSettings({ worktree, sandbox: repo.sandbox !== 0, network: parseNetwork(repo.network) }));
  return path;
}
