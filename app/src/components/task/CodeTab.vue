<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { type FileContent, type FileRef, type TaskDetail, api } from '../../api';
import { useCopy } from '../../native';
import { isMarkdown as isMarkdownPath } from '../../render';
import { go } from '../../router';
import CodeView, { type LineRange } from '../files/CodeView.vue';
import FileTree, { type TreeNode } from '../files/FileTree.vue';
import Markdown from '../files/Markdown.vue';

// Browse the task's branch (or its base) from git, with line links: #/tasks/16/code?ref=head&path=…&L=10-20
const props = defineProps<{ task: TaskDetail; query: Record<string, string>; changed: Set<string> }>();

// The task's id as its own computed: the 2 s poll replaces the task object, and keying on it would refetch.
const taskId = computed(() => props.task.id);
const ref_ = computed<FileRef>(() => (props.query.ref === 'base' ? 'base' : 'head'));
const path = computed(() => props.query.path ?? null);
const range = computed<LineRange | null>(() => {
  const m = props.query.L?.match(/^(\d+)(?:-(\d+))?$/);
  return m ? { from: Number(m[1]), to: Number(m[2] ?? m[1]) } : null;
});

function setQuery(patch: Record<string, string | null>, replace = false) {
  const query = { ...props.query, ...patch };
  for (const k of Object.keys(query)) if (query[k] === null) delete query[k];
  go({ name: 'task', id: taskId.value, tab: 'code', query: query as Record<string, string> }, { replace });
}

// A new loader per task and ref resets the tree.
const loadTree = computed(() => {
  const id = taskId.value;
  const r = ref_.value;
  return async (dir: string): Promise<TreeNode[]> =>
    (await api.tree(id, r, dir)).entries.map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      meta: e.type === 'file' && e.size !== null && e.size > 100_000 ? `${Math.round(e.size / 1024)} KB` : undefined,
    }));
});

const file = ref<FileContent | null>(null);
const error = ref('');
const raw = ref(false);
watch(
  [taskId, ref_, path],
  async () => {
    file.value = null;
    error.value = '';
    raw.value = false;
    if (!path.value) return;
    try {
      file.value = await api.file(taskId.value, ref_.value, path.value);
    } catch (e) {
      error.value = (e as Error).message;
    }
  },
  { immediate: true },
);

const isMarkdown = computed(() => !!path.value && isMarkdownPath(path.value));
const isImage = computed(() => !!path.value && /\.(png|jpe?g|gif|webp|ico|icns)$/i.test(path.value));
const crumbs = computed(() => (path.value ?? '').split('/').filter(Boolean));
const { copied, copy } = useCopy();
const worktreePath = computed(() => (props.task.worktree && path.value ? `${props.task.worktree}/${path.value}` : null));
const select = (r: LineRange) => setQuery({ L: r.from === r.to ? String(r.from) : `${r.from}-${r.to}` }, true);
</script>

<template>
  <div class="flex min-h-0 flex-1 gap-4 pb-4">
    <aside class="flex min-h-0 w-70 flex-none flex-col gap-2 max-md:hidden">
      <div class="seg *:flex-1">
        <button :class="{ on: ref_ === 'head' }" :title="task.branch ?? ''" @click="setQuery({ ref: 'head', L: null })">Task branch</button>
        <button :class="{ on: ref_ === 'base' }" title="Where the branch started" @click="setQuery({ ref: 'base', L: null })">Base</button>
      </div>
      <FileTree
        v-if="task.branch"
        :load="loadTree"
        :selected="path"
        :marks="ref_ === 'head' ? changed : undefined"
        :known="[...changed]"
        @select="(p) => setQuery({ path: p, L: null })"
      />
      <p v-else class="text-muted">No branch yet.</p>
    </aside>
    <section class="card flex min-w-0 flex-1 flex-col">
      <p v-if="!path" class="p-6 text-muted">Pick a file. Press <kbd>t</kbd> to find one by name.</p>
      <template v-else>
        <header class="card-head px-2.5 py-1.5">
          <nav class="truncate font-mono text-sm leading-[normal]">
            <span v-for="(c, i) in crumbs" :key="i"
              ><span v-if="i" class="mx-[3px] text-muted">/</span><b v-if="i === crumbs.length - 1">{{ c }}</b
              ><span v-else>{{ c }}</span></span
            >
          </nav>
          <span
            v-if="changed.has(path) && ref_ === 'head'"
            class="rounded-full border border-[color-mix(in_srgb,var(--blocked)_45%,transparent)] px-1.5 text-xs text-blocked"
            >changed</span
          >
          <span v-if="file" class="text-sm text-muted">{{
            file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`
          }}</span>
          <div class="spacer" />
          <div v-if="isMarkdown && file?.text !== null" class="seg">
            <button :class="{ on: !raw }" @click="raw = false">Preview</button>
            <button :class="{ on: raw }" @click="raw = true">Code</button>
          </div>
          <button class="btn-mini" @click="copy(path, 'path')">{{ copied === 'path' ? 'Copied' : 'Copy path' }}</button>
          <button v-if="file?.text" class="btn-mini" @click="copy(file.text, 'text')">{{ copied === 'text' ? 'Copied' : 'Copy' }}</button>
          <button v-if="worktreePath" class="btn-mini" title="Copies the file's path in the worktree" @click="copy(worktreePath, 'wt')">
            {{ copied === 'wt' ? 'Copied' : 'Open in editor' }}
          </button>
        </header>
        <p v-if="error" class="m-0 px-3.5 py-3 text-muted">{{ error }}</p>
        <p v-else-if="!file" class="m-0 px-3.5 py-3 text-muted">Loading…</p>
        <p v-else-if="file.binary" class="m-0 px-3.5 py-3 text-muted">
          {{ isImage ? 'Image files aren’t shown yet.' : 'Binary file not shown.' }}
        </p>
        <div v-else-if="isMarkdown && !raw" class="flex-1 overflow-y-auto px-6.5 py-4.5"><Markdown :text="file.text ?? ''" /></div>
        <CodeView
          v-else
          class="min-h-0 flex-1 py-1.5"
          :text="file.text ?? ''"
          :path="path"
          :range="range"
          scroll-to-range
          @select="select"
        />
        <p v-if="file?.truncated" class="m-0 px-3.5 py-3 text-muted">File too large: showing the first 512 KB.</p>
      </template>
    </section>
  </div>
</template>
