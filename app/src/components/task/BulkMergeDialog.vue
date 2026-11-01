<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../../api';
import type { TaskSummary } from '../../api';
import { useActions } from '../../composables/useActions';
import Modal from '../ui/Modal.vue';

// One confirm for several merges, then one at a time: a merge writes to the base branch and can't be undone,
// so it stops at the first one that fails and says which. Each merge uses the method its repo prefers.
const props = defineProps<{ tasks: TaskSummary[] }>();
const emit = defineEmits<{ close: []; done: [merged: number[]] }>();
const { refresh } = useActions();

const running = ref(false);
const merged = ref<number[]>([]);
const failed = ref<{ id: number; message: string } | null>(null);
const cleanup = ref<string[]>([]);
const current = computed(() => (running.value ? props.tasks.find((t) => !merged.value.includes(t.id)) : undefined));
const finished = computed(() => merged.value.length === props.tasks.length);

async function start() {
  running.value = true;
  failed.value = null;
  try {
    for (const t of props.tasks) {
      if (merged.value.includes(t.id)) continue;
      try {
        const preview = await api.mergePreview(t.id);
        if (preview.problems.length) throw new Error(`Can't merge: ${preview.problems.join('; ')}`);
        const res = await api.merge(t.id, { method: preview.method, delete_branch: true });
        merged.value.push(t.id);
        if (res.cleanup_error) cleanup.value.push(`#${t.id}: ${res.cleanup_error}`);
        await refresh();
      } catch (e) {
        failed.value = { id: t.id, message: (e as Error).message };
        return;
      }
    }
  } finally {
    running.value = false;
  }
}

const close = () => (running.value ? undefined : emit('done', merged.value));
const title = (id: number) => props.tasks.find((t) => t.id === id)?.title ?? '';
</script>

<template>
  <Modal :title="`Merge ${tasks.length} pull requests`" @close="close">
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      <li v-for="t in tasks" :key="t.id" class="flex items-baseline gap-2">
        <span class="w-4 flex-none">
          <template v-if="merged.includes(t.id)">✓</template>
          <template v-else-if="current?.id === t.id">…</template>
          <template v-else-if="failed?.id === t.id">✕</template>
        </span>
        <span class="font-mono text-muted">#{{ t.id }}</span>
        <span class="min-w-0 flex-1 truncate">{{ t.title }}</span>
        <code class="max-w-[220px] truncate text-sm">{{ t.pr_url }}</code>
      </li>
    </ul>
    <p v-if="!running && !merged.length && !failed" class="muted mt-3">
      Merges them one at a time, in this order, and stops at the first that fails. This can't be undone from here.
    </p>
    <p v-if="running" class="muted mt-3">Merged {{ merged.length }} of {{ tasks.length }}…</p>
    <p v-if="failed" class="form-error mt-3">
      Stopped at #{{ failed.id }} {{ title(failed.id) }}: {{ failed.message }}. Merged {{ merged.length }} of {{ tasks.length }}.
    </p>
    <p v-if="finished" class="mt-3">Merged all {{ tasks.length }}.</p>
    <ul v-if="cleanup.length" class="form-error m-0 mt-3 list-none p-0">
      <li v-for="c in cleanup" :key="c">Cleanup failed {{ c }}</li>
    </ul>
    <div class="mt-4 flex justify-end gap-2">
      <button :disabled="running" @click="close">{{ finished || failed ? 'Close' : 'Cancel' }}</button>
      <button v-if="!finished" class="primary" :disabled="running" @click="start">
        {{ running ? 'Merging…' : failed ? 'Retry from here' : `Merge ${tasks.length}` }}
      </button>
    </div>
  </Modal>
</template>
