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

/** Where the rules a repo's workers run with come from: the repo's own, or the defaults plus those detected from its toolchain. */
export type ToolRulesSource = 'own' | 'detected';

export const toolRulesSource = (repo: Pick<Repo, 'allowed_tools'>): ToolRulesSource => (repo.allowed_tools ? 'own' : 'detected');

/**
 * Tool rules as a person types them: one per line or comma-separated. A comma inside parentheses belongs to its rule
 * (`Bash(echo a, b)`). Blanks and repeats are dropped, so an empty text is no rules: the detected ones.
 */
export function parseToolRules(text: string): string[] {
  const rules: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if ((c === ',' && depth === 0) || c === '\n') {
      rules.push(cur);
      cur = '';
    } else cur += c;
  }
  rules.push(cur);
  return [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
}

/**
 * The repo's own rules if it has them, otherwise the generic defaults plus its toolchain's rules.
 * Repos registered before toolchain detection have no toolchain, so it is detected from `root`.
 */
export function allowedTools(repo: Pick<Repo, 'allowed_tools' | 'toolchain'>, root: { files: string[]; scripts: string[] }): string[] {
  if (repo.allowed_tools) return repo.allowed_tools;
  const toolchain = isToolchain(repo.toolchain) ? repo.toolchain : detectToolchain(root.files, root.scripts)?.toolchain;
  return [...DEFAULT_ALLOWED_TOOLS, ...(toolchain ? toolchainTools(toolchain, root.scripts) : [])];
}
