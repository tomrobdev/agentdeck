<script setup lang="ts">
import { ref } from 'vue';
import { type Repo, type RepoDetail, ago, api } from '../api';
import Modal from './Modal.vue';

defineProps<{ repos: Repo[] }>();
const emit = defineEmits<{ close: []; changed: [] }>();

// Add form
const path = ref('');
const name = ref('');
const test = ref('');
const error = ref('');
const saving = ref(false);

// Per-repo editor
const open = ref<RepoDetail | null>(null);
const goals = ref('');
const autoApprove = ref(false);
const testCmd = ref('');
const editError = ref('');
const editMsg = ref('');
const busy = ref<'' | 'save' | 'plan'>('');

async function add() {
  error.value = '';
  saving.value = true;
  try {
    const repo = await api.addRepo({ path: path.value.trim(), name: name.value.trim() || undefined, test: test.value.trim() || undefined });
    path.value = name.value = test.value = '';
    emit('changed');
    await edit(repo);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

function load(d: RepoDetail) {
  open.value = d;
  goals.value = d.goals;
  autoApprove.value = !!d.auto_approve;
  testCmd.value = d.test_cmd ?? '';
}

async function edit(r: Repo) {
  editError.value = editMsg.value = '';
  if (open.value?.id === r.id) return void (open.value = null);
  try {
    load(await api.repo(r.id));
  } catch (e) {
    editError.value = (e as Error).message;
  }
}

async function save(): Promise<boolean> {
  if (!open.value) return false;
  editError.value = editMsg.value = '';
  busy.value = 'save';
  try {
    load(await api.updateRepo(open.value.id, { goals: goals.value, auto_approve: autoApprove.value, test_cmd: testCmd.value }));
    editMsg.value = 'Saved';
    emit('changed');
    return true;
  } catch (e) {
    editError.value = (e as Error).message;
    return false;
  } finally {
    busy.value = '';
  }
}

async function planNow() {
  if (!open.value || !(await save())) return;
  busy.value = 'plan';
  editMsg.value = 'Planning… this reads the repo and can take a minute.';
  try {
    const res = await api.plan(open.value.id);
    editMsg.value =
      res.outcome === 'proposed'
        ? `${res.tasks.length} task(s) ${autoApprove.value ? 'queued' : 'proposed: approve them under Needs you'}.`
        : res.outcome === 'nothing'
          ? `Nothing to propose${res.note ? `: ${res.note}` : '.'}`
          : `Planner ${res.outcome}${res.note ? `: ${res.note}` : ''}`;
    load(await api.repo(open.value.id));
    emit('changed');
  } catch (e) {
    editError.value = (e as Error).message;
    editMsg.value = '';
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <Modal title="Repos" @close="$emit('close')">
    <ul v-if="repos.length" class="repos">
      <li v-for="r in repos" :key="r.id" :class="{ on: open?.id === r.id }">
        <button class="head" @click="edit(r)">
          <span class="name">{{ r.name }}</span>
          <span class="muted">base {{ r.base_branch }}<template v-if="r.auto_approve"> · auto-approve</template></span>
          <span class="chev muted">{{ open?.id === r.id ? '▾' : '▸' }}</span>
        </button>
        <code class="muted path">{{ r.path }}</code>

        <form v-if="open?.id === r.id" class="editor" @submit.prevent="save">
          <label>
            <span>Goals <span class="muted">(the planner reads these when the queue runs dry)</span></span>
            <textarea
              v-model="goals"
              rows="9"
              placeholder="What should this repo become? Priorities first, then anything the agents must not touch."
            />
            <small class="muted">Stored in <code>{{ open.goals_path }}</code>, which you can also edit in any editor.</small>
          </label>
          <div class="row">
            <label>
              <span>Test command</span>
              <input v-model="testCmd" placeholder="npm test" />
            </label>
            <label class="check">
              <input type="checkbox" v-model="autoApprove" />
              Auto-approve planner tasks
            </label>
          </div>
          <p v-if="open.planner_runs.length" class="muted last" :title="open.planner_runs[0].note ?? ''">
            Last plan {{ ago(open.planner_runs[0].started_at) }}: {{ open.planner_runs[0].outcome ?? 'running' }}
            <template v-if="open.planner_runs[0].proposed"> · {{ open.planner_runs[0].proposed }} task(s)</template>
            <template v-if="open.planner_runs[0].note"> · {{ open.planner_runs[0].note }}</template>
          </p>
          <p v-if="editError" class="error">{{ editError }}</p>
          <div class="actions">
            <span class="muted msg">{{ editMsg }}</span>
            <button type="button" @click="planNow" :disabled="!!busy || !goals.trim()">
              {{ busy === 'plan' ? 'Planning…' : 'Save & plan now' }}
            </button>
            <button class="primary" type="submit" :disabled="!!busy">Save</button>
          </div>
        </form>
      </li>
    </ul>
    <p v-else class="muted">No repos yet.</p>

    <form class="add" @submit.prevent="add">
      <h4>Add a repo</h4>
      <label>
        Path to a local git repo
        <input v-model="path" placeholder="~/Documents/Dev/myproject" />
      </label>
      <div class="row">
        <label>
          <span>Name <span class="muted">(optional)</span></span>
          <input v-model="name" />
        </label>
        <label>
          <span>Test command <span class="muted">(run after each task)</span></span>
          <input v-model="test" placeholder="npm test" />
        </label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button class="primary" type="submit" :disabled="saving || !path.trim()">Add repo</button>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.repos {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.repos li {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.repos li.on {
  border-color: var(--accent);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  border: none;
  background: none;
  padding: 0;
  text-align: left;
}
.name {
  font-weight: 600;
}
.chev {
  margin-left: auto;
}
.path {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
textarea {
  resize: vertical;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}
small {
  font-size: 11px;
}
.last {
  margin: 0;
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
h4 {
  margin: 0;
}
.add {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  align-self: flex-end;
  padding-bottom: 8px;
}
.check input {
  width: auto;
}
.row {
  display: flex;
  gap: 10px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.msg {
  margin-right: auto;
  font-size: 12px;
}
.error {
  color: var(--failed);
  margin: 0;
}
</style>
