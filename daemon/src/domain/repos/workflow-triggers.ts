// Whether a repo's GitHub workflows run on pull requests into a plan branch, read from their pull_request triggers.
export interface WorkflowFile {
  path: string;
  text: string;
}

export const PLAN_BRANCH_PATTERN = 'plan/**';

const PROBE_BRANCH = 'plan/1-example';

interface PullRequestTrigger {
  path: string;
  branches: string[] | null;
  ignored: string[] | null;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

const bare = (line: string): string => line.replace(/(^|\s)#.*$/, '').trimEnd();

function patternsOf(value: string, block: string[]): string[] {
  const inline = value.trim();
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }
  if (inline) return [unquote(inline)];
  return block.flatMap((line) => (line.trim().startsWith('- ') ? [unquote(line.trim().slice(2))] : []));
}

function childrenOf(lines: string[], from: number): string[] {
  const parent = indentOf(lines[from]);
  const out: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (indentOf(line) <= parent) break;
    out.push(line);
  }
  return out;
}

function keyedValue(lines: string[], key: string): { value: string; block: string[] } | null {
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*:`).test(l));
  if (at < 0) return null;
  return { value: lines[at].slice(lines[at].indexOf(':') + 1), block: childrenOf(lines, at) };
}

function triggerOf(file: WorkflowFile): PullRequestTrigger | null {
  const lines = file.text
    .split('\n')
    .map(bare)
    .filter((l) => l.trim());
  const on = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (on < 0) return null;
  const inline = lines[on].slice(lines[on].indexOf(':') + 1).trim();
  if (inline) {
    const events = inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote);
    return events.includes('pull_request') ? { path: file.path, branches: null, ignored: null } : null;
  }
  const events = childrenOf(lines, on);
  const listed = events.some((l) => /^\s*-\s*pull_request\s*$/.test(l));
  const keyed = events.findIndex((l) => /^\s*pull_request\s*:/.test(l));
  if (listed) return { path: file.path, branches: null, ignored: null };
  if (keyed < 0) return null;
  const block = childrenOf(events, keyed);
  const filter = (key: string): string[] | null => {
    const found = keyedValue(block, key);
    const patterns = found ? patternsOf(found.value, found.block) : [];
    return patterns.length ? patterns : null;
  };
  return { path: file.path, branches: filter('branches'), ignored: filter('branches-ignore') };
}

export function branchPatternMatches(pattern: string, branch: string): boolean {
  const source = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '[^/]'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${source}$`).test(branch);
}

const runsOnPlanBranch = (trigger: PullRequestTrigger): boolean => {
  if (trigger.branches && !trigger.branches.some((p) => branchPatternMatches(p, PROBE_BRANCH))) return false;
  return !trigger.ignored?.some((p) => branchPatternMatches(p, PROBE_BRANCH));
};

export function planBranchCiWarning(workflows: WorkflowFile[]): string | null {
  const triggers = workflows.flatMap((w) => triggerOf(w) ?? []);
  if (!triggers.length || triggers.some(runsOnPlanBranch)) return null;
  const files = triggers.map((t) => t.path).join(', ');
  const first = triggers[0];
  const only = first.branches ? `only into ${first.branches.join(', ')}` : `except into ${(first.ignored ?? []).join(', ')}`;
  const fix = first.branches
    ? `add '${PLAN_BRANCH_PATTERN}' to its pull_request branches`
    : `take ${PLAN_BRANCH_PATTERN} out of its branches-ignore`;
  return `${files} runs on pull_request ${only}, so a pull request into a plan branch gets no checks: ${fix}`;
}
