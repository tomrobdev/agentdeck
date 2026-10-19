<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { CHANGE_LABEL, type ChangedFile, type Changes, type FilePatch, type TaskDetail, ago, api } from '../../api';
import { isMarkdown } from '../../render';
import { loadSetting, saveSetting } from '../../taskView';
import DiffView from '../files/DiffView.vue';
import FileTree, { type TreeNode } from '../files/FileTree.vue';
import Markdown from '../files/Markdown.vue';
import Popover from '../queue/Popover.vue';

// What the task's branch changes against the base branch: a tree of changed files and their diffs.
const props = defineProps<{ task: TaskDetail; changes: Changes | null; error: string }>();
const emit = defineEmits<{ open: [path: string] }>();

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

// Patches load as their file scrolls near the view; the cache is per head commit.
type PatchState = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; patch: FilePatch };
const patches = reactive(new Map<string, PatchState>());
const preview = reactive(new Map<string, string>());
const previewOn = reactive(new Set<string>());
watch(
  () => props.changes?.head,
  () => {
    patches.clear();
    preview.clear();
    for (const f of files.value) if (isViewed(f)) collapsed.add(f.path);
  },
  { immediate: true },
);

async function loadPatch(path: string) {
  if (patches.has(path)) return;
  patches.set(path, { state: 'loading' });
  try {
    patches.set(path, { state: 'ok', patch: await api.diff(props.task.id, path) });
  } catch (e) {
    patches.set(path, { state: 'error', error: (e as Error).message });
  }
}

async function togglePreview(path: string) {
  if (previewOn.has(path)) return previewOn.delete(path);
  previewOn.add(path);
  if (!preview.has(path)) {
    try {
      const f = await api.file(props.task.id, 'head', path);
      preview.set(path, f.text ?? '_Binary file._');
    } catch (e) {
      preview.set(path, `Couldn't load: ${(e as Error).message}`);
    }
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) loadPatch((e.target as HTMLElement).dataset.path!);
  },
  { rootMargin: '600px 0px' },
);
const sectionRef = (el: unknown) => {
  if (el instanceof HTMLElement) observer.observe(el);
};
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
        meta: f.binary ? 'bin' : `+${f.additions} −${f.deletions}`,
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
  <div class="changes">
    <p v-if="error" class="muted note">{{ error }}</p>
    <p v-else-if="!changes" class="muted note">Loading changes…</p>
    <p v-else-if="!files.length" class="muted note">
      No changes against <code>{{ changes.base_ref }}</code> yet.
    </p>
    <template v-else>
      <div class="bar">
        <b>{{ files.length }} {{ files.length === 1 ? 'file' : 'files' }}</b>
        <span class="add">+{{ totals.add }}</span
        ><span class="del">−{{ totals.del }}</span>
        <Popover>
          <template #trigger
            ><button class="mini">
              {{ changes.commits.length }} {{ changes.commits.length === 1 ? 'commit' : 'commits' }} ▾
            </button></template
          >
          <div v-for="c in changes.commits" :key="c.sha" class="commit">
            <code>{{ c.sha.slice(0, 7) }}</code>
            <span class="subj">{{ c.subject }}</span>
            <span class="muted">{{ ago(c.at) }}</span>
          </div>
        </Popover>
        <div class="spacer" />
        <label class="check"><input v-model="hideViewed" type="checkbox" /> Hide viewed</label>
        <div class="seg">
          <button :class="{ on: !split }" @click="split = false">Unified</button>
          <button :class="{ on: split }" @click="split = true">Split</button>
        </div>
      </div>
      <div class="body">
        <aside class="tree">
          <FileTree :load="loadTree" :selected="current" expand-all :known="files.map((f) => f.path)" @select="jump" />
        </aside>
        <div class="files">
          <section v-for="f in shown" :key="f.path" :ref="sectionRef" class="file" :data-path="f.path">
            <header class="fhead">
              <button class="fold" @click="collapsed.has(f.path) ? collapsed.delete(f.path) : collapsed.add(f.path)">
                {{ collapsed.has(f.path) ? '▸' : '▾' }}
              </button>
              <span class="badge" :class="`b-${f.status}`" :title="CHANGE_LABEL[f.status]">{{ f.status }}</span>
              <span class="path">
                <template v-if="f.old_path">{{ f.old_path }} → </template>{{ f.path }}
              </span>
              <span class="add">+{{ f.additions }}</span
              ><span class="del">−{{ f.deletions }}</span>
              <div class="spacer" />
              <button
                v-if="isMarkdown(f.path) && f.status !== 'D'"
                class="mini"
                :class="{ on: previewOn.has(f.path) }"
                @click="togglePreview(f.path)"
              >
                Preview
              </button>
              <button v-if="f.status !== 'D'" class="mini" title="Open the whole file" @click="emit('open', f.path)">View file</button>
              <label class="check"><input type="checkbox" :checked="isViewed(f)" @change="setViewed(f, !isViewed(f))" /> Viewed</label>
            </header>
            <template v-if="!collapsed.has(f.path)">
              <div v-if="previewOn.has(f.path)" class="preview">
                <Markdown v-if="preview.has(f.path)" :text="preview.get(f.path)!" />
                <p v-else class="muted">Loading…</p>
              </div>
              <p v-else-if="f.binary" class="muted pad">Binary file not shown.</p>
              <template v-for="p in [patches.get(f.path)]" v-else :key="f.path">
                <p v-if="p?.state === 'error'" class="muted pad">{{ p.error }}</p>
                <template v-else-if="p?.state === 'ok'">
                  <DiffView :path="f.path" :patch="p.patch.patch" :split="split" />
                  <p v-if="p.patch.truncated" class="muted pad">Diff too large: showing the first 256 KB.</p>
                </template>
                <p v-else class="muted pad">Loading…</p>
              </template>
            </template>
          </section>
          <p v-if="!shown.length" class="muted note">Every file is marked viewed.</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.changes {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.note {
  padding: 8px 0;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
}
.add {
  color: var(--done);
  font:
    12px ui-monospace,
    Menlo,
    monospace;
}
.del {
  color: var(--failed);
  font:
    12px ui-monospace,
    Menlo,
    monospace;
}
.spacer {
  flex: 1;
}
.mini {
  padding: 1px 8px;
  font-size: 12px;
}
.mini.on {
  border-color: var(--accent);
}
.check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.check input {
  width: auto;
  margin: 0;
}
.commit {
  display: flex;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  white-space: nowrap;
}
.subj {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 380px;
}
.body {
  display: flex;
  gap: 16px;
  min-height: 0;
  flex: 1;
}
.tree {
  width: 260px;
  flex: none;
  min-height: 0;
  padding-bottom: 16px;
}
.files {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding-bottom: 24px;
}
.file {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 12px;
  background: var(--panel);
  overflow: hidden;
}
.fhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 1;
}
.fold {
  border: none;
  background: none;
  padding: 0 4px;
  color: var(--muted);
}
.path {
  font:
    12.5px ui-monospace,
    Menlo,
    monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad {
  padding: 10px 14px;
  margin: 0;
}
.preview {
  padding: 14px 18px;
}
@media (max-width: 900px) {
  .tree {
    display: none;
  }
}
</style>
