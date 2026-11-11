import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { landingApi } from '../../../api/landing';
import { changesSinceQuery } from '../../../api/work';
import type { ChangedFile, Changes, NewReviewComment, TaskDetail } from '../../../api/types';
import { changedTree } from '../../../lib/work/files/changed-tree';
import { totalLines, visibleComments } from '../../../lib/work/files/changes-view';
import { shownSince } from '../../../lib/work/files/since';
import { openCommentOrder, stepFrom } from '../../../lib/work/queue/review-nav';
import { loadSetting, saveSetting } from '../../../lib/shared/storage';
import { useActions } from '../../shared/useActions';
import { useHotkeys } from '../../shared/useHotkeys';
import { useReviews } from '../../landing/useReviews';
import { useFilePatches } from './useFilePatches';
import { useFileText } from './useFileText';
import { useViewed } from './useViewed';

export function useChangesTab(props: { task: TaskDetail; changes: Changes | null }) {
  const taskId = computed(() => props.task.id);

  const picked = ref<string | null>(null);
  watch(taskId, () => (picked.value = null));
  const point = computed(() => shownSince(props.changes?.since_points ?? [], picked.value));
  const since = computed(() => point.value?.sha ?? null);
  const sinceQ = useQuery(
    computed(() => ({ ...changesSinceQuery(taskId.value, since.value ?? '', props.changes?.head ?? null), enabled: !!since.value })),
  );
  const shown = computed<Changes | null>(() => {
    if (!since.value) return props.changes;
    const data = sinceQ.data.value;
    return data && data.since === since.value && data.head === props.changes?.head ? data : null;
  });
  const sinceError = computed(() => (since.value ? (sinceQ.error.value?.message ?? '') : ''));
  const head = computed(() => shown.value?.head ?? null);

  const { run } = useActions();
  const { byPath, openPaths, comments } = useReviews(taskId);
  const commentsOn = (path: string) => visibleComments(byPath.value.get(path), !!since.value);
  function addComment(path: string, line: Pick<NewReviewComment, 'side' | 'line'>, body: string) {
    const commitHead = shown.value?.head;
    if (!commitHead) return Promise.resolve(false);
    return run(async () => {
      if (since.value && line.side === 'old')
        throw new Error(`Comment on a removed line in the changes against ${shown.value?.base_ref ?? 'the base'}`);
      const review = await landingApi.startReview(props.task.id);
      await landingApi.addComment(review.id, { path, ...line, head_commit: commitHead, body });
    });
  }

  const split = ref(loadSetting('diffSplit', false));
  const hideViewed = ref(false);
  watch(split, (v) => saveSetting('diffSplit', v));

  const files = computed(() => shown.value?.files ?? []);
  const totals = computed(() => totalLines(files.value));

  const { isViewed, setViewed } = useViewed(taskId);
  const collapsed = reactive(new Set<string>());
  function markViewed(f: ChangedFile, on: boolean) {
    setViewed(f, on);
    if (on) collapsed.add(f.path);
    else collapsed.delete(f.path);
  }
  const listed = computed(() => files.value.filter((f) => !(hideViewed.value && isViewed(f))));

  const { patches, sectionRef } = useFilePatches(taskId, head, since);
  const { text: preview, load: loadPreview } = useFileText(taskId, head);
  const previewOn = reactive(new Set<string>());
  watch(
    [head, since],
    () => {
      previewOn.clear();
      for (const f of files.value) if (isViewed(f)) collapsed.add(f.path);
    },
    { immediate: true },
  );
  function togglePreview(path: string) {
    if (previewOn.has(path)) {
      previewOn.delete(path);
      return;
    }
    previewOn.add(path);
    void loadPreview(path);
  }

  const loadTree = computed(() => {
    const tree = changedTree(files.value);
    return async (dir: string) => tree.get(dir) ?? [];
  });

  const current = ref<string | null>(null);
  async function jump(path: string) {
    current.value = path;
    collapsed.delete(path);
    await nextTick();
    document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' });
  }

  async function scrollToComment(id: number, path: string) {
    current.value = path;
    collapsed.delete(path);
    await nextTick();
    document.querySelector(`[data-comment="${id}"]`)?.scrollIntoView({ block: 'center' });
  }
  let currentComment: number | null = null;
  function stepComment(by: 1 | -1) {
    const list = openCommentOrder(
      comments.value,
      files.value.map((f) => f.path),
    );
    const at = list.find((c) => c.id === currentComment) ?? null;
    const next = stepFrom(list, at, by);
    if (!next) return;
    currentComment = next.id;
    void scrollToComment(next.id, next.path);
  }
  function stepFile(by: 1 | -1) {
    const next = stepFrom(
      files.value.map((f) => f.path),
      current.value,
      by,
    );
    if (next) void jump(next);
  }
  function toggleViewed() {
    const f = files.value.find((x) => x.path === current.value);
    if (f) markViewed(f, !isViewed(f));
  }
  useHotkeys({
    j: { label: 'Next file', scope: 'diff', run: () => stepFile(1) },
    k: { label: 'Previous file', scope: 'diff', run: () => stepFile(-1) },
    ']': { label: 'Next comment', scope: 'diff', run: () => stepComment(1) },
    '[': { label: 'Previous comment', scope: 'diff', run: () => stepComment(-1) },
    v: { label: 'Mark the file viewed', scope: 'diff', run: toggleViewed },
  });

  return {
    picked,
    point,
    shown,
    sinceError,
    files,
    totals,
    listed,
    split,
    hideViewed,
    openPaths,
    commentsOn,
    addComment,
    isViewed,
    markViewed,
    collapsed,
    patches,
    sectionRef,
    preview,
    previewOn,
    togglePreview,
    loadTree,
    current,
    jump,
  };
}
