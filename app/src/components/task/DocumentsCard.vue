<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { type ChangedFile, api } from '../../api';
import { isMarkdown } from '../../render';
import Markdown from '../files/Markdown.vue';

// Documents the task wrote or changed (markdown under docs/ or at the repo root), readable in place.
const props = defineProps<{ taskId: number; files: ChangedFile[]; head: string | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ open: [path: string]; path: [path: string, line: number | null] }>();

const docs = computed(() =>
  props.files.filter((f) => f.status !== 'D' && isMarkdown(f.path) && (f.path.startsWith('docs/') || !f.path.includes('/'))),
);
const openDoc = ref<string | null>(null);
const text = reactive(new Map<string, string>());

async function show(path: string) {
  openDoc.value = openDoc.value === path ? null : path;
  if (!openDoc.value || text.has(path)) return;
  try {
    text.set(path, (await api.file(props.taskId, 'head', path)).text ?? '_Binary file._');
  } catch (e) {
    text.set(path, `Couldn't load: ${(e as Error).message}`);
  }
}
// Open the first document; reload when the branch moves.
watch(
  [() => props.head, () => docs.value[0]?.path],
  () => {
    text.clear();
    openDoc.value = null;
    if (docs.value[0]) show(docs.value[0].path);
  },
  { immediate: true },
);
</script>

<template>
  <article v-if="docs.length" class="card">
    <header class="card-head px-3.5 py-2">
      <b>Documents</b> <span class="text-muted">{{ docs.length }} written or changed by this task</span>
    </header>
    <div v-for="d in docs" :key="d.path" class="[div+&]:border-t [div+&]:border-border">
      <div class="flex items-center gap-2 px-3.5 py-1.5">
        <button class="btn-ghost flex-1 text-left font-mono text-sm leading-[normal]" @click="show(d.path)">
          <span class="text-2xs text-muted">{{ openDoc === d.path ? '▾' : '▸' }}</span> {{ d.path }}
        </button>
        <span class="text-muted">{{ d.status === 'A' ? 'new' : 'changed' }}</span>
        <button class="px-2 py-0 text-sm" @click="emit('open', d.path)">Open</button>
      </div>
      <div v-if="openDoc === d.path" class="max-h-[60vh] overflow-y-auto px-[22px] pt-1 pb-4">
        <Markdown v-if="text.has(d.path)" :text="text.get(d.path)!" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
        <p v-else class="text-muted">Loading…</p>
      </div>
    </div>
  </article>
</template>
