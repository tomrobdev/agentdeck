<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { highlightLines, languageFor } from '../../../lib/shared/render';

export interface LineRange {
  from: number;
  to: number;
}

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
  <div ref="root" class="overflow-auto bg-panel font-mono text-sm leading-[1.55]">
    <div
      v-for="(h, i) in html"
      :key="i"
      class="flex min-w-max"
      :class="inRange(i + 1 + offset) ? 'bg-[color-mix(in_srgb,var(--blocked)_18%,var(--panel))]' : ''"
      :data-line="i + 1 + offset"
    >
      <button
        class="sticky left-0 w-[52px] flex-none cursor-pointer rounded-none border-none py-0 pr-2.5 pl-0 text-right select-none hover:text-text"
        :class="inRange(i + 1 + offset) ? 'bg-[color-mix(in_srgb,var(--blocked)_26%,var(--panel))] text-text' : 'bg-panel text-muted'"
        tabindex="-1"
        @click="click(i + 1 + offset, $event)"
      >
        {{ i + 1 + offset }}
      </button>
      <span class="pr-4 whitespace-pre" v-html="h || ' '" />
    </div>
  </div>
</template>
