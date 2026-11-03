<script setup lang="ts">
import { computed, ref } from 'vue';
import { type RequestMergesResult, type TaskSummary, api } from '../../api';
import { useActions } from '../../composables/useActions';
import ConfirmDialog from '../ui/ConfirmDialog.vue';

// One confirm for several merges: the selection's, or every PR in review ("Merge all"). It records a merge request for each
// and closes at once; the daemon merges them one after another, each with its task's method and deleting its branch, and a PR
// that lands after another waits for it. A task it could not request stays listed with why. The confirm button has focus, so Enter confirms; Esc cancels, but not while the requests run.
const props = defineProps<{ tasks: TaskSummary[] }>();
const emit = defineEmits<{ close: []; done: [requested: number[]] }>();
const { refresh } = useActions();

const running = ref(false);
const result = ref<RequestMergesResult | null>(null);
const error = ref('');
const requested = computed(() => result.value?.requested ?? []);
const why = (id: number) => result.value?.failed.find((f) => f.id === id)?.reason;

async function start() {
  if (running.value || result.value) return;
  running.value = true;
  error.value = '';
  try {
    const res = await api.requestMerges(props.tasks.map((t) => t.id));
    await refresh();
    if (!res.failed.length) return emit('done', res.requested);
    result.value = res;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
  }
}

const close = () => (running.value ? undefined : emit('done', requested.value));
</script>

<template>
  <ConfirmDialog
    :title="`Merge ${tasks.length} ${tasks.length === 1 ? 'pull request' : 'pull requests'}`"
    :confirm-label="running ? 'Working…' : result ? 'Close' : `Merge ${tasks.length}`"
    :hide-cancel="!!result"
    :busy="running"
    @cancel="close"
    @confirm="result ? close() : start()"
  >
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      <li v-for="t in tasks" :key="t.id" class="flex flex-col">
        <span class="flex items-baseline gap-2">
          <span class="w-4 flex-none">
            <template v-if="requested.includes(t.id)">✓</template>
            <template v-else-if="why(t.id)">✕</template>
          </span>
          <span class="font-mono text-muted">#{{ t.id }}</span>
          <span class="min-w-0 flex-1 truncate">{{ t.title }}</span>
          <code class="max-w-[220px] truncate text-sm">{{ t.pr_url }}</code>
        </span>
        <span v-if="why(t.id)" class="pl-6 text-sm text-failed">{{ why(t.id) }}</span>
      </li>
    </ul>
    <p v-if="!result" class="text-muted mt-3">
      The daemon merges them one after another, each with its task's method, deleting its branch. One that is not ready waits for its checks
      or its sync; one that lands after another waits for it. This can't be undone from here.
    </p>
    <p v-else class="mt-3">Asked to merge {{ requested.length }} of {{ tasks.length }}.</p>
    <p v-if="error" class="form-error mt-3">{{ error }}</p>
  </ConfirmDialog>
</template>
