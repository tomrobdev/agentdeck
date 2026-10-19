// Hash routes: `#/` is the queue, `#/tasks/16/<tab>?path=…&L=10-20` a task page. No router dependency.
import { reactive } from 'vue';

export type TaskTab = 'overview' | 'runs' | 'changes' | 'code';
export const TASK_TABS: TaskTab[] = ['overview', 'runs', 'changes', 'code'];

export type Route = { name: 'queue' } | { name: 'task'; id: number; tab: TaskTab; query: Record<string, string> };

export function parseHash(hash: string): Route {
  const [path, qs = ''] = hash.replace(/^#/, '').split('?');
  const m = path.match(/^\/tasks\/(\d+)(?:\/(\w+))?\/?$/);
  if (!m) return { name: 'queue' };
  const tab = (TASK_TABS as string[]).includes(m[2] ?? '') ? (m[2] as TaskTab) : 'overview';
  return { name: 'task', id: Number(m[1]), tab, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function hashFor(route: Route): string {
  if (route.name === 'queue') return '#/';
  const qs = new URLSearchParams(route.query).toString();
  return `#/tasks/${route.id}/${route.tab}${qs ? `?${qs}` : ''}`;
}

export const route = reactive<{ current: Route }>({ current: parseHash(location.hash) });

window.addEventListener('hashchange', () => (route.current = parseHash(location.hash)));

/** Go to a route; `replace` swaps the history entry, for changes like a line selection. */
export function go(to: Route, opts: { replace?: boolean } = {}): void {
  const hash = hashFor(to);
  if (hash === location.hash) return;
  if (opts.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route.current = parseHash(hash);
}

export const openTask = (id: number, tab: TaskTab = 'overview', query: Record<string, string> = {}) => go({ name: 'task', id, tab, query });
