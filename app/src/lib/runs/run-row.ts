// What a row of the run list says about a run besides its outcome: its kind as an icon, and its cost with its tokens.
import type { Run } from '#daemon/api/contract/runs.ts';

type RunKind = Run['kind'];
import { costText } from '#daemon/domain/runs/index.ts';

export const RUN_KIND_ICONS: Record<RunKind, { icon: string; label: string }> = {
  work: { icon: '▶', label: 'Work run' },
  resolve: { icon: '⇄', label: 'Resolve run' },
  unblock: { icon: '⚑', label: 'Unblock run' },
  review: { icon: '◎', label: 'Review run' },
  verify: { icon: '⌕', label: 'Verify run' },
  plan_resolve: { icon: '⇄', label: 'Plan branch resolve run' },
  plan_review: { icon: '◎', label: 'Plan review run' },
};

const count = (n: number): string => n.toLocaleString('en-US');

type CostFields = Pick<Run, 'cost_usd' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>;

export function runCost(r: CostFields): { text: string; title: string } {
  const total = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
  const title = total
    ? `${count(total)} tokens: ${count(r.input_tokens)} in, ${count(r.output_tokens)} out, ${count(r.cache_read_tokens)} cache read, ${count(r.cache_write_tokens)} cache write`
    : 'No tokens recorded';
  return { text: costText(r.cost_usd ?? 0), title };
}
