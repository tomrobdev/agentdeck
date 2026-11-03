<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { type ChangedFile, fileQuery } from '../../api';
import { isMarkdown } from '../../lib/render';
import Markdown from '../files/Markdown.vue';
import Accordion from '../ui/Accordion.vue';
import AccordionItem from '../ui/AccordionItem.vue';
import AccordionTrigger from '../ui/AccordionTrigger.vue';

// Documents the task wrote or changed (markdown under docs/ or at the repo root), readable in place.
const props = defineProps<{ taskId: number; files: ChangedFile[]; head: string | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ open: [path: string]; path: [path: string, line: number | null] }>();
const queryClient = useQueryClient();

const docs = computed(() =>
  props.files.filter((f) => f.status !== 'D' && isMarkdown(f.path) && (f.path.startsWith('docs/') || !f.path.includes('/'))),
);
const openDoc = ref<string | undefined>(undefined);
const text = reactive(new Map<string, string>());

async function load(path: string) {
  if (text.has(path)) return;
  // A document seen at this head commit comes from the query cache at once.
  const q = fileQuery(props.taskId, 'head', path, props.head);
  const seen = queryClient.getQueryData(q.queryKey);
  if (seen) return void text.set(path, seen.text ?? '_Binary file._');
  try {
    text.set(path, (await queryClient.fetchQuery(q)).text ?? '_Binary file._');
  } catch (e) {
    text.set(path, `Couldn't load: ${(e as Error).message}`);
  }
}
// Open the first document; reload when the branch moves.
watch(
  [() => props.head, () => docs.value[0]?.path],
  () => {
    text.clear();
    openDoc.value = docs.value[0]?.path;
    if (openDoc.value) void load(openDoc.value);
  },
  { immediate: true },
);
</script>

<template>
  <article v-if="docs.length" class="card">
    <header class="card-head px-3.5 py-2">
      <b>Documents</b> <span class="text-muted">{{ docs.length }} written or changed by this task</span>
    </header>
    <Accordion :model-value="openDoc" @update:model-value="(v) => ((openDoc = v), v && load(v))">
      <AccordionItem
        v-for="d in docs"
        :key="d.path"
        :value="d.path"
        class="[div+&]:border-t [div+&]:border-border"
        header-class="flex items-center gap-2 px-3.5 py-1.5"
      >
        <template #header>
          <AccordionTrigger class="btn-ghost flex-1 text-left font-mono text-sm leading-[normal]">
            <span class="text-2xs text-muted">{{ openDoc === d.path ? '▾' : '▸' }}</span> {{ d.path }}
          </AccordionTrigger>
          <span class="text-muted">{{ d.status === 'A' ? 'new' : 'changed' }}</span>
          <button class="px-2 py-0 text-sm" @click="emit('open', d.path)">Open</button>
        </template>
        <div class="max-h-[60vh] overflow-y-auto px-[22px] pt-1 pb-4">
          <Markdown v-if="text.has(d.path)" :text="text.get(d.path)!" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
          <p v-else class="text-muted">Loading…</p>
        </div>
      </AccordionItem>
    </Accordion>
  </article>
</template>
