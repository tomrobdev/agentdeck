// The dashboard's single-key shortcuts as data: what a key is called and where it counts (its scope), how a two-key
// sequence such as `g q` resolves, and the registrations the `?` sheet lists. `hotkeyApplies` (which reads the page) owns
// whether a press counts at all; this file owns what a counted press means. Free of Vue so the daemon's tests can import it
// (daemon/test/dashboard/shared/hotkeys.test.ts).

/** Where a key counts: everywhere (`app`), on the queue, on a task's page, in a diff or in a run's log. */
export type HotkeyScope = 'app' | 'queue' | 'task' | 'diff' | 'log';

export const SCOPES: { scope: HotkeyScope; label: string }[] = [
  { scope: 'app', label: 'Everywhere' },
  { scope: 'queue', label: 'The queue' },
  { scope: 'task', label: 'A task page' },
  { scope: 'diff', label: 'Files and diffs' },
  { scope: 'log', label: "A run's log" },
];

/** A key as bound: what it does, in a few words, and where it counts. A sequence is its keys with a space: `g q`. */
export interface HotkeyDef {
  key: string;
  label: string;
  scope: HotkeyScope;
}

/** How long the first key of a sequence waits for its second. */
export const SEQUENCE_MS = 1500;

/** The first key of a sequence being waited on, and when it was pressed. */
export interface PendingKey {
  key: string;
  at: number;
}

export interface KeyStep {
  /** The binding the press completed (a single key or a whole sequence), or null. */
  match: string | null;
  /** The sequence's first key now being waited on, or null. */
  pending: PendingKey | null;
}

/**
 * What a key press means among `bindings`. A key that starts a sequence (`g` for `g q`) waits for the next press; a second
 * key that completes one matches it; any other second key ends the wait and counts as a key of its own. A wait older than
 * `SEQUENCE_MS` is over.
 */
export function resolveKey(bindings: readonly string[], pending: PendingKey | null, key: string, now: number): KeyStep {
  if (pending && now - pending.at <= SEQUENCE_MS) {
    const sequence = `${pending.key} ${key}`;
    if (bindings.includes(sequence)) return { match: sequence, pending: null };
  }
  if (bindings.some((b) => b.startsWith(`${key} `))) return { match: null, pending: { key, at: now } };
  return { match: bindings.includes(key) ? key : null, pending: null };
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  Enter: '↵',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** One key as the sheet shows it: a capital letter is shift and that letter ("⇧M"), a named key its name. */
export function keyName(key: string): string {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  return /^[A-Z]$/.test(key) ? `⇧${key}` : key;
}

/** A binding as the sheet shows it, the keys of a sequence apart: `g q` is ["g", "q"]. */
export const keyCaps = (key: string): string[] => (key === ' ' ? [keyName(key)] : key.split(' ').map(keyName));

// What is bound now: each component adds its keys when it mounts and removes them when it unmounts (useHotkeys), so the
// sheet lists the keys in force on this page, never a copy of them. The dashboard is one page; this is its own state.
const registry = new Map<symbol, HotkeyDef[]>();

/** Adds a component's keys; the returned function removes them. */
export function registerKeys(defs: HotkeyDef[]): () => void {
  const id = Symbol('keys');
  registry.set(id, defs);
  return () => void registry.delete(id);
}

/** Every key bound now. */
export const registeredKeys = (): HotkeyDef[] => [...registry.values()].flat();

export interface SheetGroup {
  scope: HotkeyScope;
  label: string;
  keys: HotkeyDef[];
}

/** The keys grouped by scope in the sheet's order, a key bound twice in one scope once, and a scope with none left out. */
export function sheetGroups(defs: readonly HotkeyDef[]): SheetGroup[] {
  return SCOPES.map(({ scope, label }) => {
    const seen = new Set<string>();
    const keys = defs.filter((d) => {
      if (d.scope !== scope || seen.has(d.key)) return false;
      seen.add(d.key);
      return true;
    });
    return { scope, label, keys };
  }).filter((g) => g.keys.length);
}

/** Where `g` then a key goes. `settings` and `repos` are panels the app opens; the rest are routes. */
export type GoTarget = 'queue' | 'insights' | 'settings' | 'repos';
export const GO_KEYS: { key: string; label: string; to: GoTarget }[] = [
  { key: 'g q', label: 'Go to the queue', to: 'queue' },
  { key: 'g i', label: 'Go to insights', to: 'insights' },
  { key: 'g s', label: 'Go to settings', to: 'settings' },
  { key: 'g r', label: 'Go to repos', to: 'repos' },
];

/**
 * `p` then a digit sets a priority level, as in Linear: 1 urgent down to 4 low, 0 none. `level` is a key of the dashboard's
 * PRIORITY_LEVELS (lib/task/task-view.ts), which owns the number each sets.
 */
export const PRIORITY_KEYS = [
  { key: '1', level: 'urgent', label: 'Urgent' },
  { key: '2', level: 'high', label: 'High' },
  { key: '3', level: 'medium', label: 'Medium' },
  { key: '4', level: 'low', label: 'Low' },
  { key: '0', level: 'none', label: 'No priority' },
] as const;

/** An edit asked for from outside the keys (the command palette): the prompt, the model or a link in a dialog, or a priority level at once. */
export type EditRequest = { kind: 'prompt' | 'model' | 'link' } | { kind: 'priority'; level: (typeof PRIORITY_KEYS)[number]['level'] };
