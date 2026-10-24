<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../api';
import CodeView from './CodeView.vue';

// Hovering a `path:line` link inside `root` shows the lines around it, read from the task branch.
const props = defineProps<{ taskId: number; root: HTMLElement | null }>();

const CONTEXT = 5;
const shown = ref<{ path: string; line: number; text: string; first: number; x: number; y: number } | null>(null);
const cache = new Map<string, Promise<string | null>>();
let timer: number | undefined;

function fileText(path: string): Promise<string | null> {
  if (!cache.has(path))
    cache.set(
      path,
      api.file(props.taskId, 'head', path).then(
        (f) => f.text,
        () => null,
      ),
    );
  return cache.get(path)!;
}

function onOver(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest<HTMLElement>('a.path[data-line]');
  if (!a || !a.dataset.line) return;
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    const path = a.dataset.path!;
    const line = Number(a.dataset.line);
    const text = await fileText(path);
    if (text === null) return;
    const lines = text.split('\n');
    const first = Math.max(1, line - CONTEXT);
    const rect = a.getBoundingClientRect();
    shown.value = {
      path,
      line,
      first,
      text: lines.slice(first - 1, line + CONTEXT).join('\n'),
      x: Math.min(rect.left, window.innerWidth - 560),
      y: rect.bottom + 6,
    };
  }, 250);
}
function onOut(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('a.path')) {
    clearTimeout(timer);
    shown.value = null;
  }
}
onMounted(() => {
  props.root?.addEventListener('mouseover', onOver);
  props.root?.addEventListener('mouseout', onOut);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  props.root?.removeEventListener('mouseover', onOver);
  props.root?.removeEventListener('mouseout', onOut);
});
</script>

<template>
  <div
    v-if="shown"
    class="pointer-events-none fixed z-30 w-[550px] max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-border bg-panel shadow-popover"
    :style="{ left: `${Math.max(8, shown.x)}px`, top: `${shown.y}px` }"
  >
    <div class="border-b border-border bg-panel-2 px-2.5 py-1 font-mono text-xs text-muted">{{ shown.path }}:{{ shown.line }}</div>
    <CodeView :text="shown.text" :path="shown.path" :first="shown.first" :range="{ from: shown.line, to: shown.line }" />
  </div>
</template>
