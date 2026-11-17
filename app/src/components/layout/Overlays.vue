<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { reposQuery } from '#api/repos.ts';
import { tasksQuery } from '#api/work.ts';
import type { TaskDetail } from '#api/types.ts';
import { useActions } from '#composables/shared/useActions.ts';
import { usePause } from '#composables/shared/usePause.ts';
import { useShell } from '#composables/shared/useShell.ts';
import { useToasts } from '#composables/shared/useToasts.ts';
import { usePicked } from '#composables/work/queue/usePicked.ts';
import { useApprovals } from '#composables/work/useApprovals.ts';
import { useMergeDialog } from '#composables/work/useMergeDialog.ts';
import { usePaletteCommands } from '#composables/work/usePaletteCommands.ts';
import { useRouter } from 'vue-router';
import MergeDialog from '#components/landing/MergeDialog.vue';
import DaemonPanel from '#components/operations/DaemonPanel.vue';
import SettingsPanel from '#components/operations/SettingsPanel.vue';
import ReposPanel from '#components/repos/ReposPanel.vue';
import CommandPalette from '#components/ui/CommandPalette.vue';
import Toaster from '#components/ui/Toaster.vue';
import ApproveDialog from '#components/work/task/ApproveDialog.vue';
import NewTaskForm from '#components/work/task/NewTaskForm.vue';
import HotkeySheet from '#components/layout/HotkeySheet.vue';

const router = useRouter();
const { panel, palette, keySheet, selectedId, closePanel, closePalette, closeKeys } = useShell();
const { toasts, flash, close: closeToast } = useToasts();
const actions = useActions();
const approvals = useApprovals();
const { approving, answer: answerApproval } = approvals;
const { status, togglePause } = usePause();
const { picked } = usePicked();

const tasksQ = useQuery(tasksQuery());
const reposQ = useQuery(reposQuery());
const tasks = computed(() => tasksQ.data.value ?? []);
const repos = computed(() => reposQ.data.value ?? []);

const approveRows = computed(() =>
  (approving.value?.items ?? []).map((i) => ({ ...i, title: tasks.value.find((t) => t.id === i.id)?.title ?? '' })),
);
const paletteRows = usePaletteCommands(
  {
    tasks: () => tasks.value,
    selected: () => tasks.value.find((t) => t.id === selectedId.value) ?? null,
    picked: () => tasks.value.filter((t) => picked.value.includes(t.id)),
    paused: () => !!status.value?.paused,
    togglePause,
  },
  actions,
  approvals,
);
const mergeDialog = useMergeDialog(actions);
const { merging } = mergeDialog;

function onCreated(task: TaskDetail) {
  closePanel();
  void router.push({ name: 'task', params: { id: task.id } });
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}
</script>

<template>
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
</template>
