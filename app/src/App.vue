<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  type MergeResult,
  type Repo,
  type Status,
  type TaskSummary,
  type TaskDetail as Detail,
  api,
  describeState,
  isImmutable,
  isOffline,
  reposQuery,
  statusQuery,
  taskQuery,
  tasksQuery,
} from './api';
import { setTrayStatus } from './platform/native';
import { mode, setMode } from './platform/theme';
import NewTaskForm from './components/panels/NewTaskForm.vue';
import WaitBar from './components/layout/WaitBar.vue';
import ReposPanel from './components/panels/ReposPanel.vue';
import DaemonPanel from './components/panels/DaemonPanel.vue';
import SettingsPanel from './components/panels/SettingsPanel.vue';
import StaleDaemonBar from './components/layout/StaleDaemonBar.vue';
import AppHeader from './components/layout/AppHeader.vue';
import StatusBar from './components/layout/StatusBar.vue';
import QueueView from './components/queue/QueueView.vue';
import TaskPage from './components/task/TaskPage.vue';
import MergeDialog from './components/task/MergeDialog.vue';
import CommandPalette from './components/ui/CommandPalette.vue';
import { go, openTask, route } from './router';
import { type PersonEvent, needYouCount, openingTab } from './lib/taskView';
import { paletteItems } from './lib/palette';
import { requestedView } from './composables/useView';
import { provideActions } from './composables/useActions';
import { useChangeStream } from './composables/useChangeStream';

const STATUS_FALLBACK_MS = 30_000;

const selectedId = ref<number | null>(null);
const toast = ref('');
const modal = ref<'new' | 'repos' | 'settings' | 'daemon' | null>(null);

// A long message (a gh error, a sync that could not push) stays up long enough to read. A newer message replaces it.
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function flash(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), Math.min(Math.max(3500, msg.length * 60), 15_000));
}

/** The task whose page is open, from the route. */
const pageId = computed(() => (route.current.name === 'task' ? route.current.id : null));

// The change stream refetches what is on screen. Status also refetches every 30 s, hidden or not: waits (a governor
// hold lifting) change with time, not with a write, and the tray label reads it.
const statusQ = useQuery({ ...statusQuery(), refetchInterval: STATUS_FALLBACK_MS, refetchIntervalInBackground: true });
const palette = ref(false);
// The palette searches every task, also from a task page, which doesn't otherwise load the list.
const tasksQ = useQuery(computed(() => ({ ...tasksQuery(), enabled: pageId.value === null || palette.value })));
const taskQ = useQuery(computed(() => ({ ...taskQuery(pageId.value ?? 0), enabled: pageId.value !== null })));
useChangeStream();
const reposQ = useQuery(reposQuery());

const status = computed<Status | null>(() => statusQ.data.value ?? null);
const tasks = computed<TaskSummary[]>(() => tasksQ.data.value ?? []);
const repos = computed<Repo[]>(() => reposQ.data.value ?? []);
const detail = computed<Detail | null>(() => (pageId.value === null ? null : (taskQ.data.value ?? null)));
const offline = computed(() => isOffline(statusQ.error.value));

// After a change any of it may have moved (the Repos panel adds, archives and edits repos too).
const queryClient = useQueryClient();
const { busy, run: act } = provideActions(() => queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) }), flash);

watch(
  pageId,
  (id) => {
    if (id !== null) selectedId.value = id;
  },
  { immediate: true },
);

const togglePause = () => act(() => (status.value?.paused ? api.resume() : api.pause()));
const ACTIONS: Record<PersonEvent, (id: number) => Promise<unknown>> = {
  approve: api.approve,
  reject: api.reject,
  retry: api.retry,
  cancel: api.cancel,
  mark_done: api.markDone,
};
const actOn = (kind: PersonEvent, id: number) => act(() => ACTIONS[kind](id));
/** A task in review opens on its diff, the rest on the overview. */
function openFromQueue(id: number) {
  const t = tasks.value.find((x) => x.id === id);
  openTask(id, t ? openingTab(t) : 'overview');
}
// The command palette (⌘K). It lists the selected task's actions first; what each task allows is the daemon's rule (lib/palette.ts).
const merging = ref<number | null>(null);
async function onMerged(result: MergeResult) {
  merging.value = null;
  await queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) });
  if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
}
const selectedTask = computed(
  () => tasks.value.find((t) => t.id === selectedId.value) ?? (detail.value?.id === selectedId.value ? detail.value : null),
);
const paletteRows = computed(() =>
  paletteItems({
    tasks: tasks.value,
    selected: selectedTask.value,
    paused: !!status.value?.paused,
    handlers: {
      open: openFromQueue,
      act: actOn,
      merge: (id) => (merging.value = id),
      newTask: () => (modal.value = 'new'),
      togglePause,
      restartDaemon: () =>
        act(async () => {
          const res = await api.restartDaemon();
          flash(res.waiting ? `Waiting for ${res.waiting} to finish, then the daemon restarts.` : 'Restarting the daemon…');
        }),
      view: (m) => {
        requestedView.value = m;
        go({ name: 'queue' });
      },
      toggleTheme: () => setMode(mode.value === 'dark' ? 'light' : 'dark'),
    },
  }),
);
function onPaletteKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
  e.preventDefault();
  palette.value = !palette.value;
}
onMounted(() => window.addEventListener('keydown', onPaletteKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onPaletteKey));

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

    <StatusBar :status="status" :offline="offline" :busy="busy" @toggle="togglePause" @daemon="modal = 'daemon'" />

    <NewTaskForm v-if="modal === 'new'" :repos="repos" @close="modal = null" @created="onCreated" @repos="modal = 'repos'" />
    <ReposPanel v-if="modal === 'repos'" :repos="repos" @close="modal = null" />

    <SettingsPanel v-if="modal === 'settings'" :notifications="status?.notifications ?? []" @close="modal = null" />
    <DaemonPanel v-if="modal === 'daemon'" @close="modal = null" />

    <MergeDialog v-if="merging !== null" :task-id="merging" @close="merging = null" @merged="onMerged" />
    <CommandPalette v-if="palette" :items="paletteRows" @close="palette = false" />

    <div
      v-if="toast"
      class="fixed bottom-10 left-1/2 z-40 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-md bg-text px-3.5 py-2 text-bg"
    >
      {{ toast }}
    </div>
  </div>
</template>
