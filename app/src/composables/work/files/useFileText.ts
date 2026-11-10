import { type MaybeRefOrGetter, reactive, toValue, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { fileQuery } from '../../../api/work';
import { errorMessage } from '../../../../../daemon/src/domain/shared/index.ts';

export function useFileText(taskId: MaybeRefOrGetter<number>, head: MaybeRefOrGetter<string | null>) {
  const queryClient = useQueryClient();
  const text = reactive(new Map<string, string>());
  watch([() => toValue(taskId), () => toValue(head)], () => text.clear(), { flush: 'sync' });

  async function load(path: string) {
    if (text.has(path)) return;
    const id = toValue(taskId);
    const at = toValue(head);
    const q = fileQuery(id, 'head', path, at);
    const seen = queryClient.getQueryData(q.queryKey);
    if (seen) return void text.set(path, seen.text ?? '_Binary file._');
    let shown: string;
    try {
      shown = (await queryClient.fetchQuery(q)).text ?? '_Binary file._';
    } catch (e) {
      shown = `Couldn't load: ${errorMessage(e)}`;
    }
    if (id === toValue(taskId) && at === toValue(head)) text.set(path, shown);
  }

  return { text, load };
}
