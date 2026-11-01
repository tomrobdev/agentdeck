<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type MergeMethod, type MergeResult, MERGE_METHODS, api, autoMergeLine, mergePreviewQuery } from '../../api';
import { useActions } from '../../composables/useActions';
import Modal from '../ui/Modal.vue';

// The confirm before a merge: it writes to the base branch on GitHub and can't be undone from here. The button asks the
// daemon to merge (a merge request) and the dialog closes at once; the daemon merges when the PR is ready. Only a PR whose
// checks or tests failed merges now, on the person's say-so. Enter confirms, Esc cancels (Modal). Errors show in the dialog.
const props = defineProps<{ taskId: number }>();
const emit = defineEmits<{ close: []; merged: [result: MergeResult]; requested: [] }>();
const { refresh } = useActions();

const previewQ = useQuery(mergePreviewQuery(props.taskId));
const preview = computed(() => previewQ.data.value ?? null);
const loadError = computed(() => previewQ.error.value?.message ?? '');
const method = ref<MergeMethod>('squash');
const merging = ref(false);
const mergeError = ref('');

watch(preview, (p) => p && (method.value = p.method), { immediate: true });

const request = computed(() => preview.value?.request ?? null);
// Failing checks or failed tests stop a merge request; the person can still wave them through, here and now.
const mergeNow = computed(() => {
  const p = preview.value;
  if (!p) return false;
  if (!p.request) return true; // a daemon without merge requests
  return p.request.verdict === 'never' && (p.checks.failing > 0 || p.tests_passed === 0);
});
const reasons = computed(() => request.value?.reasons ?? []);
const warnings = computed(() => (preview.value?.warnings ?? []).filter((w) => !reasons.value.includes(w)));
const label = computed(() => (mergeNow.value ? 'Merge now' : request.value?.verdict === 'wait' ? 'Merge when ready' : 'Merge'));
const canConfirm = computed(() => {
  const p = preview.value;
  if (!p || merging.value) return false;
  return mergeNow.value ? !p.problems.length : request.value?.verdict !== 'never';
});
const blockers = computed(() =>
  mergeNow.value ? (preview.value?.problems ?? []) : request.value?.verdict === 'never' ? reasons.value : [],
);

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
    if (mergeNow.value) {
      emit('merged', await api.merge(props.taskId, { method: method.value, delete_branch: true }));
      return;
    }
    await api.requestMerge(props.taskId, { method: method.value });
    await refresh();
    emit('requested');
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
        <template v-if="preview.auto_merge">
          <dt>Auto-merge</dt>
          <dd :class="{ 'text-blocked': preview.auto_merge.verdict === 'never' }">
            {{ autoMergeLine(preview.auto_merge) }}
          </dd>
        </template>
        <template v-if="preview.unblocks.length">
          <dt>Unblocks</dt>
          <dd>
            <span v-for="t in preview.unblocks" :key="t.id" class="max-w-full truncate rounded-pill bg-panel-2 px-2" :title="t.title"
              >#{{ t.id }} {{ t.title }}</span
            >
          </dd>
        </template>
      </dl>

      <p class="muted m-0 text-sm">
        Merging deletes the remote branch and the worktree (the local branch stays, so the diff remains readable).
      </p>

      <ul
        v-if="warnings.length"
        class="m-0 flex list-none flex-col gap-0.5 rounded-md bg-[color-mix(in_srgb,var(--blocked)_10%,var(--panel))] px-3 py-2 text-blocked"
      >
        <li v-for="w in warnings" :key="w">⚠ {{ w }}</li>
      </ul>
      <ul
        v-if="!mergeNow && request?.verdict === 'wait'"
        class="m-0 flex list-none flex-col gap-0.5 rounded-md bg-panel-2 px-3 py-2 text-muted"
      >
        <li v-for="r in reasons" :key="r">… Waits for it: {{ r }}</li>
      </ul>
      <ul
        v-if="blockers.length"
        class="m-0 flex list-none flex-col gap-0.5 rounded-md bg-[color-mix(in_srgb,var(--failed)_10%,var(--panel))] px-3 py-2 text-failed"
      >
        <li v-for="p in blockers" :key="p">✕ Can't merge: {{ p }}</li>
      </ul>
      <p v-if="mergeError" class="form-error">{{ mergeError }}</p>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button @click="emit('close')">Cancel</button>
      <button class="primary" :disabled="!canConfirm" @click="merge">{{ merging ? 'Working…' : label }}</button>
    </div>
  </Modal>
</template>
