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
  <div class="code-tab">
    <aside class="side">
      <div class="seg refs">
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
      <p v-else class="muted">No branch yet.</p>
    </aside>
    <section class="viewer">
      <p v-if="!path" class="muted hint">Pick a file. Press <kbd>t</kbd> to find one by name.</p>
      <template v-else>
        <header class="vhead">
          <nav class="crumbs">
            <span v-for="(c, i) in crumbs" :key="i"
              ><span v-if="i" class="sep">/</span><b v-if="i === crumbs.length - 1">{{ c }}</b
              ><span v-else>{{ c }}</span></span
            >
          </nav>
          <span v-if="changed.has(path) && ref_ === 'head'" class="chip">changed</span>
          <span v-if="file" class="muted size">{{ file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB` }}</span>
          <div class="spacer" />
          <div v-if="isMarkdown && file?.text !== null" class="seg">
            <button :class="{ on: !raw }" @click="raw = false">Preview</button>
            <button :class="{ on: raw }" @click="raw = true">Code</button>
          </div>
          <button class="mini" @click="copy(path, 'path')">{{ copied === 'path' ? 'Copied' : 'Copy path' }}</button>
          <button v-if="file?.text" class="mini" @click="copy(file.text, 'text')">{{ copied === 'text' ? 'Copied' : 'Copy' }}</button>
          <button v-if="worktreePath" class="mini" title="Copies the file's path in the worktree" @click="copy(worktreePath, 'wt')">
            {{ copied === 'wt' ? 'Copied' : 'Open in editor' }}
          </button>
        </header>
        <p v-if="error" class="muted pad">{{ error }}</p>
        <p v-else-if="!file" class="muted pad">Loading…</p>
        <p v-else-if="file.binary" class="muted pad">{{ isImage ? 'Image files aren’t shown yet.' : 'Binary file not shown.' }}</p>
        <div v-else-if="isMarkdown && !raw" class="mdview"><Markdown :text="file.text ?? ''" /></div>
        <CodeView v-else class="cv" :text="file.text ?? ''" :path="path" :range="range" scroll-to-range @select="select" />
        <p v-if="file?.truncated" class="muted pad">File too large: showing the first 512 KB.</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.code-tab {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
  padding-bottom: 16px;
}
.side {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.refs button {
  flex: 1;
}
.viewer {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.hint {
  padding: 24px;
}
.vhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.crumbs {
  font:
    12.5px ui-monospace,
    Menlo,
    monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sep {
  color: var(--muted);
  margin: 0 3px;
}
.chip {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--blocked) 45%, transparent);
  color: var(--blocked);
}
.size {
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.mini {
  padding: 1px 8px;
  font-size: 12px;
}
.pad {
  padding: 12px 14px;
  margin: 0;
}
.cv {
  flex: 1;
  min-height: 0;
  padding: 6px 0;
}
.mdview {
  padding: 18px 26px;
  overflow-y: auto;
  flex: 1;
}
kbd {
  font:
    11px ui-monospace,
    Menlo,
    monospace;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0 4px;
}
@media (max-width: 900px) {
  .side {
    display: none;
  }
}
</style>
