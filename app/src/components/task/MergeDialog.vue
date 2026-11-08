<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type MergeMethod, type MergeResult, MERGE_METHODS, api, autoMergeLine, mergePreviewQuery } from '../../api';
import { errorMessage, plural } from '../../../../daemon/src/domain/shared/index.ts';
import { useActions } from '../../composables/useActions';
import Chip from '../ui/Chip.vue';
import ConfirmDialog from '../ui/ConfirmDialog.vue';
import Delta from '../ui/Delta.vue';
import RadioGroup from '../ui/RadioGroup.vue';

// The confirm before a merge: it writes to the base branch on GitHub and can't be undone from here. The button asks the
// daemon to merge (a merge request) and the dialog closes at once; the daemon merges when the PR is ready. Whether it merges
// now instead (failing checks or failed tests, on the person's say-so) is the daemon's merge_now. The dialog focuses the confirm button, so Enter confirms; Esc cancels. Errors show in the dialog.
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
const mergeNow = computed(() => preview.value?.merge_now ?? false);
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
  const commits = plural(n, 'commit');
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
    mergeError.value = errorMessage(e);
    merging.value = false;
  }
}
</script>

<template>
  <ConfirmDialog
    title="Merge pull request"
    :confirm-label="merging ? 'Working…' : label"
    :confirm-disabled="!canConfirm"
    :busy="merging"
    @cancel="emit('close')"
    @confirm="merge"
  >
    <p v-if="loadError" class="form-error">{{ loadError }}</p>
    <p v-else-if="!preview" class="text-muted">Reading the pull request from GitHub…</p>
    <div v-else class="flex flex-col gap-2.5">
      <p class="m-0 font-semibold">{{ preview.title }}</p>
      <p class="m-0">
        <code>{{ preview.branch ?? '?' }}</code> <span class="text-muted">→</span> <code>{{ preview.base }}</code>
      </p>

      <dl
        class="m-0 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 [&>dd]:m-0 [&>dd]:flex [&>dd]:flex-wrap [&>dd]:items-center [&>dd]:gap-1.5 [&>dt]:text-muted"
      >
        <dt>Method</dt>
        <dd>
          <RadioGroup v-model="method" label="Merge method" :options="MERGE_METHODS" />
        </dd>
        <dt>Commits</dt>
        <dd>{{ commitsLine }}</dd>
        <dt>Changes</dt>
        <dd>{{ plural(preview.files, 'file') }} <Delta :add="preview.additions" :del="preview.deletions" /></dd>
        <dt>Tests</dt>
        <dd :class="{ 'text-failed': preview.tests_passed === 0 }">{{ tests }} <span class="text-muted">on the last run</span></dd>
        <dt>Checks</dt>
        <dd :class="{ 'text-failed': preview.checks.failing }">{{ checks }} <span class="text-muted">on GitHub</span></dd>
        <template v-if="preview.auto_merge">
          <dt>Auto-merge</dt>
          <dd :class="{ 'text-blocked': preview.auto_merge.verdict === 'never' }">
            {{ autoMergeLine(preview.auto_merge) }}
          </dd>
        </template>
        <template v-if="preview.unblocks.length">
          <dt>Unblocks</dt>
          <dd>
            <Chip v-for="t in preview.unblocks" :key="t.id" variant="tint" class="mr-1 truncate" :title="t.title"
              >#{{ t.id }} {{ t.title }}</Chip
            >
          </dd>
        </template>
      </dl>

      <p class="text-muted m-0 text-sm">
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
  </ConfirmDialog>
</template>
