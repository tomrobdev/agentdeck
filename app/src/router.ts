// The dashboard's routes on Vue Router with hash history.
import { type LocationQuery, type LocationQueryValue, type RouteRecordInfo, createRouter, createWebHashHistory } from 'vue-router';
import TrayView from './components/layout/TrayView.vue';
import { TASK_TABS, type TaskTab } from './lib/shared/app-url';
import InsightsPage from './pages/InsightsPage.vue';
import QueuePage from './pages/QueuePage.vue';
import TaskPage from './pages/TaskPage.vue';

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
