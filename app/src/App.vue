<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { isOffline, refreshAll } from './api/http';
import { liveStatusQuery, operationsApi } from './api/operations';
import { reposApi, reposQuery } from './api/repos';
import { runsApi } from './api/runs';
import { PERSON_CALLS, taskQuery, tasksQuery } from './api/work';
import type { MergeResult, Repo, Status, TaskDetail, TaskSummary } from './api/types';
import { isNative, onOpenUrl } from './platform/native';
import { mode, setMode } from './platform/theme';
import NewTaskForm from './components/work/task/NewTaskForm.vue';
import WaitBar from './components/layout/WaitBar.vue';
import ReposPanel from './components/repos/ReposPanel.vue';
import DaemonPanel from './components/operations/DaemonPanel.vue';
import SettingsPanel from './components/operations/SettingsPanel.vue';
import StaleDaemonBar from './components/layout/StaleDaemonBar.vue';
import AppHeader from './components/layout/AppHeader.vue';
import HotkeySheet from './components/layout/HotkeySheet.vue';
import OfflineScreen from './components/layout/OfflineScreen.vue';
import StatusBar from './components/layout/StatusBar.vue';
import InsightsView from './components/insights/InsightsView.vue';
import QueueView from './components/work/queue/QueueView.vue';
import TaskPage from './pages/TaskPage.vue';
import MergeDialog from './components/landing/MergeDialog.vue';
import ApproveDialog from './components/work/task/ApproveDialog.vue';
import AppProvider from './components/ui/AppProvider.vue';
import CommandPalette from './components/ui/CommandPalette.vue';
import Toaster from './components/ui/Toaster.vue';
import { useOpenNext } from './composables/work/queue/useOpenNext';
import { type Route, go, openTask, parseAppUrl, route, taskUrl } from './router';
import { type PersonEvent } from '../../daemon/src/domain/work/index.ts';
import { openingTab } from './lib/work/task-view';
import { paletteItems } from './lib/work/palette';
import { requestedBulk, requestedEdit, requestedView } from './composables/work/queue/useView';
import { useHotkeys } from './composables/shared/useHotkeys';
import { usePicked } from './composables/work/queue/usePicked';
import { GO_KEYS, type GoTarget } from './lib/shared/hotkeys';
import { provideActions, trackPending } from './composables/shared/useActions';
import { useChangeStream } from './composables/shared/useChangeStream';
import { useToasts } from './composables/shared/useToasts';
import { provideApprovals } from './composables/work/useApprovals';

const modal = ref<'new' | 'repos' | 'settings' | 'daemon' | null>(null);
const palette = ref(false);
const keySheet = ref(false);
const { toasts, flash, close: closeToast } = useToasts();

/** The task whose page is open, from the route. */
const pageId = computed(() => (route.current.name === 'task' ? route.current.id : null));

// The change stream refetches what is on screen; status also refetches on a timer (liveStatusQuery).
const statusQ = useQuery(liveStatusQuery());
// The list is read on every page: the palette searches every task and the status bar's activity list is built from it.
const tasksQ = useQuery(tasksQuery());
const taskQ = useQuery(computed(() => ({ ...taskQuery(pageId.value ?? 0), enabled: pageId.value !== null })));
useChangeStream();
const reposQ = useQuery(reposQuery());

const status = computed<Status | null>(() => statusQ.data.value ?? null);
const tasks = computed<TaskSummary[]>(() => tasksQ.data.value ?? []);
const repos = computed<Repo[]>(() => reposQ.data.value ?? []);
const detail = computed<TaskDetail | null>(() => (pageId.value === null ? null : (taskQ.data.value ?? null)));
const offline = computed(() => isOffline(statusQ.error.value));
const refetchStatus = () => void statusQ.refetch();

// After a change any of it may have moved (the Repos panel adds, archives and edits repos too).
const queryClient = useQueryClient();
const actions = provideActions(() => refreshAll(queryClient), flash);
const { run: act, refresh } = actions;
// Every way to approve goes through this gate; App shows its dialog.
const { approve, approving, answer: answerApproval } = provideApprovals(queryClient, actions);

// Pause and the two Resume buttons share one pending state; every other button has its own.
const { pending: pausing, run: pauseRun } = trackPending(actions);
const togglePause = () => pauseRun(() => (status.value?.paused ? operationsApi.resume() : operationsApi.pause()));
const resumeDaemon = () => pauseRun(() => operationsApi.resume());
const resumeRepo = (id: number) => pauseRun(() => reposApi.resumeRepo(id));

const selectedId = ref<number | null>(null);
watch(
  pageId,
  (id) => {
    if (id !== null) selectedId.value = id;
  },
  { immediate: true },
);
const selectedTask = computed(
  () => tasks.value.find((t) => t.id === selectedId.value) ?? (detail.value?.id === selectedId.value ? detail.value : null),
);
const { picked } = usePicked();
const pickedTasks = computed(() => tasks.value.filter((t) => picked.value.includes(t.id)));

// A reject waits 5 seconds behind an Undo toast before the API is called; an approve goes through the approve gate;
// every other event goes at once.
const actOn = (kind: PersonEvent, id: number) =>
  kind === 'reject'
    ? actions.defer(`Rejected #${id}`, () => PERSON_CALLS.reject(id))
    : kind === 'approve'
      ? void approve([id])
      : act(() => PERSON_CALLS[kind](id));
const approveRows = computed(() =>
  (approving.value?.items ?? []).map((i) => ({ ...i, title: tasks.value.find((t) => t.id === i.id)?.title ?? '' })),
);

// The merge dialog, for the task being merged. Closing it after a merge or a merge request may open the next task in review.
const merging = ref<number | null>(null);
const { nextAfter, openNext } = useOpenNext();
function onRequested(next: boolean) {
  const id = merging.value;
  merging.value = null;
  if (next && id !== null) openNext(id);
}
async function onMerged(result: MergeResult, next: boolean) {
  onRequested(next);
  await refresh();
  if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
}

/** A task in review opens on its diff, the rest on the overview. */
function openFromQueue(id: number) {
  const t = tasks.value.find((x) => x.id === id);
  openTask(id, t ? openingTab(t) : 'overview');
}
/** Go to a page, closing any panel. */
function goPage(to: Route) {
  modal.value = null;
  go(to);
}
// `g` then a key, and the palette's go commands: the queue and insights are routes, settings and repos panels.
function goTo(to: GoTarget) {
  if (to === 'settings' || to === 'repos') modal.value = to;
  else goPage({ name: to });
}
useHotkeys({
  ...Object.fromEntries(GO_KEYS.map((g) => [g.key, { label: g.label, scope: 'app' as const, run: () => goTo(g.to) }])),
  '?': { label: 'Show the keys', scope: 'app', run: () => (keySheet.value = true) },
});

// The command palette (⌘K). It lists the selected task's actions first; what each task allows is the daemon's rule (lib/palette.ts).
const paletteRows = computed(() =>
  paletteItems({
    tasks: tasks.value,
    selected: selectedTask.value,
    picked: pickedTasks.value,
    paused: !!status.value?.paused,
    handlers: {
      open: openFromQueue,
      act: actOn,
      merge: (id) => (merging.value = id),
      verify: (id) => act(() => runsApi.verify(id), { done: `Verify run started on #${id}` }),
      copyLink: (id) => {
        navigator.clipboard.writeText(taskUrl(id)).then(
          () => flash(`Copied ${taskUrl(id)}`),
          () => flash('Could not copy the link'),
        );
      },
      newTask: () => (modal.value = 'new'),
      togglePause,
      restartDaemon: () =>
        act(async () => {
          const res = await operationsApi.restartDaemon();
          flash(res.waiting ? `Waiting for ${res.waiting} to finish, then the daemon restarts.` : 'Restarting the daemon…');
        }),
      view: (m) => {
        requestedView.value = m;
        go({ name: 'queue' });
      },
      toggleTheme: () => setMode(mode.value === 'dark' ? 'light' : 'dark'),
      go: goTo,
      showKeys: () => (keySheet.value = true),
      showStates: (states) => goPage({ name: 'queue', states }),
      // Edits and bulk actions are done by the page that is open; on a page without one (insights) go to the queue first.
      edit: (request) => {
        if (route.current.name !== 'queue' && route.current.name !== 'task') go({ name: 'queue' });
        requestedEdit.value = request;
      },
      bulk: (action) => {
        if (route.current.name !== 'queue') go({ name: 'queue' });
        requestedBulk.value = action;
      },
    },
  }),
);
// In the desktop app the View menu owns ⌘K (it arrives as agentdeck://palette); this handler is for the plain browser.
function onPaletteKey(e: KeyboardEvent) {
  if (isNative) return;
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
  e.preventDefault();
  palette.value = !palette.value;
}
// An agentdeck:// link opened from outside (the shell's open_in_dashboard) routes here, or opens the form.
function openLink(url: string) {
  const to = parseAppUrl(url);
  if (!to) return;
  if (to.name === 'palette') palette.value = !palette.value;
  else if (to.name === 'new') modal.value = 'new';
  else if (to.name === 'panel') modal.value = to.panel;
  else goPage(to);
}
let stopOpenUrl = () => {};
let unmounted = false;
onMounted(() => {
  window.addEventListener('keydown', onPaletteKey);
  onOpenUrl(openLink).then((stop) => (unmounted ? stop() : (stopOpenUrl = stop)));
});
onBeforeUnmount(() => {
  unmounted = true;
  stopOpenUrl();
  window.removeEventListener('keydown', onPaletteKey);
});

function onCreated(task: TaskDetail) {
  modal.value = null;
  openTask(task.id);
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}
</script>

<template>
  <AppProvider>
    <div class="flex h-screen flex-col">
      <AppHeader :status="status" :offline="offline" @new-task="modal = 'new'" @repos="modal = 'repos'" @settings="modal = 'settings'" />

      <OfflineScreen v-if="offline" @started="refetchStatus" />

      <main v-else-if="pageId !== null" class="flex min-h-0 flex-1 flex-col">
        <StaleDaemonBar :status="status" />
        <TaskPage
          v-if="detail && route.current.name === 'task'"
          :key="detail.id"
          :task="detail"
          :tab="route.current.tab"
          :query="route.current.query"
          @act="(kind) => actOn(kind, detail!.id)"
          @new-task="modal = 'new'"
        />
        <section v-else class="text-muted flex flex-1 flex-col items-center justify-center gap-3">Loading task #{{ pageId }}…</section>
      </main>
      <main v-else-if="route.current.name === 'insights'" class="flex min-h-0 flex-1 flex-col">
        <InsightsView />
      </main>
      <main v-else class="flex min-h-0 flex-1 flex-col">
        <StaleDaemonBar :status="status" />
        <WaitBar :status="status" :busy="pausing" @resume="resumeDaemon" @resume-repo="resumeRepo" @settings="modal = 'settings'" />
        <QueueView
          v-if="tasks.length"
          v-model:selected="selectedId"
          :tasks="tasks"
          @open="openFromQueue"
          @act="actOn"
          @new-task="modal = 'new'"
        />
        <section v-else class="text-muted flex flex-1 flex-col items-center justify-center gap-3">
          No tasks yet.
          <button class="primary" @click="modal = repos.length ? 'new' : 'repos'">
            {{ repos.length ? 'Queue your first task' : 'Add a repo to get started' }}
          </button>
        </section>
      </main>

      <StatusBar :status="status" :tasks="tasks" :offline="offline" :busy="pausing" @toggle="togglePause" @daemon="modal = 'daemon'" />

      <NewTaskForm v-if="modal === 'new'" :repos="repos" @close="modal = null" @created="onCreated" @repos="modal = 'repos'" />
      <ReposPanel v-if="modal === 'repos'" :repos="repos" @close="modal = null" />

      <SettingsPanel v-if="modal === 'settings'" :notifications="status?.notifications ?? []" @close="modal = null" />
      <DaemonPanel v-if="modal === 'daemon'" @close="modal = null" />

      <MergeDialog
        v-if="merging !== null"
        :task-id="merging"
        :has-next="!!nextAfter(merging)"
        @close="merging = null"
        @merged="onMerged"
        @requested="onRequested"
      />
      <ApproveDialog v-if="approving" :rows="approveRows" :ticked="approving.plan.ticked" @done="answerApproval" />
      <HotkeySheet v-if="keySheet" @close="keySheet = false" />
      <CommandPalette v-if="palette" :items="paletteRows" @close="palette = false" />

      <Toaster :toasts="toasts" @close="closeToast" />
    </div>
  </AppProvider>
</template>
