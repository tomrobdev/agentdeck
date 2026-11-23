<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { fileQuery } from '#api/work.ts';
import { snippetOf } from '#lib/runs/verify.ts';
import { useCommits } from '#composables/work/files/useChanges.ts';
import AnchoredPanel from '#components/ui/AnchoredPanel.vue';
import CodeView from '#components/ui/code/CodeView.vue';

const props = defineProps<{ taskId: number; root: HTMLElement | null }>();

const CONTEXT = 5;
const shown = ref<{ path: string; line: number; text: string; first: number; link: HTMLElement } | null>(null);
let timer: number | undefined;
let generation = 0;
const queryClient = useQueryClient();
const { head } = useCommits(toRef(props, 'taskId'));

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
    const path = a.dataset.path;
    if (!path) return;
    const line = Number(a.dataset.line);
    const text = await fileText(path);
    if (text === null || mine !== generation || !a.isConnected) return;
    const snippet = snippetOf(text, { from: line, to: line }, CONTEXT);
    if (snippet) shown.value = { path, line, ...snippet, link: a };
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
