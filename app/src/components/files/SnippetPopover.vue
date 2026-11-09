<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { fileQuery } from '../../api';
import { useCommits } from '../../composables/task/useChanges';
import AnchoredPanel from '../ui/AnchoredPanel.vue';
import CodeView from './CodeView.vue';

// Hovering a `path:line` link inside `root` shows the lines around it, read from the task branch. The panel flips near
// the viewport edge. It closes when the pointer leaves the link, on Escape, on scroll, and when the link leaves the page
// (a tab switch). A file that arrives after any of those is dropped.
const props = defineProps<{ taskId: number; root: HTMLElement | null }>();

const CONTEXT = 5;
const shown = ref<{ path: string; line: number; text: string; first: number; link: HTMLElement } | null>(null);
let timer: number | undefined;
/** Counts hovers and closes: a fetch started under an older number is stale when it finishes. */
let generation = 0;
const queryClient = useQueryClient();
const { head } = useCommits(toRef(props, 'taskId'));

/** The file's text at the task's head commit: the query cache keeps it, so a second hover makes no request. */
async function fileText(path: string): Promise<string | null> {
  try {
    return (await queryClient.fetchQuery(fileQuery(props.taskId, 'head', path, head.value))).text;
  } catch {
    return null;
  }
}

function onOver(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest<HTMLElement>('a.path[data-line]');
  if (!a || !a.dataset.line) return;
  clearTimeout(timer);
  const mine = ++generation;
  timer = window.setTimeout(async () => {
    const path = a.dataset.path!;
    const line = Number(a.dataset.line);
    const text = await fileText(path);
    if (text === null || mine !== generation || !a.isConnected) return;
    const lines = text.split('\n');
    const first = Math.max(1, line - CONTEXT);
    shown.value = { path, line, first, text: lines.slice(first - 1, line + CONTEXT).join('\n'), link: a };
  }, 250);
}
function close() {
  generation++;
  clearTimeout(timer);
  shown.value = null;
}
function onOut(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('a.path')) close();
}

// While it is open: any scroll closes it, and so does its link leaving the page.
const gone = new MutationObserver(() => shown.value && !shown.value.link.isConnected && close());
watch(shown, (s) => {
  if (s) {
    window.addEventListener('scroll', close, { capture: true, passive: true });
    gone.observe(document.body, { childList: true, subtree: true });
  } else {
    window.removeEventListener('scroll', close, { capture: true });
    gone.disconnect();
  }
});
onMounted(() => {
  props.root?.addEventListener('mouseover', onOver);
  props.root?.addEventListener('mouseout', onOut);
});
onBeforeUnmount(() => {
  close();
  props.root?.removeEventListener('mouseover', onOver);
  props.root?.removeEventListener('mouseout', onOut);
});
</script>

<template>
  <AnchoredPanel :open="!!shown" :anchor="shown?.link ?? null" @close="close">
    <template v-if="shown">
      <div class="border-b border-border bg-panel-2 px-2.5 py-1 font-mono text-xs text-muted">{{ shown.path }}:{{ shown.line }}</div>
      <CodeView :text="shown.text" :path="shown.path" :first="shown.first" :range="{ from: shown.line, to: shown.line }" />
    </template>
  </AnchoredPanel>
</template>
