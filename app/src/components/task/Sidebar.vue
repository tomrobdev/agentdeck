<script setup lang="ts">
import { computed, ref } from 'vue';
import { type TaskDetail, api } from '../../api';
import { openExternal, useCopy } from '../../native';
import { openTask } from '../../router';
import { PRIORITY_LEVELS, canEdit, priorityLevel, statusLabel } from '../../taskView';
import PriorityIcon from '../queue/PriorityIcon.vue';
import StatusIcon from '../queue/StatusIcon.vue';

// Task properties, GitHub-sidebar style. Priority, model and turns are editable while the task is.
const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ changed: []; error: [msg: string] }>();

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
  try {
    await api.editTask(props.task.id, { [field]: field === 'model' ? draft.value.trim() : Number(draft.value) });
    emit('changed');
  } catch (e) {
    emit('error', (e as Error).message);
  }
}

const levelLabel = computed(() => PRIORITY_LEVELS.find((l) => l.key === priorityLevel(props.task.priority))!.label);
</script>

<template>
  <aside class="side">
    <div class="prop">
      <div class="k">Status</div>
      <div class="v"><StatusIcon :task="task" /> {{ statusLabel(task.status) }}</div>
    </div>
    <div class="prop">
      <div class="k">Priority</div>
      <div v-if="editing === 'priority'" class="v">
        <input v-model="draft" type="number" autofocus @keydown.enter="save" @keydown.esc.stop="editing = null" @blur="save" />
      </div>
      <button v-else class="v" :class="{ editable }" :disabled="!editable" @click="edit('priority')">
        <PriorityIcon :priority="task.priority" /> {{ levelLabel }} <span class="muted">{{ task.priority }}</span>
      </button>
    </div>
    <div class="prop">
      <div class="k">Repo</div>
      <div class="v">{{ task.repo }}</div>
    </div>
    <div class="prop">
      <div class="k">Model</div>
      <div v-if="editing === 'model'" class="v">
        <input v-model="draft" autofocus @keydown.enter="save" @keydown.esc.stop="editing = null" @blur="save" />
      </div>
      <button v-else class="v" :class="{ editable }" :disabled="!editable" @click="edit('model')">{{ task.model }}</button>
    </div>
    <div class="prop">
      <div class="k">Attempts</div>
      <div class="v">{{ task.attempts }} / {{ task.max_attempts }}</div>
    </div>
    <div class="prop">
      <div class="k">Max turns</div>
      <div v-if="editing === 'max_turns'" class="v">
        <input v-model="draft" type="number" autofocus @keydown.enter="save" @keydown.esc.stop="editing = null" @blur="save" />
      </div>
      <button v-else class="v" :class="{ editable }" :disabled="!editable" @click="edit('max_turns')">{{ task.max_turns }}</button>
    </div>
    <div v-if="task.after_task" class="prop">
      <div class="k">After</div>
      <button class="v link" @click="openTask(task.after_task)">
        #{{ task.after_task }}
        <span v-if="task.waiting?.stuck" class="warn">stuck</span>
        <span v-else-if="task.waiting" class="muted">waiting</span>
        <span v-else class="ok">met</span>
      </button>
    </div>
    <div v-if="task.pr_url" class="prop">
      <div class="k">Pull request</div>
      <button class="v link" @click="openExternal(task.pr_url)">{{ task.pr_state ?? 'open' }} ↗</button>
    </div>
    <div v-if="task.branch" class="prop">
      <div class="k">Branch</div>
      <div class="v mono">
        <span class="trunc" :title="task.branch">{{ task.branch }}</span>
        <button class="mini" @click="copy(task.branch, 'branch')">{{ copied === 'branch' ? '✓' : 'copy' }}</button>
      </div>
    </div>
    <div v-if="task.worktree" class="prop">
      <div class="k">Worktree</div>
      <div class="v mono">
        <span class="trunc" :title="task.worktree">{{ task.worktree.split('/').slice(-2).join('/') }}</span>
        <button class="mini" @click="copy(task.worktree, 'wt')">{{ copied === 'wt' ? '✓' : 'copy' }}</button>
      </div>
    </div>
    <div class="prop">
      <div class="k">Source</div>
      <div class="v">{{ task.source === 'planner' ? 'Planner' : 'Added by you' }}</div>
    </div>
  </aside>
</template>

<style scoped>
.side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 240px;
  flex: none;
}
.prop {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.k {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 3px;
}
.v {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  min-width: 0;
}
button.v {
  border: 1px solid transparent;
  background: none;
  padding: 0 6px;
  margin-left: -6px;
  width: calc(100% + 6px);
  text-align: left;
}
button.v.editable:hover {
  border-color: var(--border);
  background: var(--panel-2);
}
button.v:disabled {
  opacity: 1;
}
.v input {
  padding: 2px 6px;
}
.link {
  color: var(--accent);
}
.mono {
  font:
    12px ui-monospace,
    Menlo,
    monospace;
}
.trunc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.mini {
  padding: 0 6px;
  font-size: 11px;
  font-family: inherit;
}
.warn {
  color: var(--blocked);
}
.ok {
  color: var(--done);
}
</style>
