<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { type MergeMethod, type MergePreview, type MergeResult, MERGE_METHODS, api } from '../../api';
import Modal from '../Modal.vue';

// The confirm before a merge: it writes to the base branch on GitHub and can't be undone from here.
// Enter merges, Esc cancels (Modal).
const props = defineProps<{ taskId: number }>();
const emit = defineEmits<{ close: []; merged: [result: MergeResult] }>();

const preview = ref<MergePreview | null>(null);
const loadError = ref('');
const method = ref<MergeMethod>('squash');
const deleteBranch = ref(true);
const merging = ref(false);
const mergeError = ref('');

onMounted(async () => {
  try {
    preview.value = await api.mergePreview(props.taskId);
    method.value = preview.value.method;
  } catch (e) {
    loadError.value = (e as Error).message;
  }
});

const canConfirm = computed(() => !!preview.value && !preview.value.problems.length && !merging.value);

const commitsLine = computed(() => {
  const n = preview.value?.commits ?? 0;
  const commits = `${n} ${n === 1 ? 'commit' : 'commits'}`;
  return method.value === 'squash' ? `${commits} → 1` : commits;
});

const tests = computed(() => {
  const t = preview.value?.tests_passed;
  return t === null || t === undefined ? 'not run' : t ? 'passed' : 'failed';
});

const checks = computed(() => {
  const c = preview.value?.checks;
  if (!c || !c.total) return 'none';
  const parts = [`${c.total - c.failing - c.pending} passing`];
  if (c.failing) parts.push(`${c.failing} failing`);
  if (c.pending) parts.push(`${c.pending} running`);
  return parts.join(', ');
});

async function merge() {
  if (!canConfirm.value) return;
  merging.value = true;
  mergeError.value = '';
  try {
    emit('merged', await api.merge(props.taskId, { method: method.value, delete_branch: deleteBranch.value }));
  } catch (e) {
    mergeError.value = (e as Error).message;
    merging.value = false;
  }
}

// Enter confirms, except where it already means something: a button or a menu.
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
  if (e.target instanceof HTMLElement && e.target.closest('button, select, a')) return;
  e.preventDefault();
  merge();
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Modal title="Merge pull request" @close="emit('close')">
    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-else-if="!preview" class="muted">Reading the pull request from GitHub…</p>
    <div v-else class="merge">
      <p class="title">{{ preview.title }}</p>
      <p class="branches">
        <code>{{ preview.branch ?? '?' }}</code> <span class="muted">→</span> <code>{{ preview.base }}</code>
      </p>

      <dl>
        <dt>Method</dt>
        <dd>
          <select v-model="method" aria-label="Merge method">
            <option v-for="m in MERGE_METHODS" :key="m.key" :value="m.key">{{ m.label }}</option>
          </select>
          <span class="muted">{{ MERGE_METHODS.find((m) => m.key === method)?.hint }}</span>
        </dd>
        <dt>Commits</dt>
        <dd>{{ commitsLine }}</dd>
        <dt>Changes</dt>
        <dd>
          {{ preview.files }} {{ preview.files === 1 ? 'file' : 'files' }} <span class="add">+{{ preview.additions }}</span>
          <span class="del">−{{ preview.deletions }}</span>
        </dd>
        <dt>Tests</dt>
        <dd :class="{ bad: preview.tests_passed === 0 }">{{ tests }} <span class="muted">on the last run</span></dd>
        <dt>Checks</dt>
        <dd :class="{ bad: preview.checks.failing }">{{ checks }} <span class="muted">on GitHub</span></dd>
        <template v-if="preview.unblocks.length">
          <dt>Unblocks</dt>
          <dd>
            <span v-for="t in preview.unblocks" :key="t.id" class="chip" :title="t.title">#{{ t.id }} {{ t.title }}</span>
          </dd>
        </template>
      </dl>

      <label class="check">
        <input v-model="deleteBranch" type="checkbox" />
        Delete the remote branch and the worktree <span class="muted">(the local branch stays, so the diff remains readable)</span>
      </label>

      <ul v-if="preview.warnings.length" class="notes warn">
        <li v-for="w in preview.warnings" :key="w">⚠ {{ w }}</li>
      </ul>
      <ul v-if="preview.problems.length" class="notes problem">
        <li v-for="p in preview.problems" :key="p">✕ Can't merge: {{ p }}</li>
      </ul>
      <p v-if="mergeError" class="error">{{ mergeError }}</p>
    </div>

    <div class="actions">
      <button @click="emit('close')">Cancel</button>
      <button class="primary" :disabled="!canConfirm" @click="merge">{{ merging ? 'Merging…' : 'Merge' }}</button>
    </div>
  </Modal>
</template>

<style scoped>
.merge {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.title {
  margin: 0;
  font-weight: 600;
}
.branches {
  margin: 0;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.add {
  color: var(--done);
}
.del,
.bad {
  color: var(--failed);
}
.chip {
  background: var(--panel-2);
  border-radius: 999px;
  padding: 0 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
}
.check input {
  width: auto;
  margin-top: 3px;
}
.notes {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.notes.warn {
  color: var(--blocked);
  background: color-mix(in srgb, var(--blocked) 10%, var(--panel));
}
.notes.problem {
  color: var(--failed);
  background: color-mix(in srgb, var(--failed) 10%, var(--panel));
}
.error {
  color: var(--failed);
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
