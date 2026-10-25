// Which tools a worker may use in a repo. Pure: no I/O.
import type { Repo } from './repo.ts';
import { detectToolchain, isToolchain, toolchainTools } from './toolchain.ts';

/**
 * Generic tools every worker may use unless the repo overrides them. No push, no network installs.
 * Build and test rules come from the repo's toolchain (toolchain.ts).
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(ls*)',
  'Bash(cat*)',
  // Read-only helpers agents chain into one command (`cd app && ls; wc -l …`): one refused part refuses it all.
  'Bash(cd *)',
  'Bash(pwd*)',
  'Bash(wc *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(node *)',
];

export const ALWAYS_DISALLOWED_TOOLS = ['Bash(git push*)', 'Bash(git remote*)', 'Bash(rm -rf*)'];

/**
 * The repo's own rules if it has them, otherwise the generic defaults plus its toolchain's rules.
 * Repos registered before toolchain detection have no toolchain, so it is detected from `root`.
 */
export function allowedTools(repo: Pick<Repo, 'allowed_tools' | 'toolchain'>, root: { files: string[]; scripts: string[] }): string[] {
  if (repo.allowed_tools) return parseToolRules(repo.allowed_tools);
  const toolchain = isToolchain(repo.toolchain) ? repo.toolchain : detectToolchain(root.files, root.scripts)?.toolchain;
  return [...DEFAULT_ALLOWED_TOOLS, ...(toolchain ? toolchainTools(toolchain, root.scripts) : [])];
}

/**
 * A repo's own rules (a JSON array of strings). Unreadable rules give none rather than the defaults, which could allow
 * more than the repo meant: the first refused command then pauses the repo and says why.
 */
function parseToolRules(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
