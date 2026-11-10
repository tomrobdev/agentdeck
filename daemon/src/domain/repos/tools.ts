// Which tools a worker may use in a repo.
import type { Repo } from './repo.ts';
import { detectToolchain, isToolchain, toolchainTools } from './toolchain.ts';

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

export function allowedTools(repo: Pick<Repo, 'allowed_tools' | 'toolchain'>, root: { files: string[]; scripts: string[] }): string[] {
  if (repo.allowed_tools) return repo.allowed_tools;
  const toolchain = isToolchain(repo.toolchain) ? repo.toolchain : detectToolchain(root.files, root.scripts)?.toolchain;
  return [...DEFAULT_ALLOWED_TOOLS, ...(toolchain ? toolchainTools(toolchain, root.scripts) : [])];
}
