<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { type TaskDetail, ago, api } from '../../api';
import AutoMergeMark from '../ui/AutoMergeMark.vue';
import { openExternal, useCopy } from '../../platform/native';
import { PRIORITY_LEVELS, canEdit, priorityLevel, statusLabel } from '../../lib/taskView';
import { useActions } from '../../composables/useActions';
import { useTerminal } from '../../composables/useTerminal';
import InlineEdit from '../ui/InlineEdit.vue';
import PriorityIcon from '../ui/PriorityIcon.vue';
import StatusIcon from '../ui/StatusIcon.vue';

// Task properties, GitHub-sidebar style. Priority, model and turns are editable while the task is.
const props = defineProps<{ task: TaskDetail }>();
const { run, flash } = useActions();

const editable = computed(() => canEdit(props.task));
const { copied, copy } = useCopy();
const terminal = useTerminal();

function openWorktree() {
  const dir = props.task.worktree;
  if (dir) run(() => terminal.open(`#${props.task.id} ${props.task.title}`, dir));
}

// An edit is saved from the field's own value; a refused one leaves the task unchanged, so the saved value shows again.
async function save(field: 'priority' | 'model' | 'max_turns', text: string) {
  const value = text.trim();
  if (value === String(props.task[field])) return;
  await run(() => api.editTask(props.task.id, { [field]: field === 'model' ? value : Number(value) }));
}

// Auto-merge: the task's own setting, or its repo's. Moot once the PR is merged or closed, or the task cancelled.
const autoMergeShown = computed(() => props.task.status !== 'cancelled' && !['merged', 'closed'].includes(props.task.pr_state ?? ''));
const AUTO_MERGE = [
  { label: "The repo's setting", stored: null, value: null },
  { label: 'On for this task', stored: 1, value: true },
  { label: 'Off for this task', stored: 0, value: false },
] as const;
const savedAutoMerge = computed(() => AUTO_MERGE.findIndex((o) => o.stored === props.task.auto_merge));
// The select shows the saved value: after a save that failed it goes back to it, instead of keeping the refused choice.
async function setAutoMerge(select: HTMLSelectElement) {
  const { value: auto_merge } = AUTO_MERGE[select.selectedIndex];
  await run(async () => {
    const res = await api.autoMerge(props.task.id, { auto_merge });
    if (res.label_error) flash(`Saved, but the PR's label could not be changed: ${res.label_error}`);
  });
  await nextTick();
  select.selectedIndex = savedAutoMerge.value;
}

const AUTO_MERGE_TEXT = { off: 'text-muted', on: 'text-muted', merge: 'text-done', wait: 'text-blocked', never: 'text-failed' } as const;

const levelLabel = computed(() => PRIORITY_LEVELS.find((l) => l.key === priorityLevel(props.task.priority))!.label);

// One property: a name over a value. The value is a row, or a button that looks like one and shows a border on hover when it can be edited.
const prop = 'border-b border-border py-2';
const name = 'mb-[3px] text-sm text-muted';
const row = 'flex min-h-6 min-w-0 items-center gap-1.5';
const rowButton = `${row} -ml-1.5 w-[calc(100%+6px)] border border-transparent bg-transparent px-1.5 py-0 text-left disabled:opacity-100`;
const rowButtonEditable = 'hover:border-border hover:bg-panel-2';
const rowMono = `${row} font-mono text-sm leading-[normal]`;
const input = 'px-1.5 py-0.5';
</script>

<template>
  <aside class="flex w-60 flex-none flex-col gap-0.5 max-md:w-full">
    <div :class="prop">
      <div :class="name">Status</div>
      <div :class="row"><StatusIcon :task="task" /> {{ statusLabel(task.status) }}</div>
    </div>
    <div :class="prop">
      <div :class="name">Priority</div>
      <InlineEdit
        v-if="editable"
        label="Priority"
        type="number"
        :value="String(task.priority)"
        :preview-class="`${rowButton} ${rowButtonEditable} cursor-pointer`"
        :input-class="input"
        @submit="(v) => save('priority', v)"
      >
        <PriorityIcon :priority="task.priority" /> {{ levelLabel }} <span class="text-muted">{{ task.priority }}</span>
      </InlineEdit>
      <div v-else :class="row">
        <PriorityIcon :priority="task.priority" /> {{ levelLabel }} <span class="text-muted">{{ task.priority }}</span>
      </div>
    </div>
    <div :class="prop">
      <div :class="name">Repo</div>
      <div :class="row">{{ task.repo }}</div>
    </div>
    <div :class="prop">
      <div :class="name">Model</div>
      <InlineEdit
        v-if="editable"
        label="Model"
        :value="task.model"
        :preview-class="`${rowButton} ${rowButtonEditable} cursor-pointer`"
        :input-class="input"
        @submit="(v) => save('model', v)"
      />
      <div v-else :class="row">{{ task.model }}</div>
    </div>
    <div :class="prop">
      <div :class="name">Attempts</div>
      <div :class="row">{{ task.attempts }} / {{ task.max_attempts }}</div>
    </div>
    <div :class="prop">
      <div :class="name">Max turns</div>
      <InlineEdit
        v-if="editable"
        label="Max turns"
        type="number"
        :value="String(task.max_turns)"
        :preview-class="`${rowButton} ${rowButtonEditable} cursor-pointer`"
        :input-class="input"
        @submit="(v) => save('max_turns', v)"
      />
      <div v-else :class="row">{{ task.max_turns }}</div>
    </div>
    <div v-if="task.pr_url" :class="prop">
      <div :class="name">Pull request</div>
      <button :class="[rowButton, 'text-accent']" @click="openExternal(task.pr_url)">{{ task.pr_state ?? 'open' }} ↗</button>
    </div>
    <div v-if="autoMergeShown" :class="prop">
      <div :class="name">Auto-merge</div>
      <select
        class="w-full px-1.5 py-0.5"
        aria-label="Auto-merge"
        :value="savedAutoMerge"
        @change="setAutoMerge($event.target as HTMLSelectElement)"
      >
        <option v-for="(o, i) in AUTO_MERGE" :key="o.label" :value="i">{{ o.label }}</option>
      </select>
      <div v-if="task.auto_merge_view" class="mt-1.5 flex flex-col gap-1 text-sm" data-auto-merge-detail>
        <AutoMergeMark :view="task.auto_merge_view" class="self-start" />
        <span v-if="task.auto_merge_view.state === 'off'" class="text-muted">{{ task.auto_merge_view.label }}</span>
        <ul v-if="task.auto_merge_view.reasons.length" class="m-0 list-disc pl-4" :class="AUTO_MERGE_TEXT[task.auto_merge_view.state]">
          <li v-for="r in task.auto_merge_view.reasons" :key="r">{{ r }}</li>
        </ul>
        <span v-if="task.auto_merge_view.checked_at" class="text-muted">Checked {{ ago(task.auto_merge_view.checked_at) }}</span>
        <span class="text-muted">
          Limits: {{ task.auto_merge_view.limits.max_lines }} lines
          <template v-if="task.auto_merge_view.limits.skip.length">
            · not under <span class="font-mono">{{ task.auto_merge_view.limits.skip.join(', ') }}</span>
          </template>
          · tests {{ task.auto_merge_view.limits.tests }}
        </span>
      </div>
    </div>
    <div v-if="task.branch" :class="prop">
      <div :class="name">Branch</div>
      <div :class="rowMono">
        <span class="flex-1 truncate" :title="task.branch">{{ task.branch }}</span>
        <button class="px-1.5 py-0 text-xs" @click="copy(task.branch, 'branch')">{{ copied === 'branch' ? '✓' : 'copy' }}</button>
      </div>
    </div>
    <div v-if="task.worktree" :class="prop">
      <div :class="name">Worktree</div>
      <div :class="rowMono">
        <span class="flex-1 truncate" :title="task.worktree">{{ task.worktree.split('/').slice(-2).join('/') }}</span>
        <button v-if="terminal.available.value" class="px-1.5 py-0 text-xs" @click="openWorktree">open in {{ terminal.name() }}</button>
        <button class="px-1.5 py-0 text-xs" @click="copy(task.worktree, 'wt')">{{ copied === 'wt' ? '✓' : 'copy' }}</button>
      </div>
    </div>
    <div :class="prop">
      <div :class="name">Source</div>
      <div :class="row">{{ task.source === 'planner' ? 'Planner' : 'Added by you' }}</div>
    </div>
  </aside>
</template>
