<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { highlightLines, languageFor } from '../../render';

export interface LineRange {
  from: number;
  to: number;
}

// A file's text with line numbers and highlighting. Click a number to select a line, shift-click
// for a range. `first` offsets the numbers when showing a snippet out of a larger file.
const props = defineProps<{ text: string; path: string; range?: LineRange | null; first?: number; scrollToRange?: boolean }>();
const emit = defineEmits<{ select: [range: LineRange] }>();

const lines = computed(() => {
  const all = props.text.split('\n');
  if (all.length > 1 && all.at(-1) === '') all.pop();
  return all;
});
const html = computed(() => highlightLines(lines.value, languageFor(props.path)));
const offset = computed(() => (props.first ?? 1) - 1);
const root = ref<HTMLElement | null>(null);
const anchor = ref<number | null>(null);

function click(n: number, e: MouseEvent) {
  if (e.shiftKey && anchor.value !== null) emit('select', { from: Math.min(anchor.value, n), to: Math.max(anchor.value, n) });
  else {
    anchor.value = n;
    emit('select', { from: n, to: n });
  }
}
const inRange = (n: number) => !!props.range && n >= props.range.from && n <= props.range.to;

// Bring a linked range into view once the text is there.
watch(
  () => [props.text, props.range?.from],
  async () => {
    if (!props.scrollToRange || !props.range) return;
    await nextTick();
    root.value?.querySelector(`[data-line="${props.range.from}"]`)?.scrollIntoView({ block: 'center' });
  },
  { immediate: true },
);
</script>

<template>
  <div ref="root" class="code">
    <div v-for="(h, i) in html" :key="i" class="ln" :class="{ hl: inRange(i + 1 + offset) }" :data-line="i + 1 + offset">
      <button class="no" tabindex="-1" @click="click(i + 1 + offset, $event)">{{ i + 1 + offset }}</button>
      <!-- eslint-disable-next-line vue/no-v-html -- escaped by highlight.js -->
      <span class="txt" v-html="h || ' '" />
    </div>
  </div>
</template>

<style scoped>
.code {
  font:
    12px/1.55 ui-monospace,
    'SF Mono',
    Menlo,
    monospace;
  overflow: auto;
  background: var(--panel);
}
.ln {
  display: flex;
  min-width: max-content;
}
.ln.hl {
  background: color-mix(in srgb, var(--blocked) 18%, var(--panel));
}
.no {
  position: sticky;
  left: 0;
  flex: none;
  width: 52px;
  padding: 0 10px 0 0;
  border: none;
  border-radius: 0;
  background: var(--panel);
  color: var(--muted);
  text-align: right;
  font: inherit;
  cursor: pointer;
  user-select: none;
}
.ln.hl .no {
  background: color-mix(in srgb, var(--blocked) 26%, var(--panel));
  color: var(--text);
}
.no:hover {
  color: var(--text);
}
.txt {
  white-space: pre;
  padding-right: 16px;
}
</style>
