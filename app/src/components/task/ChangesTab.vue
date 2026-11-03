<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import {
  CHANGE_LABEL,
  type ChangedFile,
  type Changes,
  type FilePatch,
  type NewReviewComment,
  type TaskDetail,
  ago,
  api,
  diffQuery,
  fileQuery,
} from '../../api';
import { useActions } from '../../composables/useActions';
import { useReviews } from '../../composables/useReviews';
import { isMarkdown } from '../../lib/render';
import { loadSetting, saveSetting } from '../../lib/storage';
import DiffView from '../files/DiffView.vue';
import FileTree, { type TreeNode } from '../files/FileTree.vue';
import Markdown from '../files/Markdown.vue';
import Checkbox from '../ui/Checkbox.vue';
import Delta from '../ui/Delta.vue';
import Disclosure from '../ui/Disclosure.vue';
import DisclosureContent from '../ui/DisclosureContent.vue';
import DisclosureTrigger from '../ui/DisclosureTrigger.vue';
import Popover from '../ui/Popover.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';

// What the task's branch changes against the base branch: a tree of changed files and their diffs.
const props = defineProps<{ task: TaskDetail; changes: Changes | null; error: string }>();
const emit = defineEmits<{ open: [path: string] }>();

// Line comments go into the task's draft review (started with the first one); the review bar submits it.
const { run } = useActions();
const { byPath, openPaths } = useReviews(computed(() => props.task.id));
function addComment(path: string, line: Pick<NewReviewComment, 'side' | 'line'>, body: string) {
  const head = props.changes?.head;
  if (!head) return Promise.resolve(false);
  return run(async () => {
    const review = await api.startReview(props.task.id);
    await api.addComment(review.id, { path, ...line, head_commit: head, body });
  });
}

const split = ref(loadSetting('diffSplit', false));
const hideViewed = ref(false);
watch(split, (v) => saveSetting('diffSplit', v));

const files = computed(() => props.changes?.files ?? []);
const totals = computed(() => files.value.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }));

// "Viewed" is per task and file, and clears itself when the file's change counts move.
const viewedKey = computed(() => `viewed.${props.task.id}`);
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
  if (on) collapsed.add(f.path);
  else collapsed.delete(f.path);
}

const collapsed = reactive(new Set<string>());
const shown = computed(() => files.value.filter((f) => !(hideViewed.value && isViewed(f))));

// Patches load as their file scrolls near the view. The query cache keeps them per head commit, so a patch
// or preview seen before shows at once from it; these maps only hold what this page is showing.
const queryClient = useQueryClient();
type PatchState = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; patch: FilePatch };
const patches = reactive(new Map<string, PatchState>());
const preview = reactive(new Map<string, string>());
const previewOn = reactive(new Set<string>());
watch(
  () => props.changes?.head,
  () => {
    patches.clear();
    preview.clear();
    previewOn.clear();
    for (const f of files.value) if (isViewed(f)) collapsed.add(f.path);
    // The sections stay (keyed by path), and observing a section already observed reports nothing, so the ones on
    // screen would stay "Loading…": observe them afresh, which reports each one's visibility again.
    void nextTick(reobserve);
  },
  { immediate: true },
);

async function loadPatch(path: string) {
  if (patches.has(path)) return;
  const q = diffQuery(props.task.id, path, props.changes?.head ?? null);
  const seen = queryClient.getQueryData(q.queryKey);
  if (seen) return void patches.set(path, { state: 'ok', patch: seen });
  const head = props.changes?.head;
  patches.set(path, { state: 'loading' });
  try {
    const patch = await queryClient.fetchQuery(q);
    if (head === props.changes?.head) patches.set(path, { state: 'ok', patch });
  } catch (e) {
    if (head === props.changes?.head) patches.set(path, { state: 'error', error: (e as Error).message });
  }
}

async function togglePreview(path: string) {
  if (previewOn.has(path)) return previewOn.delete(path);
  previewOn.add(path);
  if (preview.has(path)) return;
  const head = props.changes?.head ?? null;
  const q = fileQuery(props.task.id, 'head', path, head);
  const seen = queryClient.getQueryData(q.queryKey);
  if (seen) return void preview.set(path, seen.text ?? '_Binary file._');
  try {
    preview.set(path, (await queryClient.fetchQuery(q)).text ?? '_Binary file._');
  } catch (e) {
    preview.set(path, `Couldn't load: ${(e as Error).message}`);
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

// The changed paths as a tree, with single-child folders joined ("daemon/src").
const loadTree = computed(() => {
  const byPath = new Map(files.value.map((f) => [f.path, f]));
  type Dir = { dirs: Map<string, Dir>; files: string[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const p of byPath.keys()) {
    const parts = p.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [] });
      d = d.dirs.get(part)!;
    }
    d.files.push(p);
  }
  const index = new Map<string, Dir>([['', root]]);
  const nodes = (dir: Dir, base: string): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const [name, child] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let path = base ? `${base}/${name}` : name;
      let d = child;
      while (d.files.length === 0 && d.dirs.size === 1) {
        const [n, c] = [...d.dirs][0];
        label += `/${n}`;
        path += `/${n}`;
        d = c;
      }
      index.set(path, d);
      out.push({ name: label, path, type: 'dir' });
    }
    for (const p of [...dir.files].sort()) {
      const f = byPath.get(p)!;
      out.push({
        name: p.split('/').pop()!,
        path: p,
        type: 'file',
        badge: f.status,
        badgeTitle: CHANGE_LABEL[f.status],
        meta: f.binary ? 'bin' : undefined,
        delta: f.binary ? undefined : { add: f.additions, del: f.deletions },
      });
    }
    return out;
  };
  return async (dir: string): Promise<TreeNode[]> => {
    const d = index.get(dir);
    return d ? nodes(d, dir) : [];
  };
});

const current = ref<string | null>(null);
async function jump(path: string) {
  current.value = path;
  collapsed.delete(path);
  await nextTick();
  document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' });
}
</script>

<template>
  <div class="flex flex-col">
    <p v-if="error" class="py-2 text-muted">{{ error }}</p>
    <p v-else-if="!changes" class="py-2 text-muted">Loading changes…</p>
    <p v-else-if="!files.length" class="py-2 text-muted">
      No changes against <code>{{ changes.base_ref }}</code> yet.
    </p>
    <template v-else>
      <div class="flex items-center gap-2 pb-2.5">
        <b>{{ files.length }} {{ files.length === 1 ? 'file' : 'files' }}</b>
        <Delta class="text-sm" :add="totals.add" :del="totals.del" />
        <Popover>
          <template #trigger
            ><button class="btn-mini">
              {{ changes.commits.length }} {{ changes.commits.length === 1 ? 'commit' : 'commits' }} ▾
            </button></template
          >
          <div v-for="c in changes.commits" :key="c.sha" class="flex gap-2 px-2 py-1 text-sm whitespace-nowrap">
            <code>{{ c.sha.slice(0, 7) }}</code>
            <span class="max-w-[380px] flex-1 truncate">{{ c.subject }}</span>
            <span class="text-muted">{{ ago(c.at) }}</span>
          </div>
        </Popover>
        <div class="spacer" />
        <Checkbox v-model="hideViewed">Hide viewed</Checkbox>
        <SegmentedControl
          label="Diff layout"
          :options="[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]"
          :model-value="split ? 'split' : 'unified'"
          @update:model-value="(v) => (split = v === 'split')"
        />
      </div>
      <div class="flex items-start gap-4">
        <!-- The page scrolls as one; the tree sticks beside the diffs at the scroller's height (TaskPage makes it a size container). -->
        <aside class="sticky top-0 h-[calc(100cqh-1.5rem)] min-h-0 w-65 flex-none pb-4 max-md:hidden">
          <FileTree
            :load="loadTree"
            :selected="current"
            :commented="openPaths"
            expand-all
            :known="files.map((f) => f.path)"
            @select="jump"
          />
        </aside>
        <div class="min-w-0 flex-1">
          <Disclosure
            v-for="f in shown"
            :key="f.path"
            :ref="sectionRef"
            class="card mb-3"
            :data-path="f.path"
            :open="!collapsed.has(f.path)"
            @update:open="(o) => (o ? collapsed.delete(f.path) : collapsed.add(f.path))"
          >
            <header class="card-head sticky top-0 z-[1] px-2.5 py-1.5">
              <DisclosureTrigger
                class="grid size-7 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-panel-2 hover:text-text"
                :title="collapsed.has(f.path) ? 'Expand' : 'Collapse'"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="size-4 transition-transform"
                  :class="collapsed.has(f.path) && '-rotate-90'"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </DisclosureTrigger>
              <span class="badge" :class="`b-${f.status}`" :title="CHANGE_LABEL[f.status]">{{ f.status }}</span>
              <span class="truncate font-mono text-sm leading-[normal]">
                <template v-if="f.old_path">{{ f.old_path }} → </template>{{ f.path }}
              </span>
              <Delta class="text-sm" :add="f.additions" :del="f.deletions" />
              <div class="spacer" />
              <button
                v-if="isMarkdown(f.path) && f.status !== 'D'"
                class="btn-mini"
                :class="previewOn.has(f.path) && 'border-accent'"
                @click="togglePreview(f.path)"
              >
                Preview
              </button>
              <button v-if="f.status !== 'D'" class="btn-mini" title="Open the whole file" @click="emit('open', f.path)">View file</button>
              <Checkbox :model-value="isViewed(f)" @update:model-value="(v) => setViewed(f, v)">Viewed</Checkbox>
            </header>
            <DisclosureContent>
              <div v-if="previewOn.has(f.path)" class="px-4.5 py-3.5">
                <Markdown v-if="preview.has(f.path)" :text="preview.get(f.path)!" />
                <p v-else class="text-muted">Loading…</p>
              </div>
              <p v-else-if="f.binary" class="m-0 px-3.5 py-2.5 text-muted">Binary file not shown.</p>
              <template v-for="p in [patches.get(f.path)]" v-else :key="f.path">
                <p v-if="p?.state === 'error'" class="m-0 px-3.5 py-2.5 text-muted">{{ p.error }}</p>
                <template v-else-if="p?.state === 'ok'">
                  <DiffView
                    :path="f.path"
                    :patch="p.patch.patch"
                    :split="split"
                    :comments="byPath.get(f.path)"
                    :add="(line, body) => addComment(f.path, line, body)"
                  />
                  <p v-if="p.patch.truncated" class="m-0 px-3.5 py-2.5 text-muted">Diff too large: showing the first 256 KB.</p>
                </template>
                <p v-else class="m-0 px-3.5 py-2.5 text-muted">Loading…</p>
              </template>
            </DisclosureContent>
          </Disclosure>
          <p v-if="!shown.length" class="py-2 text-muted">Every file is marked viewed.</p>
        </div>
      </div>
    </template>
  </div>
</template>
