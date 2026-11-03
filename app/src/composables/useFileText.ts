// The text of files at a task's head commit, for the markdown preview and the documents card. A document seen at this
// head commit comes from the query cache at once. When the head moves the texts clear, and an answer that comes back for
// the old head is dropped, so text from an old commit never lands on the new one.
import { type MaybeRefOrGetter, reactive, toValue, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { fileQuery } from '../api';
import { errorMessage } from '../../../daemon/src/domain/text.ts';

export function useFileText(taskId: MaybeRefOrGetter<number>, head: MaybeRefOrGetter<string | null>) {
  const queryClient = useQueryClient();
  const text = reactive(new Map<string, string>());
  // Sync, so the texts are gone before any other watcher on the head asks for them again.
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
