<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { isOffline, refreshAll } from './api/http';
import { liveStatusQuery, operationsApi } from './api/operations';
import { reposApi, reposQuery } from './api/repos';
import { taskQuery, tasksQuery } from './api/work';
import type { Repo, Status, TaskDetail, TaskSummary } from './api/types';
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
import { openTask, route } from './router';
import { usePicked } from './composables/work/queue/usePicked';
import { provideActions, trackPending } from './composables/shared/useActions';
import { useAppLinks } from './composables/shared/useAppLinks';
import { useChangeStream } from './composables/shared/useChangeStream';
import { useShell } from './composables/shared/useShell';
import { useToasts } from './composables/shared/useToasts';
import { provideApprovals } from './composables/work/useApprovals';
import { useMergeDialog } from './composables/work/useMergeDialog';
import { usePaletteCommands, useTaskActs } from './composables/work/usePaletteCommands';

const { toasts, flash, close: closeToast } = useToasts();
const { panel, palette, keySheet, openPanel, closePanel, closePalette, closeKeys } = useShell();

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
// Every way to approve goes through this gate; App shows its dialog.
const approvals = provideApprovals(queryClient, actions);
const { approving, answer: answerApproval } = approvals;

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

const { actOn, openFromQueue } = useTaskActs(() => tasks.value, actions, approvals);
const approveRows = computed(() =>
  (approving.value?.items ?? []).map((i) => ({ ...i, title: tasks.value.find((t) => t.id === i.id)?.title ?? '' })),
);
const paletteRows = usePaletteCommands(
  {
    tasks: () => tasks.value,
    selected: () => selectedTask.value,
    picked: () => tasks.value.filter((t) => picked.value.includes(t.id)),
    paused: () => !!status.value?.paused,
    togglePause,
  },
  actions,
  approvals,
);
const mergeDialog = useMergeDialog(actions);
const { merging } = mergeDialog;
useAppLinks();

function onCreated(task: TaskDetail) {
  closePanel();
  openTask(task.id);
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}
</script>

<template>
  <AppProvider>
    <div class="flex h-screen flex-col">
      <AppHeader :status="status" :offline="offline" />

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
        />
        <section v-else class="text-muted flex flex-1 flex-col items-center justify-center gap-3">Loading task #{{ pageId }}…</section>
      </main>
      <main v-else-if="route.current.name === 'insights'" class="flex min-h-0 flex-1 flex-col">
        <InsightsView />
      </main>
      <main v-else class="flex min-h-0 flex-1 flex-col">
        <StaleDaemonBar :status="status" />
        <WaitBar :status="status" :busy="pausing" @resume="resumeDaemon" @resume-repo="resumeRepo" />
        <QueueView v-if="tasks.length" v-model:selected="selectedId" :tasks="tasks" @open="openFromQueue" @act="actOn" />
        <section v-else class="text-muted flex flex-1 flex-col items-center justify-center gap-3">
          No tasks yet.
          <button class="primary" @click="openPanel(repos.length ? 'new' : 'repos')">
            {{ repos.length ? 'Queue your first task' : 'Add a repo to get started' }}
          </button>
        </section>
      </main>

      <StatusBar :status="status" :tasks="tasks" :offline="offline" :busy="pausing" @toggle="togglePause" />

      <NewTaskForm v-if="panel === 'new'" :repos="repos" @close="closePanel" @created="onCreated" />
      <ReposPanel v-if="panel === 'repos'" :repos="repos" @close="closePanel" />

      <SettingsPanel v-if="panel === 'settings'" :notifications="status?.notifications ?? []" @close="closePanel" />
      <DaemonPanel v-if="panel === 'daemon'" @close="closePanel" />

      <MergeDialog
        v-if="merging !== null"
        :task-id="merging"
        :has-next="!!mergeDialog.nextAfter(merging)"
        @close="mergeDialog.close"
        @merged="mergeDialog.onMerged"
        @requested="mergeDialog.onRequested"
      />
      <ApproveDialog v-if="approving" :rows="approveRows" :ticked="approving.plan.ticked" @done="answerApproval" />
      <HotkeySheet v-if="keySheet" @close="closeKeys" />
      <CommandPalette v-if="palette" :items="paletteRows" @close="closePalette" />

      <Toaster :toasts="toasts" @close="closeToast" />
    </div>
  </AppProvider>
</template>
