// Where an agentdeck:// link goes (a page as a named route location, a panel, the form or the palette), and a task's link.

export type TaskTab = 'overview' | 'runs' | 'changes' | 'code';
export const TASK_TABS: TaskTab[] = ['overview', 'runs', 'changes', 'code'];

export type PageLocation = { name: 'queue' } | { name: 'insights' } | { name: 'task'; params: { id: number; tab: TaskTab } };

export type AppLink = PageLocation | { name: 'new' } | { name: 'palette' } | { name: 'panel'; panel: 'settings' | 'repos' | 'daemon' };

export function parseAppUrl(url: string): AppLink | null {
  const m = url.trim().match(/^agentdeck:\/\/([^?#]*)(?:[?#].*)?$/i);
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'queue')) return { name: 'queue' };
  if (parts.length === 1 && parts[0] === 'new') return { name: 'new' };
  if (parts.length === 1 && parts[0] === 'insights') return { name: 'insights' };
  if (parts.length === 1 && parts[0] === 'palette') return { name: 'palette' };
  if (parts.length === 1 && (parts[0] === 'settings' || parts[0] === 'repos' || parts[0] === 'daemon'))
    return { name: 'panel', panel: parts[0] };
  if (parts[0] !== 'tasks' || parts.length > 3 || !/^\d+$/.test(parts[1] ?? '')) return null;
  const tab = parts[2] ?? 'overview';
  if (!(TASK_TABS as string[]).includes(tab)) return null;
  return { name: 'task', params: { id: Number(parts[1]), tab: tab as TaskTab } };
}

export const taskUrl = (id: number) => `agentdeck://tasks/${id}`;
