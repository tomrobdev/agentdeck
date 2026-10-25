<script setup lang="ts">
import { ref } from 'vue';
import { MERGE_METHODS, type MergeMethod, type Repo, type RepoDeletion, type RepoDetail, ago, api } from '../api';
import Modal from './Modal.vue';

defineProps<{ repos: Repo[] }>();
const emit = defineEmits<{ close: []; changed: [] }>();

// Add form
const path = ref('');
const name = ref('');
const test = ref('');
const error = ref('');
const saving = ref(false);

// Per-repo editor
const open = ref<RepoDetail | null>(null);
const goals = ref('');
const autoApprove = ref(false);
const testCmd = ref('');
const mergeMethod = ref<MergeMethod>('squash');
const autoResolve = ref(true);
const sandbox = ref(true);
const network = ref('');
const editError = ref('');
const editMsg = ref('');
const busy = ref<'' | 'save' | 'plan'>('');

async function add() {
  error.value = '';
  saving.value = true;
  try {
    const repo = await api.addRepo({ path: path.value.trim(), name: name.value.trim() || undefined, test: test.value.trim() || undefined });
    path.value = name.value = test.value = '';
    emit('changed');
    await edit(repo);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

function load(d: RepoDetail) {
  open.value = d;
  goals.value = d.goals;
  autoApprove.value = !!d.auto_approve;
  testCmd.value = d.test_cmd ?? '';
  mergeMethod.value = d.merge_method;
  autoResolve.value = !!d.auto_resolve;
  sandbox.value = !!d.sandbox;
  network.value = parseHosts(d.network).join(', ');
}

async function edit(r: Repo) {
  editError.value = editMsg.value = '';
  if (open.value?.id === r.id) return void (open.value = null);
  try {
    load(await api.repo(r.id));
  } catch (e) {
    editError.value = (e as Error).message;
  }
}

async function save(): Promise<boolean> {
  if (!open.value) return false;
  editError.value = editMsg.value = '';
  busy.value = 'save';
  try {
    load(
      await api.updateRepo(open.value.id, {
        goals: goals.value,
        auto_approve: autoApprove.value,
        test_cmd: testCmd.value,
        merge_method: mergeMethod.value,
        auto_resolve: autoResolve.value,
        sandbox: sandbox.value,
        network: network.value.split(/[\s,]+/).filter(Boolean),
      }),
    );
    editMsg.value = 'Saved';
    emit('changed');
    return true;
  } catch (e) {
    editError.value = (e as Error).message;
    return false;
  } finally {
    busy.value = '';
  }
}

async function planNow() {
  if (!open.value || !(await save())) return;
  busy.value = 'plan';
  editMsg.value = 'Planning… this reads the repo and can take a minute.';
  try {
    const res = await api.plan(open.value.id);
    editMsg.value =
      res.outcome === 'proposed'
        ? `${res.tasks.length} task(s) ${autoApprove.value ? 'queued' : 'proposed: approve them under Needs you'}.`
        : res.outcome === 'nothing'
          ? `Nothing to propose${res.note ? `: ${res.note}` : '.'}`
          : `Planner ${res.outcome}${res.note ? `: ${res.note}` : ''}`;
    load(await api.repo(open.value.id));
    emit('changed');
  } catch (e) {
    editError.value = (e as Error).message;
    editMsg.value = '';
  } finally {
    busy.value = '';
  }
}

// Archived repos
const archived = ref<Repo[]>([]);
const archiveError = ref('');
const deleting = ref<{ repo: Repo; counts: RepoDeletion } | null>(null);
const typed = ref('');
const deleteBusy = ref(false);

async function loadArchived() {
  try {
    archived.value = await api.archivedRepos();
  } catch (e) {
    archiveError.value = (e as Error).message;
  }
}
loadArchived();

async function archive() {
  if (!open.value) return;
  archiveError.value = '';
  try {
    await api.archiveRepo(open.value.id);
    open.value = null;
    emit('changed');
    await loadArchived();
  } catch (e) {
    editError.value = (e as Error).message;
  }
}

async function unarchive(r: Repo) {
  archiveError.value = '';
  try {
    await api.unarchiveRepo(r.id);
    if (deleting.value?.repo.id === r.id) deleting.value = null;
    emit('changed');
    await loadArchived();
  } catch (e) {
    archiveError.value = (e as Error).message;
  }
}

async function askDelete(r: Repo) {
  archiveError.value = '';
  typed.value = '';
  try {
    deleting.value = { repo: r, counts: await api.repoDeletion(r.id) };
  } catch (e) {
    archiveError.value = (e as Error).message;
  }
}

async function confirmDelete() {
  const d = deleting.value;
  if (!d || typed.value !== d.repo.name) return;
  deleteBusy.value = true;
  try {
    const res = await api.deleteRepo(d.repo.id);
    deleting.value = null;
    if (res.leftover.length) archiveError.value = `Deleted ${res.repo}, but couldn't remove: ${res.leftover.join('; ')}`;
    emit('changed');
    await loadArchived();
  } catch (e) {
    archiveError.value = (e as Error).message;
  } finally {
    deleteBusy.value = false;
  }
}

/** The repo's `network` column: a JSON array of hosts. */
function parseHosts(json: string | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}
</script>

<template>
  <Modal title="Repos" @close="$emit('close')">
    <ul v-if="repos.length" class="m-0 mb-4 flex list-none flex-col gap-2 p-0">
      <li
        v-for="r in repos"
        :key="r.id"
        class="flex flex-col gap-0.5 rounded-md border px-2.5 py-2"
        :class="open?.id === r.id ? 'border-accent' : 'border-border'"
      >
        <button class="btn-ghost flex items-baseline gap-2 text-left" @click="edit(r)">
          <span class="font-semibold">{{ r.name }}</span>
          <span v-if="r.paused_reason" class="min-w-0 truncate text-sm text-blocked" :title="r.paused_reason"
            >paused · {{ r.paused_reason }}</span
          >
          <span class="muted">base {{ r.base_branch }}<template v-if="r.auto_approve"> · auto-approve</template></span>
          <span class="muted ml-auto">{{ open?.id === r.id ? '▾' : '▸' }}</span>
        </button>
        <code class="muted truncate text-sm">{{ r.path }}</code>

        <form v-if="open?.id === r.id" class="mt-2.5 flex flex-col gap-2.5" @submit.prevent="save">
          <label class="field flex-1">
            <span>Goals <span class="muted">(the planner reads these when the queue runs dry)</span></span>
            <textarea
              class="resize-y font-mono text-sm"
              v-model="goals"
              rows="9"
              placeholder="What should this repo become? Priorities first, then anything the agents must not touch."
            />
            <small class="muted text-xs"
              >Stored in <code>{{ open.goals_path }}</code
              >, which you can also edit in any editor.</small
            >
          </label>
          <div class="flex gap-2.5">
            <label class="field flex-1">
              <span>Test command</span>
              <input v-model="testCmd" placeholder="npm test" />
            </label>
            <label class="flex flex-none items-center gap-2 self-end pb-2">
              <input type="checkbox" v-model="autoApprove" />
              Auto-approve planner tasks
            </label>
          </div>
          <label class="field flex-1">
            <span>Merge method <span class="muted">(when you merge a PR from the app)</span></span>
            <select v-model="mergeMethod">
              <option v-for="m in MERGE_METHODS" :key="m.key" :value="m.key">{{ m.label }} · {{ m.hint }}</option>
            </select>
          </label>
          <label class="flex flex-none items-center gap-2">
            <input type="checkbox" v-model="autoResolve" />
            <span
              >Resolve merge conflicts automatically
              <span class="muted"
                >(a claude run when a branch or an open PR conflicts with the base; clean merges always happen)</span
              ></span
            >
          </label>
          <label class="flex flex-none items-center gap-2">
            <input type="checkbox" v-model="sandbox" />
            <span
              >Run the agent's shell commands in the sandbox
              <span class="muted">(confined to the worktree and the hosts below; docs/adr/0001-worker-sandbox.md)</span></span
            >
          </label>
          <label v-if="sandbox" class="field flex-1">
            <span>Network hosts <span class="muted">(sandboxed commands may reach these; empty = none)</span></span>
            <input v-model="network" placeholder="registry.npmjs.org, github.com" />
          </label>
          <p v-if="open.planner_runs.length" class="muted m-0 line-clamp-2 text-sm" :title="open.planner_runs[0].note ?? ''">
            Last plan {{ ago(open.planner_runs[0].started_at) }}: {{ open.planner_runs[0].outcome ?? 'running' }}
            <template v-if="open.planner_runs[0].proposed"> · {{ open.planner_runs[0].proposed }} task(s)</template>
            <template v-if="open.planner_runs[0].note"> · {{ open.planner_runs[0].note }}</template>
          </p>
          <p v-if="editError" class="form-error">{{ editError }}</p>
          <div class="flex items-center justify-end gap-2">
            <button
              type="button"
              :disabled="!!busy"
              title="Hide the repo and its tasks and stop its work; you can undo this"
              @click="archive"
            >
              Archive
            </button>
            <span class="muted mr-auto text-sm">{{ editMsg }}</span>
            <button type="button" @click="planNow" :disabled="!!busy || !goals.trim()">
              {{ busy === 'plan' ? 'Planning…' : 'Save & plan now' }}
            </button>
            <button class="primary" type="submit" :disabled="!!busy">Save</button>
          </div>
        </form>
      </li>
    </ul>
    <p v-else class="muted">No repos yet.</p>

    <div v-if="archived.length || archiveError" class="mb-4 flex flex-col gap-2 border-t border-border pt-3.5">
      <h4 class="m-0">Archived</h4>
      <ul v-if="archived.length" class="m-0 flex list-none flex-col gap-2 p-0">
        <li v-for="r in archived" :key="r.id" class="flex flex-col gap-2 rounded-md border border-border px-2.5 py-2">
          <div class="flex items-center gap-2">
            <span class="font-semibold">{{ r.name }}</span>
            <code class="muted min-w-0 truncate text-sm">{{ r.path }}</code>
            <button class="ml-auto" @click="unarchive(r)">Unarchive</button>
            <button class="text-failed" :disabled="deleting?.repo.id === r.id" @click="askDelete(r)">Delete</button>
          </div>
          <form v-if="deleting?.repo.id === r.id" class="flex flex-col gap-2" @submit.prevent="confirmDelete">
            <p class="m-0 text-sm">
              Delete <b>{{ r.name }}</b> for good? This removes {{ deleting.counts.tasks }} task(s), {{ deleting.counts.runs }} run(s) and
              {{ deleting.counts.worktrees }} worktree(s) with their local branches, logs and goals file. GitHub and the repo's own folder
              are not touched.
            </p>
            <label class="field">
              <span
                >Type <code>{{ r.name }}</code> to confirm</span
              >
              <input v-model="typed" autocomplete="off" />
            </label>
            <div class="flex justify-end gap-2">
              <button type="button" @click="deleting = null">Cancel</button>
              <button class="text-failed" type="submit" :disabled="deleteBusy || typed !== r.name">Delete {{ r.name }}</button>
            </div>
          </form>
        </li>
      </ul>
      <p v-if="archiveError" class="form-error">{{ archiveError }}</p>
    </div>

    <form class="flex flex-col gap-2.5 border-t border-border pt-3.5" @submit.prevent="add">
      <h4 class="m-0">Add a repo</h4>
      <label class="field flex-1">
        Path to a local git repo
        <input v-model="path" placeholder="~/Documents/Dev/myproject" />
      </label>
      <div class="flex gap-2.5">
        <label class="field flex-1">
          <span>Name <span class="muted">(optional)</span></span>
          <input v-model="name" />
        </label>
        <label class="field flex-1">
          <span>Test command <span class="muted">(run after each task)</span></span>
          <input v-model="test" placeholder="npm test" />
        </label>
      </div>
      <p v-if="error" class="form-error">{{ error }}</p>
      <div class="flex items-center justify-end gap-2">
        <button class="primary" type="submit" :disabled="saving || !path.trim()">Add repo</button>
      </div>
    </form>
  </Modal>
</template>
