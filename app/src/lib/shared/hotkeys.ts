export type HotkeyScope = 'app' | 'queue' | 'task' | 'diff' | 'log';

export const SCOPES: { scope: HotkeyScope; label: string }[] = [
  { scope: 'app', label: 'Everywhere' },
  { scope: 'queue', label: 'The queue' },
  { scope: 'task', label: 'A task page' },
  { scope: 'diff', label: 'Files and diffs' },
  { scope: 'log', label: "A run's log" },
];

export interface HotkeyDef {
  key: string;
  label: string;
  scope: HotkeyScope;
}

export const SEQUENCE_MS = 1500;

export interface PendingKey {
  key: string;
  at: number;
}

export interface KeyStep {
  match: string | null;
  pending: PendingKey | null;
}

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

export function keyName(key: string): string {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  return /^[A-Z]$/.test(key) ? `⇧${key}` : key;
}

export const keyCaps = (key: string): string[] => (key === ' ' ? [keyName(key)] : key.split(' ').map(keyName));

const registry = new Map<symbol, HotkeyDef[]>();

export function registerKeys(defs: HotkeyDef[]): () => void {
  const id = Symbol('keys');
  registry.set(id, defs);
  return () => void registry.delete(id);
}

export const registeredKeys = (): HotkeyDef[] => [...registry.values()].flat();

export interface SheetGroup {
  scope: HotkeyScope;
  label: string;
  keys: HotkeyDef[];
}

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

export type GoTarget = 'queue' | 'insights' | 'settings' | 'repos';
export const GO_KEYS: { key: string; label: string; to: GoTarget }[] = [
  { key: 'g q', label: 'Go to the queue', to: 'queue' },
  { key: 'g i', label: 'Go to insights', to: 'insights' },
  { key: 'g s', label: 'Go to settings', to: 'settings' },
  { key: 'g r', label: 'Go to repos', to: 'repos' },
];

export const PRIORITY_KEYS = [
  { key: '1', level: 'urgent', label: 'Urgent' },
  { key: '2', level: 'high', label: 'High' },
  { key: '3', level: 'medium', label: 'Medium' },
  { key: '4', level: 'low', label: 'Low' },
  { key: '0', level: 'none', label: 'No priority' },
] as const;

export type EditRequest = { kind: 'prompt' | 'model' | 'link' } | { kind: 'priority'; level: (typeof PRIORITY_KEYS)[number]['level'] };
