<script setup lang="ts">
import { computed, ref } from 'vue';
import { type TaskDetail, api } from '../../api';
import { openExternal, useCopy } from '../../native';
import { openTask } from '../../router';
import { PRIORITY_LEVELS, canEdit, priorityLevel, statusLabel } from '../../taskView';
import { useActions } from '../../useActions';
import PriorityIcon from '../queue/PriorityIcon.vue';
import StatusIcon from '../queue/StatusIcon.vue';

// Task properties, GitHub-sidebar style. Priority, model and turns are editable while the task is.
const props = defineProps<{ task: TaskDetail }>();
const { run } = useActions();

const editable = computed(() => canEdit(props.task));
const editing = ref<'priority' | 'model' | 'max_turns' | null>(null);
const draft = ref('');
const { copied, copy } = useCopy();

function edit(field: 'priority' | 'model' | 'max_turns') {
  if (!editable.value) return;
  editing.value = field;
  draft.value = String(props.task[field]);
}

async function save() {
  const field = editing.value;
  editing.value = null;
  if (!field || draft.value.trim() === String(props.task[field])) return;
  await run(() => api.editTask(props.task.id, { [field]: field === 'model' ? draft.value.trim() : Number(draft.value) }));
}

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
      <div v-if="editing === 'priority'" :class="row">
        <input
          v-model="draft"
          :class="input"
          type="number"
          autofocus
          @keydown.enter="save"
          @keydown.esc.stop="editing = null"
          @blur="save"
        />
      </div>
      <button v-else :class="[rowButton, editable && rowButtonEditable]" :disabled="!editable" @click="edit('priority')">
        <PriorityIcon :priority="task.priority" /> {{ levelLabel }} <span class="text-muted">{{ task.priority }}</span>
      </button>
    </div>
    <div :class="prop">
      <div :class="name">Repo</div>
      <div :class="row">{{ task.repo }}</div>
    </div>
    <div :class="prop">
      <div :class="name">Model</div>
      <div v-if="editing === 'model'" :class="row">
        <input v-model="draft" :class="input" autofocus @keydown.enter="save" @keydown.esc.stop="editing = null" @blur="save" />
      </div>
      <button v-else :class="[rowButton, editable && rowButtonEditable]" :disabled="!editable" @click="edit('model')">
        {{ task.model }}
      </button>
    </div>
    <div :class="prop">
      <div :class="name">Attempts</div>
      <div :class="row">{{ task.attempts }} / {{ task.max_attempts }}</div>
    </div>
    <div :class="prop">
      <div :class="name">Max turns</div>
      <div v-if="editing === 'max_turns'" :class="row">
        <input
          v-model="draft"
          :class="input"
          type="number"
          autofocus
          @keydown.enter="save"
          @keydown.esc.stop="editing = null"
          @blur="save"
        />
      </div>
      <button v-else :class="[rowButton, editable && rowButtonEditable]" :disabled="!editable" @click="edit('max_turns')">
        {{ task.max_turns }}
      </button>
    </div>
    <div v-if="task.after_task" :class="prop">
      <div :class="name">After</div>
      <button :class="[rowButton, 'text-accent']" @click="openTask(task.after_task)">
        #{{ task.after_task }}
        <span v-if="task.waiting?.stuck" class="text-blocked">stuck</span>
        <span v-else-if="task.waiting" class="text-muted">waiting</span>
        <span v-else class="text-done">met</span>
      </button>
    </div>
    <div v-if="task.pr_url" :class="prop">
      <div :class="name">Pull request</div>
      <button :class="[rowButton, 'text-accent']" @click="openExternal(task.pr_url)">{{ task.pr_state ?? 'open' }} ↗</button>
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
        <button class="px-1.5 py-0 text-xs" @click="copy(task.worktree, 'wt')">{{ copied === 'wt' ? '✓' : 'copy' }}</button>
      </div>
    </div>
    <div :class="prop">
      <div :class="name">Source</div>
      <div :class="row">{{ task.source === 'planner' ? 'Planner' : 'Added by you' }}</div>
    </div>
  </aside>
</template>
