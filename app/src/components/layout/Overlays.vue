<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { reposQuery } from '../../api/repos';
import { tasksQuery } from '../../api/work';
import type { TaskDetail } from '../../api/types';
import { useActions } from '../../composables/shared/useActions';
import { usePause } from '../../composables/shared/usePause';
import { useShell } from '../../composables/shared/useShell';
import { useToasts } from '../../composables/shared/useToasts';
import { usePicked } from '../../composables/work/queue/usePicked';
import { useApprovals } from '../../composables/work/useApprovals';
import { useMergeDialog } from '../../composables/work/useMergeDialog';
import { usePaletteCommands } from '../../composables/work/usePaletteCommands';
import { openTask } from '../../router';
import MergeDialog from '../landing/MergeDialog.vue';
import DaemonPanel from '../operations/DaemonPanel.vue';
import SettingsPanel from '../operations/SettingsPanel.vue';
import ReposPanel from '../repos/ReposPanel.vue';
import CommandPalette from '../ui/CommandPalette.vue';
import Toaster from '../ui/Toaster.vue';
import ApproveDialog from '../work/task/ApproveDialog.vue';
import NewTaskForm from '../work/task/NewTaskForm.vue';
import HotkeySheet from './HotkeySheet.vue';

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
  openTask(task.id);
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
