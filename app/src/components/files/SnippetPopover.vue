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
  <div v-if="shown" class="snippet" :style="{ left: `${Math.max(8, shown.x)}px`, top: `${shown.y}px` }">
    <div class="shead">{{ shown.path }}:{{ shown.line }}</div>
    <CodeView :text="shown.text" :path="shown.path" :first="shown.first" :range="{ from: shown.line, to: shown.line }" />
  </div>
</template>

<style scoped>
.snippet {
  position: fixed;
  z-index: 30;
  width: 550px;
  max-width: calc(100vw - 16px);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.22);
  overflow: hidden;
  pointer-events: none;
}
.shead {
  font:
    11.5px ui-monospace,
    Menlo,
    monospace;
  padding: 4px 10px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}
</style>
