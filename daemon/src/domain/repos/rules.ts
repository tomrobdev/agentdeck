// What a person may set on a repo: the limits on its fields. Each rule returns the message to show, or null. Pure: no I/O.

export const GOALS_LIMIT = 20_000;

/** Goals are sent in every planner prompt, so they are capped. */
export const goalsError = (goals: string): string | null =>
  goals.length > GOALS_LIMIT ? `goals are limited to ${GOALS_LIMIT.toLocaleString('en-US')} characters` : null;

/** A repo's name becomes a file name (goals, planner log) and is looked up by name or id, so it must be plain and not read as an id. */
export function repoNameError(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return `repo name may only use letters, digits, . _ - (got ${name})`;
  if (/^[.-]/.test(name)) return `repo name must not start with a dot or dash (got ${name})`;
  if (/^\d+$/.test(name)) return `repo name must not be all digits, it would read as an id (got ${name})`;
  return null;
}

/** The first tool rule that is not a tool name, alone or with a pattern in parentheses: `Read`, `Bash(pnpm test*)`, `mcp__x__y`. */
export function toolRulesError(rules: string[]): string | null {
  const bad = rules.find((rule) => !/^[A-Za-z][\w-]*(\(.*\))?$/.test(rule));
  return bad === undefined ? null : `not a tool rule: ${bad} (a tool name, with a pattern in parentheses if it takes one)`;
}

/** The first entry of a network allowlist that is not a host name (a wildcard, port or bracketed address is fine). */
export function networkError(hosts: string[]): string | null {
  const bad = hosts.find((host) => !/^[A-Za-z0-9*.:[\]-]+$/.test(host));
  return bad === undefined ? null : `not a host name: ${bad}`;
}
