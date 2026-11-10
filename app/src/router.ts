// The dashboard's routes on Vue Router with hash history, and go, openTask and route over it for the callers that use Route.
import { computed } from 'vue';
import {
  type LocationQuery,
  type LocationQueryValue,
  type RouteLocationNormalizedLoaded,
  type RouteLocationRaw,
  type RouteRecordInfo,
  createRouter,
  createWebHashHistory,
} from 'vue-router';
import TrayView from './components/layout/TrayView.vue';
import { TASK_TABS, type TaskTab } from './lib/shared/app-url';
import InsightsPage from './pages/InsightsPage.vue';
import QueuePage from './pages/QueuePage.vue';
import TaskPage from './pages/TaskPage.vue';

export type { TaskTab };

type NoParams = Record<never, never>;

interface RouteNamedMap {
  queue: RouteRecordInfo<'queue', '/', NoParams, NoParams>;
  insights: RouteRecordInfo<'insights', '/insights', NoParams, NoParams>;
  task: RouteRecordInfo<
    'task',
    '/tasks/:id(\\d+)/:tab(overview|runs|changes|code)?',
    { id: string | number; tab?: TaskTab | null },
    { id: string; tab?: TaskTab }
  >;
  tray: RouteRecordInfo<'tray', '/tray', NoParams, NoParams>;
}

declare module 'vue-router' {
  interface TypesConfig {
    RouteNamedMap: RouteNamedMap;
  }
}

export type Route =
  | { name: 'queue'; states?: string[] }
  | { name: 'insights' }
  | { name: 'tray' }
  | { name: 'task'; id: number; tab: TaskTab; query: Record<string, string> };

const text = (v: LocationQueryValue | LocationQueryValue[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const queryOf = (q: LocationQuery): Record<string, string> => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, text(v)]));
const tabOf = (v: unknown): TaskTab => ((TASK_TABS as unknown[]).includes(v) ? (v as TaskTab) : 'overview');

function taskProps(to: { params: Record<string, unknown>; query: LocationQuery }) {
  return { id: Number(to.params.id), tab: tabOf(to.params.tab), query: queryOf(to.query) };
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { name: 'queue', path: '/', component: QueuePage },
    { name: 'insights', path: '/insights', component: InsightsPage },
    { name: 'task', path: '/tasks/:id(\\d+)/:tab(overview|runs|changes|code)?', component: TaskPage, props: taskProps },
    { name: 'tray', path: '/tray', component: TrayView },
    {
      path: '/tasks/:id(\\d+)/:other',
      redirect: (to) => ({ path: to.path.replace(/[^/]+\/?$/, 'overview'), query: to.query }),
    },
    { path: '/:unknown(.*)*', redirect: (to) => ({ path: '/', query: to.query }) },
  ],
});

function toRoute(r: RouteLocationNormalizedLoaded): Route {
  if (r.name === 'insights') return { name: 'insights' };
  if (r.name === 'tray') return { name: 'tray' };
  if (r.name === 'task') return { name: 'task', ...taskProps(r) };
  const states = text(r.query.states).split(',').filter(Boolean);
  return states.length ? { name: 'queue', states } : { name: 'queue' };
}

function locationOf(to: Route): RouteLocationRaw {
  if (to.name === 'queue') return { name: 'queue', query: to.states?.length ? { states: to.states.join(',') } : {} };
  if (to.name === 'task') return { name: 'task', params: { id: to.id, tab: to.tab }, query: to.query };
  return { name: to.name };
}

const current = computed(() => toRoute(router.currentRoute.value));

export const route: { readonly current: Route } = {
  get current() {
    return current.value;
  },
};

export const hashFor = (to: Route): string => router.resolve(locationOf(to)).href;

export function go(to: Route, opts: { replace?: boolean } = {}): void {
  void (opts.replace ? router.replace(locationOf(to)) : router.push(locationOf(to)));
}

export const openTask = (id: number, tab: TaskTab = 'overview', query: Record<string, string> = {}) => go({ name: 'task', id, tab, query });
