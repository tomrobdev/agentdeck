// "Viewed" is per task and file, and clears itself when the file's change counts move.
import { type Ref, computed, ref, watch } from 'vue';
import type { ChangedFile } from '../../../api/types';
import { loadSetting, saveSetting } from '../../../lib/shared/storage';

export function useViewed(taskId: Ref<number>) {
  const viewedKey = computed(() => `viewed.${taskId.value}`);
  const viewed = ref<Record<string, string>>(loadSetting(viewedKey.value, {}));
  watch(viewedKey, (k) => (viewed.value = loadSetting(k, {})));
  const sig = (f: ChangedFile) => `${f.additions}/${f.deletions}`;
  const isViewed = (f: ChangedFile) => viewed.value[f.path] === sig(f);
  function setViewed(f: ChangedFile, on: boolean) {
    const next = { ...viewed.value };
    if (on) next[f.path] = sig(f);
    else delete next[f.path];
    viewed.value = next;
    saveSetting(viewedKey.value, next);
  }
  return { isViewed, setViewed };
}
