<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { landingApi } from '../../../api/landing';
import { workApi } from '../../../api/work';
import { ago } from '../../../lib/shared/time';
import type { TaskDetail } from '../../../api/types';
import AutoMergeMark from '../../ui/status/AutoMergeMark.vue';
import { isNative, openExternal, revealInFinder, runTemplate, useCopy } from '../../../platform/native';
import { editorArgv, editorTemplate } from '../../../lib/runs/terminal';
import { canEdit, levelOf, priorityLevel, statusLabel } from '../../../lib/work/task-view';
import { useActions } from '../../../composables/shared/useActions';
import { useTerminal } from '../../../composables/runs/useTerminal';
import { useFixTask } from '../../../composables/work/useFixTask';
import PriorityIcon from '../../ui/status/PriorityIcon.vue';
import StatusIcon from '../../ui/status/StatusIcon.vue';
import EditableProp from '../overview/EditableProp.vue';
import { name, prop, row, rowButton, rowMono } from './sidebar-style';

const props = defineProps<{ task: TaskDetail }>();
const { run, flash } = useActions();

const editable = computed(() => canEdit(props.task));
const { copied, copy } = useCopy();
const terminal = useTerminal();
const { canFixHere, fix } = useFixTask();

function openWorktree() {
  const dir = props.task.worktree;
  if (dir) run(() => terminal.open(`#${props.task.id} ${props.task.title}`, dir));
}

function revealWorktree() {
  const dir = props.task.worktree;
  if (dir) run(() => revealInFinder(dir));
}

const editorSet = () => isNative && !!editorTemplate();
function openInEditor() {
  const dir = props.task.worktree;
  if (dir) run(() => runTemplate(editorArgv(), { cwd: dir }));
}

const FIELD_NAMES = { priority: 'Priority', model: 'Model', max_turns: 'Max turns' } as const;
async function save(field: 'priority' | 'model' | 'max_turns', text: string) {
  const value = text.trim();
  if (value === String(props.task[field])) return;
  if (!value) return flash(`${FIELD_NAMES[field]} can't be empty.`);
  await run(() => workApi.editTask(props.task.id, { [field]: field === 'model' ? value : Number(value) }));
}

const autoMergeShown = computed(() => props.task.status !== 'cancelled' && !['merged', 'closed'].includes(props.task.pr_state ?? ''));
const AUTO_MERGE = [
  { label: "The repo's setting", stored: null, value: null },
  { label: 'On for this task', stored: 1, value: true },
  { label: 'Off for this task', stored: 0, value: false },
] as const;
const savedAutoMerge = computed(() => AUTO_MERGE.findIndex((o) => o.stored === props.task.auto_merge));
async function setAutoMerge(select: HTMLSelectElement) {
  const { value: auto_merge } = AUTO_MERGE[select.selectedIndex];
  await run(async () => {
    const res = await landingApi.autoMerge(props.task.id, { auto_merge });
    if (res.label_error) flash(`Saved, but the PR's label could not be changed: ${res.label_error}`);
  });
  await nextTick();
  select.selectedIndex = savedAutoMerge.value;
}

const AUTO_MERGE_TEXT = { off: 'text-muted', on: 'text-muted', merge: 'text-done', wait: 'text-blocked', never: 'text-failed' } as const;

const levelLabel = computed(() => levelOf(priorityLevel(props.task.priority)).label);
</script>

<template>
  <aside class="flex w-60 flex-none flex-col gap-0.5 max-md:w-full">
    <div :class="prop">
      <div :class="name">Status</div>
      <div :class="row"><StatusIcon :task="task" /> {{ statusLabel(task.status) }}</div>
      <button v-if="canFixHere(task)" class="mt-1 px-1.5 py-0 text-xs" @click="fix(task)">Fix with Claude</button>
    </div>
    <EditableProp label="Priority" type="number" :value="String(task.priority)" :editable="editable" @submit="(v) => save('priority', v)">
      <PriorityIcon :priority="task.priority" /> {{ levelLabel }} <span class="text-muted">{{ task.priority }}</span>
    </EditableProp>
    <div :class="prop">
      <div :class="name">Repo</div>
      <div :class="row">{{ task.repo }}</div>
    </div>
    <EditableProp label="Model" :value="task.model" :editable="editable" @submit="(v) => save('model', v)" />
    <div :class="prop">
      <div :class="name">Attempts</div>
      <div :class="row">{{ task.attempts }} / {{ task.max_attempts }}</div>
    </div>
    <EditableProp
      label="Max turns"
      type="number"
      :value="String(task.max_turns)"
      :editable="editable"
      @submit="(v) => save('max_turns', v)"
    />
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
          <template v-if="task.auto_merge_view.limits.review"> · {{ task.auto_merge_view.limits.review }}</template>
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
        <button v-if="isNative" class="px-1.5 py-0 text-xs" @click="revealWorktree">reveal</button>
        <button v-if="editorSet()" class="px-1.5 py-0 text-xs" @click="openInEditor">open in editor</button>
        <button class="px-1.5 py-0 text-xs" @click="copy(task.worktree, 'wt')">{{ copied === 'wt' ? '✓' : 'copy' }}</button>
      </div>
    </div>
    <div :class="prop">
      <div :class="name">Source</div>
      <div :class="row">{{ task.source === 'planner' ? 'Planner' : 'Added by you' }}</div>
    </div>
  </aside>
</template>
