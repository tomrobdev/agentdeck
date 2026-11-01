<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  type Repo,
  type Status,
  type TaskSummary,
  type TaskDetail as Detail,
  api,
  describeState,
  isOffline,
  reposQuery,
  statusQuery,
  taskQuery,
  tasksQuery,
} from './api';
import { setTrayStatus } from './platform/native';
import NewTaskForm from './components/panels/NewTaskForm.vue';
import WaitBar from './components/layout/WaitBar.vue';
import ReposPanel from './components/panels/ReposPanel.vue';
import SettingsPanel from './components/panels/SettingsPanel.vue';
import StaleDaemonBar from './components/layout/StaleDaemonBar.vue';
import AppHeader from './components/layout/AppHeader.vue';
import StatusBar from './components/layout/StatusBar.vue';
import QueueView from './components/queue/QueueView.vue';
import TaskPage from './components/task/TaskPage.vue';
import { openTask, route } from './router';
import { type BoardMove, needYouCount, openingTab } from './lib/taskView';
import { provideActions } from './composables/useActions';

const POLL_MS = 2000;

const selectedId = ref<number | null>(null);
const toast = ref('');
const modal = ref<'new' | 'repos' | 'settings' | null>(null);

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ''), 3500);
}

/** The task whose page is open, from the route. */
const pageId = computed(() => (route.current.name === 'task' ? route.current.id : null));

// Query keeps the old object when a refetch returns the same data, so nothing below re-runs every 2 s.
// Status also polls while the window is hidden: the tray label reads it. The page's own query does not.
const statusQ = useQuery({ ...statusQuery(), refetchInterval: POLL_MS, refetchIntervalInBackground: true });
const tasksQ = useQuery(computed(() => ({ ...tasksQuery(), enabled: pageId.value === null, refetchInterval: POLL_MS })));
const taskQ = useQuery(computed(() => ({ ...taskQuery(pageId.value ?? 0), enabled: pageId.value !== null, refetchInterval: POLL_MS })));
const reposQ = useQuery(reposQuery());

const status = computed<Status | null>(() => statusQ.data.value ?? null);
const tasks = computed<TaskSummary[]>(() => tasksQ.data.value ?? []);
const repos = computed<Repo[]>(() => reposQ.data.value ?? []);
const detail = computed<Detail | null>(() => (pageId.value === null ? null : (taskQ.data.value ?? null)));
const offline = computed(() => isOffline(statusQ.error.value));

// After a change any of it may have moved (the Repos panel adds, archives and edits repos too).
const queryClient = useQueryClient();
const { busy, run: act } = provideActions(() => queryClient.invalidateQueries(), flash);

watch(
  pageId,
  (id) => {
    if (id !== null) selectedId.value = id;
  },
  { immediate: true },
);

const togglePause = () => act(() => (status.value?.paused ? api.resume() : api.pause()));
const ACTIONS: Record<BoardMove, (id: number) => Promise<unknown>> = {
  approve: api.approve,
  reject: api.reject,
  retry: api.retry,
  cancel: api.cancel,
  mark_done: api.markDone,
};
const actOn = (kind: BoardMove, id: number) => act(() => ACTIONS[kind](id));
/** A task in review opens on its diff, the rest on the overview. */
function openFromQueue(id: number) {
  const t = tasks.value.find((x) => x.id === id);
  openTask(id, t ? openingTab(t) : 'overview');
}
const resumeDaemon = () => act(() => api.resume());
const resumeRepo = (id: number) => act(() => api.resumeRepo(id));

function onCreated(task: Detail) {
  modal.value = null;
  openTask(task.id);
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}

watchEffect(() => {
  const s = status.value;
  const label = describeState(s, offline.value).label;
  const waiting = needYouCount(s);
  setTrayStatus(waiting ? `${label} · ${waiting} need you` : label);
});
</script>

<template>
  <div class="flex h-screen flex-col">
    <AppHeader :status="status" :offline="offline" @new-task="modal = 'new'" @repos="modal = 'repos'" @settings="modal = 'settings'" />

    <div v-if="offline" class="m-auto max-w-[420px] text-center">
      <h2 class="text-lg">The AgentDeck daemon isn't running</h2>
      <p class="muted">Start it in a terminal and this window will connect on its own:</p>
      <pre class="rounded-md border border-border bg-code-bg p-2.5">cd daemon && npm start</pre>
    </div>

    <main v-else-if="pageId !== null" class="flex min-h-0 flex-1 flex-col">
      <StaleDaemonBar :status="status" />
      <TaskPage
        v-if="detail && route.current.name === 'task'"
        :task="detail"
        :tab="route.current.tab"
        :query="route.current.query"
        @act="(kind) => actOn(kind, detail!.id)"
      />
      <section v-else class="muted flex flex-1 flex-col items-center justify-center gap-3">Loading task #{{ pageId }}…</section>
    </main>
    <main v-else class="flex min-h-0 flex-1 flex-col">
      <StaleDaemonBar :status="status" />
      <WaitBar :status="status" :busy="busy" @resume="resumeDaemon" @resume-repo="resumeRepo" @settings="modal = 'settings'" />
      <QueueView
        v-if="tasks.length"
        v-model:selected="selectedId"
        :tasks="tasks"
        @open="openFromQueue"
        @act="actOn"
        @new-task="modal = 'new'"
      />
      <section v-else class="muted flex flex-1 flex-col items-center justify-center gap-3">
        No tasks yet.
        <button class="primary" @click="modal = repos.length ? 'new' : 'repos'">
          {{ repos.length ? 'Queue your first task' : 'Add a repo to get started' }}
        </button>
      </section>
    </main>

    <StatusBar :status="status" :offline="offline" :busy="busy" @toggle="togglePause" />

    <NewTaskForm v-if="modal === 'new'" :repos="repos" @close="modal = null" @created="onCreated" @repos="modal = 'repos'" />
    <ReposPanel v-if="modal === 'repos'" :repos="repos" @close="modal = null" />

    <SettingsPanel v-if="modal === 'settings'" :notifications="status?.notifications ?? []" @close="modal = null" />

    <div
      v-if="toast"
      class="fixed bottom-10 left-1/2 z-40 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-md bg-text px-3.5 py-2 text-bg"
    >
      {{ toast }}
    </div>
  </div>
</template>
