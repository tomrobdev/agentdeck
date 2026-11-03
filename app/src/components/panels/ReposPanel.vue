<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  MERGE_METHODS,
  type Repo,
  type RepoDeletion,
  type RepoDetail,
  ago,
  api,
  archivedReposQuery,
  queryKeys,
  repoDeletionQuery,
  repoQuery,
} from '../../api';
import { type RepoForm, toRepoForm, toRepoPatch } from '../../lib/forms';
import { useActions } from '../../composables/useActions';
import Accordion from '../ui/Accordion.vue';
import AccordionItem from '../ui/AccordionItem.vue';
import AccordionTrigger from '../ui/AccordionTrigger.vue';
import Modal from '../ui/Modal.vue';
import NumberInput from '../ui/NumberInput.vue';
import Switch from '../ui/Switch.vue';

const props = defineProps<{ repos: Repo[] }>();
defineEmits<{ close: [] }>();
const { run } = useActions();
const queryClient = useQueryClient();

// Add form
const path = ref('');
const name = ref('');
const test = ref('');
const saving = ref(false);

// Per-repo editor
const open = ref<RepoDetail | null>(null);
const form = ref<RepoForm | null>(null);
const editError = ref('');
const editMsg = ref('');
const busy = ref<'' | 'save' | 'propose'>('');

async function add() {
  saving.value = true;
  let repo: Repo | undefined;
  const ok = await run(async () => {
    repo = await api.addRepo({ path: path.value.trim(), name: name.value.trim() || undefined, test: test.value.trim() || undefined });
  });
  saving.value = false;
  if (!ok || !repo) return;
  path.value = name.value = test.value = '';
  await edit(repo);
}

function load(d: RepoDetail) {
  open.value = d;
  form.value = toRepoForm(d);
}

// The accordion opens one repo's editor, or closes it.
function toggle(id: string | undefined) {
  const r = id ? props.repos.find((x) => String(x.id) === id) : undefined;
  if (r) return void edit(r);
  open.value = null;
  editError.value = editMsg.value = '';
}

async function edit(r: Repo) {
  editError.value = editMsg.value = '';
  try {
    load(await queryClient.fetchQuery({ ...repoQuery(r.id), staleTime: 0 }));
  } catch (e) {
    open.value = null;
    editError.value = (e as Error).message;
  }
}

async function save(): Promise<boolean> {
  if (!open.value || !form.value) return false;
  const id = open.value.id;
  const f = form.value;
  editError.value = editMsg.value = '';
  busy.value = 'save';
  const ok = await run(async () => load(await api.updateRepo(id, toRepoPatch(f))));
  busy.value = '';
  if (ok) editMsg.value = 'Saved';
  return ok;
}

async function proposeNow() {
  if (!open.value || !form.value || !(await save())) return;
  const id = open.value.id;
  const autoApprove = form.value.autoApprove;
  busy.value = 'propose';
  editMsg.value = 'Proposing tasks… this reads the repo and can take a minute.';
  const ok = await run(async () => {
    const res = await api.propose(id);
    editMsg.value =
      res.outcome === 'proposed'
        ? `${res.tasks.length} task(s) ${autoApprove ? 'queued' : 'proposed: approve them under Needs you'}.`
        : res.outcome === 'nothing'
          ? `Nothing to propose${res.note ? `: ${res.note}` : '.'}`
          : `Planner ${res.outcome}${res.note ? `: ${res.note}` : ''}`;
    load(await queryClient.fetchQuery({ ...repoQuery(id), staleTime: 0 }));
  });
  if (!ok) editMsg.value = '';
  busy.value = '';
}

// Archived repos
// A write's refresh refetches the list; the others on screen are read on request.
const archivedQ = useQuery(archivedReposQuery());
const archived = computed<Repo[]>(() => archivedQ.data.value ?? []);
const actionError = ref('');
const archiveError = computed(() => actionError.value || archivedQ.error.value?.message || '');
const deleting = ref<{ repo: Repo; counts: RepoDeletion } | null>(null);
const typed = ref('');
const deleteBusy = ref(false);

async function archive() {
  if (!open.value) return;
  const id = open.value.id;
  actionError.value = '';
  if (!(await run(() => api.archiveRepo(id)))) return;
  open.value = null;
}

async function unarchive(r: Repo) {
  actionError.value = '';
  await run(async () => {
    await api.unarchiveRepo(r.id);
    if (deleting.value?.repo.id === r.id) deleting.value = null;
  });
}

// What a delete takes with it is counted fresh when asked, never from an earlier look.
async function askDelete(r: Repo) {
  actionError.value = '';
  typed.value = '';
  try {
    deleting.value = { repo: r, counts: await queryClient.fetchQuery({ ...repoDeletionQuery(r.id), staleTime: 0 }) };
  } catch (e) {
    actionError.value = (e as Error).message;
  }
}

async function confirmDelete() {
  const d = deleting.value;
  if (!d || typed.value !== d.repo.name) return;
  deleteBusy.value = true;
  const ok = await run(async () => {
    const res = await api.deleteRepo(d.repo.id);
    deleting.value = null;
    if (res.leftover.length) actionError.value = `Deleted ${res.repo}, but couldn't remove: ${res.leftover.join('; ')}`;
  });
  deleteBusy.value = false;
  if (ok) queryClient.removeQueries({ queryKey: queryKeys.repo(d.repo.id) });
}
</script>

<template>
  <Modal title="Repos" @close="$emit('close')">
    <p v-if="editError && !open" class="form-error">{{ editError }}</p>
    <Accordion
      v-if="repos.length"
      as="ul"
      class="m-0 mb-4 flex list-none flex-col gap-2 p-0"
      :model-value="open ? String(open.id) : undefined"
      @update:model-value="toggle"
    >
      <AccordionItem
        v-for="r in repos"
        :key="r.id"
        as="li"
        :value="String(r.id)"
        class="flex flex-col gap-0.5 rounded-md border px-2.5 py-2"
        header-class="flex flex-col gap-0.5"
        :class="open?.id === r.id ? 'border-accent' : 'border-border'"
      >
        <template #header>
          <AccordionTrigger class="btn-ghost flex items-baseline gap-2 text-left">
            <span class="font-semibold">{{ r.name }}</span>
            <span v-if="r.paused_reason" class="min-w-0 truncate text-sm text-blocked" :title="r.paused_reason"
              >paused · {{ r.paused_reason }}</span
            >
            <span class="muted">base {{ r.base_branch }}<template v-if="r.auto_approve"> · auto-approve</template></span>
            <span class="muted ml-auto">{{ open?.id === r.id ? '▾' : '▸' }}</span>
          </AccordionTrigger>
          <code class="muted truncate text-sm">{{ r.path }}</code>
        </template>

        <form v-if="open?.id === r.id && form" class="mt-2.5 flex flex-col gap-2.5" @submit.prevent="save">
          <label class="field flex-1">
            <span>Goals <span class="muted">(the planner reads these when the queue runs dry)</span></span>
            <textarea
              class="resize-y font-mono text-sm"
              v-model="form.goals"
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
              <input v-model="form.testCmd" placeholder="npm test" />
            </label>
            <Switch v-model="form.autoApprove" class="flex-none self-end pb-2">Auto-approve planner tasks</Switch>
          </div>
          <label class="field flex-1">
            <span>Merge method <span class="muted">(when you merge a PR from the app)</span></span>
            <select v-model="form.mergeMethod">
              <option v-for="m in MERGE_METHODS" :key="m.key" :value="m.key">{{ m.label }} · {{ m.hint }}</option>
            </select>
          </label>
          <Switch v-model="form.autoResolve" class="flex-none">
            <span
              >Resolve merge conflicts automatically
              <span class="muted"
                >(a claude run when a branch or an open PR conflicts with the base; clean merges always happen)</span
              ></span
            >
          </Switch>
          <Switch v-model="form.autoMerge" class="flex-none">
            <span
              >Merge PRs automatically
              <span class="muted">(once tests and checks pass; planner proposals only when you approve them; turn off per task)</span></span
            >
          </Switch>
          <div v-if="form.autoMerge" class="flex gap-3">
            <label class="field w-28 flex-none">
              <span>Max lines</span>
              <NumberInput v-model="form.autoMergeMaxLines" />
            </label>
            <label class="field flex-1">
              <span>Paths that need you <span class="muted">(prefixes)</span></span>
              <input v-model="form.autoMergeSkip" placeholder=".github/, db/schema.ts" />
            </label>
          </div>
          <Switch v-model="form.sandbox" class="flex-none">
            <span
              >Run the agent's shell commands in the sandbox
              <span class="muted">(confined to the worktree and the hosts below; docs/adr/0001-worker-sandbox.md)</span></span
            >
          </Switch>
          <label v-if="form.sandbox" class="field flex-1">
            <span>Network hosts <span class="muted">(sandboxed commands may reach these; empty = none)</span></span>
            <input v-model="form.network" placeholder="registry.npmjs.org, github.com" />
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
            <button type="button" @click="proposeNow" :disabled="!!busy || !form.goals.trim()">
              {{ busy === 'propose' ? 'Proposing…' : 'Save & propose tasks' }}
            </button>
            <button class="primary" type="submit" :disabled="!!busy">Save</button>
          </div>
        </form>
      </AccordionItem>
    </Accordion>
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
      <div class="flex items-center justify-end gap-2">
        <button class="primary" type="submit" :disabled="saving || !path.trim()">Add repo</button>
      </div>
    </form>
  </Modal>
</template>
