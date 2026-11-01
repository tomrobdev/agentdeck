// What a blocked task's worker said it needs. A task holds it in its `needs` column. Pure: no I/O.

export type NeedsKind = 'deps' | 'host' | 'edit';
const NEEDS_KINDS: string[] = ['deps', 'host', 'edit'];

/** What a blocked worker needs before it can go on: packages, network hosts, or files it may not edit. */
export interface Needs {
  kind: NeedsKind;
  items: string[];
}

/** How the note on the retry after a person's `install-needs` begins; the stats count that retry as an install, not as a note. */
export const INSTALL_NOTE = 'AgentDeck installed';

/** "NEEDS deps: a b" / "NEEDS host: h" / "NEEDS edit: path" at the start of a blocked reason. */
export function parseNeeds(reason: string | undefined): Needs | undefined {
  const m = reason?.match(/^NEEDS\s+(deps|host|edit)\s*:\s*(.*)$/i);
  if (!m) return undefined;
  const items = m[2].split(/[\s,]+/).filter(Boolean);
  return items.length ? { kind: m[1].toLowerCase() as NeedsKind, items } : undefined;
}

/** A task's `needs` column (JSON), or null when it has none or it is unreadable. */
export function readNeeds(json: string | null): Needs | null {
  if (!json) return null;
  try {
    const n = JSON.parse(json) as Partial<Needs>;
    return n && typeof n.kind === 'string' && NEEDS_KINDS.includes(n.kind) && Array.isArray(n.items) ? (n as Needs) : null;
  } catch {
    return null;
  }
}
