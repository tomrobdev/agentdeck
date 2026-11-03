// Patches load as their file scrolls near the view. The query cache keeps them per head commit, so a patch or preview
// seen before shows at once from it; these maps (here and in useFileText) only hold what this page is showing.
import { type Ref, nextTick, onBeforeUnmount, reactive, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { type FilePatch, diffQuery } from '../api';
import { errorMessage } from '../../../daemon/src/domain/text.ts';

export type PatchState = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; patch: FilePatch };

export function useFilePatches(taskId: Ref<number>, head: Ref<string | null>) {
  const queryClient = useQueryClient();
  const patches = reactive(new Map<string, PatchState>());

  async function loadPatch(path: string) {
    if (patches.has(path)) return;
    const q = diffQuery(taskId.value, path, head.value);
    const seen = queryClient.getQueryData(q.queryKey);
    if (seen) return void patches.set(path, { state: 'ok', patch: seen });
    const at = head.value;
    patches.set(path, { state: 'loading' });
    try {
      const patch = await queryClient.fetchQuery(q);
      if (at === head.value) patches.set(path, { state: 'ok', patch });
    } catch (e) {
      if (at === head.value) patches.set(path, { state: 'error', error: errorMessage(e) });
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) loadPatch((e.target as HTMLElement).dataset.path!);
    },
    { rootMargin: '600px 0px' },
  );
  const sections = new Set<HTMLElement>();
  const sectionRef = (ref: unknown) => {
    // A component's ref is its instance; the section is its root element.
    const el = ref instanceof HTMLElement ? ref : (ref as { $el?: unknown } | null)?.$el;
    if (el instanceof HTMLElement && !sections.has(el)) {
      sections.add(el);
      observer.observe(el);
    }
  };
  function reobserve() {
    observer.disconnect();
    for (const el of sections) {
      if (el.isConnected) observer.observe(el);
      else sections.delete(el);
    }
  }
  onBeforeUnmount(() => observer.disconnect());

  watch(
    head,
    () => {
      patches.clear();
      // The sections stay (keyed by path), and observing a section already observed reports nothing, so the ones on
      // screen would stay "Loading…": observe them afresh, which reports each one's visibility again.
      void nextTick(reobserve);
    },
    { immediate: true },
  );

  return { patches, sectionRef };
}
