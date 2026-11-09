<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { PERSON_CALLS, api, isOffline } from './api/client';
import { isImmutable, liveStatusQuery, proposalCheckQuery, reposQuery, taskQuery, tasksQuery } from './api/queries';
import type { MergeResult, Repo, Status, TaskSummary, TaskDetail as Detail } from './api/types';
import { isNative, onOpenUrl, startDaemon } from './platform/native';
import { mode, setMode } from './platform/theme';
import NewTaskForm from './components/panels/NewTaskForm.vue';
import WaitBar from './components/layout/WaitBar.vue';
import ReposPanel from './components/panels/ReposPanel.vue';
import DaemonPanel from './components/panels/DaemonPanel.vue';
import SettingsPanel from './components/panels/SettingsPanel.vue';
import StaleDaemonBar from './components/layout/StaleDaemonBar.vue';
import AppHeader from './components/layout/AppHeader.vue';
import HotkeySheet from './components/layout/HotkeySheet.vue';
import StatusBar from './components/layout/StatusBar.vue';
import InsightsView from './components/insights/InsightsView.vue';
import QueueView from './components/queue/QueueView.vue';
import TaskPage from './components/task/TaskPage.vue';
import MergeDialog from './components/task/merge/MergeDialog.vue';
import ApproveDialog from './components/task/merge/ApproveDialog.vue';
import AppProvider from './components/ui/AppProvider.vue';
import CommandPalette from './components/ui/CommandPalette.vue';
import Toaster, { type ToastItem } from './components/ui/Toaster.vue';
import { useOpenNext } from './composables/queue/useOpenNext';
import { go, openTask, parseAppUrl, route, taskUrl } from './router';
import { type PersonEvent, openingTab } from './lib/task/task-view';
import { paletteItems } from './lib/shared/palette';
import { type ApproveItem, type ApprovePlan, approveDialog } from './lib/task/approve-dialog';
import { type BulkResult, bulkMessage } from './lib/queue/bulk';
import { requestedBulk, requestedEdit, requestedView } from './composables/shared/useView';
import { useHotkeys } from './composables/shared/useHotkeys';
import { usePicked } from './composables/queue/usePicked';
import { GO_KEYS, type GoTarget } from './lib/shared/hotkeys';
import { type Flash, UNDO_MS, provideActions, trackPending } from './composables/shared/useActions';
import { useChangeStream } from './composables/shared/useChangeStream';
import { approveDialogSetting, provideApprovals } from './composables/task/useApprovals';

const selectedId = ref<number | null>(null);
const toasts = ref<ToastItem[]>([]);
const modal = ref<'new' | 'repos' | 'settings' | 'daemon' | null>(null);

// A long message (a gh error, a sync that could not push) stays up long enough to read. Messages stack: a newer one does not
// replace an Undo toast. The toast lives here, so a page change keeps an Undo's wait going.
let toastId = 0;
const flash: Flash = (msg, action) => {
  const duration = action ? UNDO_MS : Math.min(Math.max(3500, msg.length * 60), 15_000);
  toasts.value = [...toasts.value, { id: ++toastId, message: msg, duration, action }];
};
const closeToast = (id: number) => {
  toasts.value = toasts.value.filter((t) => t.id !== id);
};

/** The task whose page is open, from the route. */
const pageId = computed(() => (route.current.name === 'task' ? route.current.id : null));

// The change stream refetches what is on screen; status also refetches on a timer (liveStatusQuery).
const statusQ = useQuery(liveStatusQuery());
const palette = ref(false);
const keySheet = ref(false);
// The list is read on every page: the palette searches every task and the status bar's activity list is built from it.
const tasksQ = useQuery(tasksQuery());
const taskQ = useQuery(computed(() => ({ ...taskQuery(pageId.value ?? 0), enabled: pageId.value !== null })));
useChangeStream();
const reposQ = useQuery(reposQuery());

const status = computed<Status | null>(() => statusQ.data.value ?? null);
const tasks = computed<TaskSummary[]>(() => tasksQ.data.value ?? []);
const repos = computed<Repo[]>(() => reposQ.data.value ?? []);
const detail = computed<Detail | null>(() => (pageId.value === null ? null : (taskQ.data.value ?? null)));
const offline = computed(() => isOffline(statusQ.error.value));
const starting = ref(false);
const startError = ref('');
async function start() {
  starting.value = true;
  startError.value = '';
  try {
    await startDaemon();
    // The status query refetches on its own and clears the offline screen once the daemon answers.
    void statusQ.refetch();
  } catch (e) {
    startError.value = e instanceof Error ? e.message : String(e);
  } finally {
    starting.value = false;
  }
}

// After a change any of it may have moved (the Repos panel adds, archives and edits repos too).
const queryClient = useQueryClient();
const actions = provideActions(() => queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) }), flash);
const { run: act, refresh } = actions;
// Pause and the two Resume buttons share one pending state; every other button has its own.
const { pending: pausing, run: pauseRun } = trackPending(actions);

watch(
  pageId,
  (id) => {
    if (id !== null) selectedId.value = id;
  },
  { immediate: true },
);

const togglePause = () => pauseRun(() => (status.value?.paused ? api.resume() : api.pause()));
// A reject waits 5 seconds behind an Undo toast before the API is called; an approve goes through the approve gate below;
// every other event goes at once.
const actOn = (kind: PersonEvent, id: number) =>
  kind === 'reject'
    ? actions.defer(`Rejected #${id}`, () => PERSON_CALLS.reject(id))
    : kind === 'approve'
      ? void approve([id])
      : act(() => PERSON_CALLS[kind](id));

// The approve gate: every way to approve comes here. It reads each task's proposal check, and opens the dialog when the setting
// and the checks say so; else it approves at once. A check that can't be read counts as nothing to show.
const approving = ref<{ items: ApproveItem[]; plan: ApprovePlan; resolve: (r: BulkResult[] | null) => void } | null>(null);
async function approveNow(ids: number[]): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const id of ids) {
    try {
      await PERSON_CALLS.approve(id);
      results.push({ id });
    } catch (e) {
      results.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await refresh();
  // One task that worked is the row changing; anything else is said.
  if (ids.length > 1 || results.some((r) => r.error !== undefined)) flash(bulkMessage('approve', results));
  return results;
}
async function approve(ids: number[]): Promise<BulkResult[] | null> {
  const setting = approveDialogSetting.value;
  if (setting === 'never') return approveNow(ids);
  const items = await Promise.all(
    ids.map(async (id) => ({
      id,
      check: await queryClient.fetchQuery({ ...proposalCheckQuery(id), staleTime: 0 }).catch(() => null),
    })),
  );
  const plan = approveDialog(items, setting);
  if (!plan.open) return approveNow(ids);
  return new Promise((resolve) => (approving.value = { items, plan, resolve }));
}
provideApprovals({ approve });
function onApproved(results: BulkResult[] | null) {
  approving.value?.resolve(results);
  approving.value = null;
}
const approveRows = computed(() =>
  (approving.value?.items ?? []).map((i) => ({ ...i, title: tasks.value.find((t) => t.id === i.id)?.title ?? '' })),
);
/** A task in review opens on its diff, the rest on the overview. */
function openFromQueue(id: number) {
  const t = tasks.value.find((x) => x.id === id);
  openTask(id, t ? openingTab(t) : 'overview');
}
// The command palette (⌘K). It lists the selected task's actions first; what each task allows is the daemon's rule (lib/palette.ts).
const merging = ref<number | null>(null);
const { nextAfter, openNext } = useOpenNext();
async function onMerged(result: MergeResult, next: boolean) {
  const id = merging.value;
  merging.value = null;
  if (next && id !== null) openNext(id);
  await refresh();
  if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
}
function onRequested(next: boolean) {
  const id = merging.value;
  merging.value = null;
  if (next && id !== null) openNext(id);
}
const selectedTask = computed(
  () => tasks.value.find((t) => t.id === selectedId.value) ?? (detail.value?.id === selectedId.value ? detail.value : null),
);
const { picked } = usePicked();
const pickedTasks = computed(() => tasks.value.filter((t) => picked.value.includes(t.id)));
// `g` then a key, and the palette's go commands: the queue and insights are routes, settings and repos panels.
function goTo(to: GoTarget) {
  if (to === 'settings' || to === 'repos') modal.value = to;
  else {
    modal.value = null;
    go({ name: to });
  }
}
useHotkeys({
  ...Object.fromEntries(GO_KEYS.map((g) => [g.key, { label: g.label, scope: 'app' as const, run: () => goTo(g.to) }])),
  '?': { label: 'Show the keys', scope: 'app', run: () => (keySheet.value = true) },
});
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
      verify: (id) => act(() => api.verify(id), { done: `Verify run started on #${id}` }),
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
          const res = await api.restartDaemon();
          flash(res.waiting ? `Waiting for ${res.waiting} to finish, then the daemon restarts.` : 'Restarting the daemon…');
        }),
      view: (m) => {
        requestedView.value = m;
        go({ name: 'queue' });
      },
      toggleTheme: () => setMode(mode.value === 'dark' ? 'light' : 'dark'),
      go: goTo,
      showKeys: () => (keySheet.value = true),
      showStates: (states) => {
        modal.value = null;
        go({ name: 'queue', states });
      },
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
  else {
    modal.value = null;
    go(to);
  }
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

const resumeDaemon = () => pauseRun(() => api.resume());
const resumeRepo = (id: number) => pauseRun(() => api.resumeRepo(id));

function onCreated(task: Detail) {
  modal.value = null;
  openTask(task.id);
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}
</script>

<template>
  <AppProvider>
    <div class="flex h-screen flex-col">
      <AppHeader :status="status" :offline="offline" @new-task="modal = 'new'" @repos="modal = 'repos'" @settings="modal = 'settings'" />

      <div v-if="offline" class="m-auto max-w-[420px] text-center">
        <h2 class="text-lg">The AgentDeck daemon isn't running</h2>
        <template v-if="isNative">
          <p class="text-muted">Start it here and this window will connect on its own.</p>
          <button class="primary" :disabled="starting" @click="start">{{ starting ? 'Starting…' : 'Start the daemon' }}</button>
          <p v-if="startError" class="mt-2 text-sm" role="alert">{{ startError }}</p>
        </template>
        <template v-else>
          <p class="text-muted">Start it in a terminal and this window will connect on its own:</p>
          <pre class="rounded-md border border-border bg-code-bg p-2.5">agentdeck service start</pre>
        </template>
      </div>

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
      <ApproveDialog v-if="approving" :rows="approveRows" :ticked="approving.plan.ticked" @done="onApproved" />
      <HotkeySheet v-if="keySheet" @close="keySheet = false" />
      <CommandPalette v-if="palette" :items="paletteRows" @close="palette = false" />

      <Toaster :toasts="toasts" @close="closeToast" />
    </div>
  </AppProvider>
</template>
