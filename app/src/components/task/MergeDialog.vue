<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { type MergeMethod, type MergePreview, type MergeResult, MERGE_METHODS, api } from '../../api';
import { useActions } from '../../useActions';
import Modal from '../Modal.vue';

// The confirm before a merge: it writes to the base branch on GitHub and can't be undone from here.
// Enter merges, Esc cancels (Modal). Errors show in the dialog, so it asks for the refresh, not `run`.
const props = defineProps<{ taskId: number }>();
const emit = defineEmits<{ close: []; merged: [result: MergeResult] }>();
const { refresh } = useActions();

const preview = ref<MergePreview | null>(null);
const loadError = ref('');
const method = ref<MergeMethod>('squash');
const deleteBranch = ref(true);
const merging = ref(false);
const mergeError = ref('');
const syncing = ref(false);
const syncNote = ref('');

async function load() {
  try {
    preview.value = await api.mergePreview(props.taskId);
    method.value = preview.value.method;
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}
onMounted(load);

const canConfirm = computed(() => !!preview.value && !preview.value.problems.length && !merging.value && !syncing.value);

// Sync the task's branch with the base branch. A conflict starts a claude run, so this can take minutes.
async function sync() {
  syncing.value = true;
  mergeError.value = syncNote.value = '';
  try {
    const res = await api.sync(props.taskId);
    await refresh();
    if (res.outcome === 'blocked') return emit('close'); // the task page shows why it is blocked
    const files = `${res.files.length} ${res.files.length === 1 ? 'file' : 'files'}`;
    syncNote.value =
      res.outcome === 'resolved'
        ? `Resolved conflicts in ${files}.`
        : res.outcome === 'clean'
          ? 'Synced with the base branch.'
          : res.outcome === 'up_to_date'
            ? 'The branch is already up to date.'
            : (res.reason ?? res.outcome);
    if (res.push_error) mergeError.value = `Could not push: ${res.push_error}`;
    else if (res.pushed) syncNote.value += ' Pushed; GitHub may take a moment to see it.';
    await load();
  } catch (e) {
    mergeError.value = (e as Error).message;
  } finally {
    syncing.value = false;
  }
}

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
    <p v-if="loadError" class="form-error">{{ loadError }}</p>
    <p v-else-if="!preview" class="muted">Reading the pull request from GitHub…</p>
    <div v-else class="flex flex-col gap-2.5">
      <p class="m-0 font-semibold">{{ preview.title }}</p>
      <p class="m-0">
        <code>{{ preview.branch ?? '?' }}</code> <span class="muted">→</span> <code>{{ preview.base }}</code>
      </p>

      <dl
        class="m-0 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 [&>dd]:m-0 [&>dd]:flex [&>dd]:flex-wrap [&>dd]:items-center [&>dd]:gap-1.5 [&>dt]:text-muted"
      >
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
          {{ preview.files }} {{ preview.files === 1 ? 'file' : 'files' }} <span class="text-done">+{{ preview.additions }}</span>
          <span class="text-failed">−{{ preview.deletions }}</span>
        </dd>
        <dt>Tests</dt>
        <dd :class="{ 'text-failed': preview.tests_passed === 0 }">{{ tests }} <span class="muted">on the last run</span></dd>
        <dt>Checks</dt>
        <dd :class="{ 'text-failed': preview.checks.failing }">{{ checks }} <span class="muted">on GitHub</span></dd>
        <template v-if="preview.unblocks.length">
          <dt>Unblocks</dt>
          <dd>
            <span v-for="t in preview.unblocks" :key="t.id" class="max-w-full truncate rounded-pill bg-panel-2 px-2" :title="t.title"
              >#{{ t.id }} {{ t.title }}</span
            >
          </dd>
        </template>
      </dl>

      <label class="flex items-start gap-2">
        <input v-model="deleteBranch" class="mt-[3px]" type="checkbox" />
        Delete the remote branch and the worktree <span class="muted">(the local branch stays, so the diff remains readable)</span>
      </label>

      <ul
        v-if="preview.warnings.length"
        class="m-0 flex list-none flex-col gap-0.5 rounded-md bg-[color-mix(in_srgb,var(--blocked)_10%,var(--panel))] px-3 py-2 text-blocked"
      >
        <li v-for="w in preview.warnings" :key="w">⚠ {{ w }}</li>
      </ul>
      <ul
        v-if="preview.problems.length"
        class="m-0 flex list-none flex-col gap-0.5 rounded-md bg-[color-mix(in_srgb,var(--failed)_10%,var(--panel))] px-3 py-2 text-failed"
      >
        <li v-for="p in preview.problems" :key="p">✕ Can't merge: {{ p }}</li>
      </ul>
      <div v-if="preview.conflicting" class="flex items-center gap-2.5">
        <button :disabled="syncing || merging" @click="sync">{{ syncing ? 'Syncing…' : 'Sync with base' }}</button>
        <span class="muted text-sm">
          {{
            syncing
              ? 'Syncing the branch with the base branch; a conflict starts a claude run, which can take a few minutes.'
              : 'Merges the base branch into the branch and has claude settle conflicts. If it cannot, the task is blocked.'
          }}
        </span>
      </div>
      <p v-if="syncNote" class="muted">{{ syncNote }}</p>
      <p v-if="mergeError" class="form-error">{{ mergeError }}</p>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button @click="emit('close')">Cancel</button>
      <button class="primary" :disabled="!canConfirm" @click="merge">{{ merging ? 'Merging…' : 'Merge' }}</button>
    </div>
  </Modal>
</template>
