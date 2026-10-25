// What a person may set on a repo: the limits on its fields. Each rule returns the message to show, or null. Pure: no I/O.

export const GOALS_LIMIT = 20_000;

/** Goals are sent in every planner prompt, so they are capped. */
export const goalsError = (goals: string): string | null =>
  goals.length > GOALS_LIMIT ? `goals are limited to ${GOALS_LIMIT.toLocaleString('en-US')} characters` : null;

/** The first entry of a network allowlist that is not a host name (a wildcard, port or bracketed address is fine). */
export function networkError(hosts: string[]): string | null {
  const bad = hosts.find((host) => !/^[A-Za-z0-9*.:[\]-]+$/.test(host));
  return bad === undefined ? null : `not a host name: ${bad}`;
}
