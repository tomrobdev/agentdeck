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
  <article v-if="docs.length" class="docs">
    <header class="dhead">
      <b>Documents</b> <span class="muted">{{ docs.length }} written or changed by this task</span>
    </header>
    <div v-for="d in docs" :key="d.path" class="doc">
      <div class="drow">
        <button class="name" @click="show(d.path)">
          <span class="caret">{{ openDoc === d.path ? '▾' : '▸' }}</span> {{ d.path }}
        </button>
        <span class="muted">{{ d.status === 'A' ? 'new' : 'changed' }}</span>
        <button class="mini" @click="emit('open', d.path)">Open</button>
      </div>
      <div v-if="openDoc === d.path" class="dbody">
        <Markdown v-if="text.has(d.path)" :text="text.get(d.path)!" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
        <p v-else class="muted">Loading…</p>
      </div>
    </div>
  </article>
</template>

<style scoped>
.docs {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.dhead {
  display: flex;
  gap: 8px;
  padding: 8px 14px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.doc + .doc {
  border-top: 1px solid var(--border);
}
.drow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
}
.name {
  border: none;
  background: none;
  padding: 0;
  flex: 1;
  text-align: left;
  font:
    12.5px ui-monospace,
    Menlo,
    monospace;
}
.caret {
  color: var(--muted);
  font-size: 10px;
}
.mini {
  padding: 0 8px;
  font-size: 12px;
}
.dbody {
  padding: 4px 22px 16px;
  max-height: 60vh;
  overflow-y: auto;
}
</style>
