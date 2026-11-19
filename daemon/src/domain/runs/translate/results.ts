// A claude session's result events added up: a background task or wake-up can re-enter it and print more than one.
import type { ClaudeResult } from '#domain/runs/run-result.ts';
import { fields } from '#domain/runs/translate/fields.ts';

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

const sum = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

export function addResult(total: ClaudeResult | undefined, next: ClaudeResult): ClaudeResult {
  if (!total) return next;
  const usage: NonNullable<ClaudeResult['usage']> = {};
  for (const key of USAGE_KEYS) {
    const value = sum(total.usage?.[key], next.usage?.[key]);
    if (value !== undefined) usage[key] = value;
  }
  return {
    ...next,
    num_turns: sum(total.num_turns, next.num_turns),
    total_cost_usd: sum(total.total_cost_usd, next.total_cost_usd),
    usage: total.usage || next.usage ? usage : undefined,
  };
}

export function sessionResult(events: unknown[]): ClaudeResult | undefined {
  let total: ClaudeResult | undefined;
  for (const event of events) {
    const ev = fields(event);
    if (ev.type === 'result') total = addResult(total, ev as ClaudeResult);
  }
  return total;
}
