import { type Ref, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { diffQuery } from '#api/work.ts';
import type { FilePatch } from '#api/types.ts';
import { errorMessage } from '#daemon/domain/shared/index.ts';

export type PatchState = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; patch: FilePatch };

export function useFilePatches(taskId: Ref<number>, head: Ref<string | null>, since: Ref<string | null> = ref(null)) {
  const queryClient = useQueryClient();
  const patches = reactive(new Map<string, PatchState>());

  async function loadPatch(path: string) {
    if (patches.has(path)) return;
    const q = diffQuery(taskId.value, path, head.value, since.value);
    const seen = queryClient.getQueryData(q.queryKey);
    if (seen) return void patches.set(path, { state: 'ok', patch: seen });
    const at = `${head.value} ${since.value}`;
    const still = () => at === `${head.value} ${since.value}`;
    patches.set(path, { state: 'loading' });
    try {
      const patch = await queryClient.fetchQuery(q);
      if (still()) patches.set(path, { state: 'ok', patch });
    } catch (e) {
      if (still()) patches.set(path, { state: 'error', error: errorMessage(e) });
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const path = (e.target as HTMLElement).dataset.path;
        if (e.isIntersecting && path) loadPatch(path);
      }
    },
    { rootMargin: '600px 0px' },
  );
  const sections = new Set<HTMLElement>();
  const sectionRef = (ref: unknown) => {
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
    [head, since],
    () => {
      patches.clear();
      void nextTick(reobserve);
    },
    { immediate: true },
  );

  return { patches, sectionRef };
}
