// The dashboard's routes on Vue Router with hash history.
import { type LocationQuery, type LocationQueryValue, type RouteRecordInfo, createRouter, createWebHashHistory } from 'vue-router';
import TrayView from './components/layout/TrayView.vue';
import { TASK_TABS, type TaskTab } from './lib/shared/app-url';
import QueuePage from './pages/QueuePage.vue';

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
  interface RouteMeta {
    title?: string;
  }
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

const QUEUE_SCROLL = '[data-scroll="queue"]';
let queueScrollTop = 0;

function restoreQueueScroll(): Promise<false> {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      const list = document.querySelector(QUEUE_SCROLL);
      if (list && (list.scrollHeight > queueScrollTop || frames > 60)) list.scrollTop = queueScrollTop;
      else if (frames++ <= 60) return void requestAnimationFrame(tick);
      resolve(false);
    };
    tick();
  });
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { name: 'queue', path: '/', component: QueuePage, meta: { title: 'Queue' } },
    { name: 'insights', path: '/insights', component: () => import('./pages/InsightsPage.vue'), meta: { title: 'Insights' } },
    {
      name: 'task',
      path: '/tasks/:id(\\d+)/:tab(overview|runs|changes|code)?',
      component: () => import('./pages/TaskPage.vue'),
      props: taskProps,
    },
    { name: 'tray', path: '/tray', component: TrayView },
    {
      path: '/tasks/:id(\\d+)/:other',
      redirect: (to) => ({ path: to.path.replace(/[^/]+\/?$/, 'overview'), query: to.query }),
    },
    { path: '/:unknown(.*)*', redirect: (to) => ({ path: '/', query: to.query }) },
  ],
  scrollBehavior: (to, _from, saved) => {
    if (to.name === 'queue' && saved) return restoreQueueScroll();
    return { top: 0 };
  },
});

router.beforeEach((_to, from) => {
  if (from.name === 'queue') queueScrollTop = document.querySelector(QUEUE_SCROLL)?.scrollTop ?? 0;
});

router.afterEach((to) => {
  const title = to.meta.title ?? (to.name === 'task' ? `#${to.params.id}` : undefined);
  document.title = title ? `${title} — AgentDeck` : 'AgentDeck';
});
