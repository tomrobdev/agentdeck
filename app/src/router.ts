import { reactive } from 'vue';

export type TaskTab = 'overview' | 'runs' | 'changes' | 'code';
const TASK_TABS: TaskTab[] = ['overview', 'runs', 'changes', 'code'];

export type Route =
  | { name: 'queue'; states?: string[] }
  | { name: 'insights' }
  | { name: 'tray' }
  | { name: 'task'; id: number; tab: TaskTab; query: Record<string, string> };

export function parseHash(hash: string): Route {
  const [path, qs = ''] = hash.replace(/^#/, '').split('?');
  const m = path.match(/^\/tasks\/(\d+)(?:\/(\w+))?\/?$/);
  if (path === '/insights') return { name: 'insights' };
  if (path === '/tray') return { name: 'tray' };
  if (!m) {
    const states = new URLSearchParams(qs).get('states')?.split(',').filter(Boolean);
    return states?.length ? { name: 'queue', states } : { name: 'queue' };
  }
  const tab = (TASK_TABS as string[]).includes(m[2] ?? '') ? (m[2] as TaskTab) : 'overview';
  return { name: 'task', id: Number(m[1]), tab, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export type AppLink = Route | { name: 'new' } | { name: 'palette' } | { name: 'panel'; panel: 'settings' | 'repos' | 'daemon' };

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
  return { name: 'task', id: Number(parts[1]), tab: tab as TaskTab, query: {} };
}

export const taskUrl = (id: number) => `agentdeck://tasks/${id}`;

export function hashFor(route: Route): string {
  if (route.name === 'insights') return '#/insights';
  if (route.name === 'tray') return '#/tray';
  if (route.name === 'queue') return route.states?.length ? `#/?states=${route.states.join(',')}` : '#/';
  const qs = new URLSearchParams(route.query).toString();
  return `#/tasks/${route.id}/${route.tab}${qs ? `?${qs}` : ''}`;
}

export const route = reactive<{ current: Route }>({ current: parseHash(location.hash) });

window.addEventListener('hashchange', () => (route.current = parseHash(location.hash)));

export function go(to: Route, opts: { replace?: boolean } = {}): void {
  const hash = hashFor(to);
  if (hash === location.hash) return;
  if (opts.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route.current = parseHash(hash);
}

export const openTask = (id: number, tab: TaskTab = 'overview', query: Record<string, string> = {}) => go({ name: 'task', id, tab, query });
