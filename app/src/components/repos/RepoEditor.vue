<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { repoQuery, reposApi } from '../../api/repos';
import { MODEL_LABELS } from '../../lib/runs/run-wording';
import { ago } from '../../lib/shared/time';
import { MERGE_METHODS, type Repo } from '../../api/types';
import { type RepoForm, modelChoices, toRepoForm, toRepoPatch } from '../../lib/shared/forms';
import { useActions } from '../../composables/shared/useActions';
import { plural } from '../../../../daemon/src/domain/shared/index.ts';
import NumberInput from '../ui/form/NumberInput.vue';
import Switch from '../ui/form/Switch.vue';

// One repo's editor. Mounted with :key="repo.id", so every answer it waits for is this repo's, and
// switching repos mid-request never shows or overwrites another one.
const props = defineProps<{ repo: Repo }>();
const emit = defineEmits<{ archived: [] }>();
const { run } = useActions();
const queryClient = useQueryClient();
const id = props.repo.id;

const q = useQuery(repoQuery(id));
const detail = computed(() => q.data.value);
const lastPlannerRun = computed(() => detail.value?.planner_runs[0]);
// What the saved repo runs with, which the form's edits change only once saved.
const toolsInUse = computed(() => {
  const d = detail.value;
  if (!d?.tools_source) return '';
  return d.tools_source === 'own'
    ? 'In use: the repo’s own rules.'
    : `In use: the defaults plus the rules detected from its toolchain (${d.toolchain ?? 'none found'}).`;
});

// Copied into the form once, from the read made on opening; later refetches leave the edits alone.
const form = ref<RepoForm | null>(null);
watch(
  () => (q.isFetchedAfterMount.value && !q.error.value ? q.data.value : undefined),
  (d) => {
    if (d && !form.value) form.value = toRepoForm(d);
  },
  { immediate: true },
);

const actionError = ref('');
const error = computed(() => actionError.value || q.error.value?.message || '');
const msg = ref('');
const busy = ref<'' | 'save' | 'propose'>('');

async function save(): Promise<boolean> {
  if (!form.value) return false;
  const f = form.value;
  actionError.value = msg.value = '';
  busy.value = 'save';
  const ok = await run(async () => queryClient.setQueryData(repoQuery(id).queryKey, await reposApi.updateRepo(id, toRepoPatch(f))));
  busy.value = '';
  if (ok) msg.value = 'Saved';
  return ok;
}

async function proposeNow() {
  if (!form.value || !(await save())) return;
  const autoApprove = form.value.autoApprove;
  busy.value = 'propose';
  msg.value = 'Proposing tasks… this reads the repo and can take a minute.';
  const ok = await run(async () => {
    const res = await reposApi.propose(id);
    msg.value =
      res.outcome === 'proposed'
        ? `${plural(res.tasks.length, 'task')} ${autoApprove ? 'queued' : 'proposed: approve them under Needs you'}.`
        : res.outcome === 'nothing'
          ? `Nothing to propose${res.note ? `: ${res.note}` : '.'}`
          : `Planner ${res.outcome}${res.note ? `: ${res.note}` : ''}`;
  });
  if (!ok) msg.value = '';
  busy.value = '';
}

async function archive() {
  actionError.value = '';
  if (await run(() => reposApi.archiveRepo(id))) emit('archived');
}
</script>

<template>
  <form v-if="form && detail" class="mt-2.5 flex flex-col gap-2.5" @submit.prevent="save">
    <label class="field flex-1">
      <span>Goals <span class="text-muted">(the planner reads these when the queue runs dry)</span></span>
      <textarea
        class="resize-y font-mono text-sm"
        v-model="form.goals"
        rows="9"
        placeholder="What should this repo become? Priorities first, then anything the agents must not touch."
      />
      <small class="text-muted text-xs"
        >Stored in <code>{{ detail.goals_path }}</code
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
    <div class="flex gap-2.5">
      <label class="field flex-1">
        <span>Merge method <span class="text-muted">(when you merge a PR from the app)</span></span>
        <select v-model="form.mergeMethod">
          <option v-for="m in MERGE_METHODS" :key="m.key" :value="m.key">{{ m.label }} · {{ m.hint }}</option>
        </select>
      </label>
      <label class="field flex-1">
        <span>Model <span class="text-muted">(for a new task that names none)</span></span>
        <select v-model="form.model">
          <option value="">The default model setting</option>
          <option v-for="m in modelChoices(form.model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
        </select>
      </label>
    </div>
    <Switch v-model="form.autoResolve" class="flex-none">
      <span
        >Resolve merge conflicts automatically
        <span class="text-muted">(a claude run when a branch or an open PR conflicts with the base; clean merges always happen)</span></span
      >
    </Switch>
    <Switch v-model="form.autoUnblock" class="flex-none">
      <span
        >Unblock runs
        <span class="text-muted"
          >(a short claude run when a task blocks: it retries with a note, or asks you a question with options)</span
        ></span
      >
    </Switch>
    <Switch v-model="form.autoMerge" class="flex-none">
      <span
        >Merge PRs automatically
        <span class="text-muted">(once tests and checks pass; planner proposals only when you approve them; turn off per task)</span></span
      >
    </Switch>
    <div v-if="form.autoMerge" class="flex gap-3">
      <label class="field w-28 flex-none">
        <span>Max lines</span>
        <NumberInput v-model="form.autoMergeMaxLines" />
      </label>
      <label class="field flex-1">
        <span>Paths that need you <span class="text-muted">(prefixes)</span></span>
        <input v-model="form.autoMergeSkip" placeholder=".github/, db/schema.ts" />
      </label>
    </div>
    <Switch v-model="form.sandbox" class="flex-none">
      <span
        >Run the agent's shell commands in the sandbox
        <span class="text-muted">(confined to the worktree and the hosts below; docs/adr/0001-worker-sandbox.md)</span></span
      >
    </Switch>
    <label v-if="form.sandbox" class="field flex-1">
      <span>Network hosts <span class="text-muted">(sandboxed commands may reach these; empty = none)</span></span>
      <input v-model="form.network" placeholder="registry.npmjs.org, github.com" />
    </label>
    <label class="field flex-1">
      <span>Tool rules <span class="text-muted">(one per line; they replace the detected rules, and empty goes back to them)</span></span>
      <textarea
        class="resize-y font-mono text-sm"
        v-model="form.tools"
        rows="3"
        placeholder="Read&#10;Edit&#10;Bash(make *)"
        data-testid="repo-tools"
      />
      <small class="text-muted text-xs">{{ toolsInUse }}</small>
    </label>
    <p v-if="lastPlannerRun" class="text-muted m-0 line-clamp-2 text-sm" :title="lastPlannerRun.note ?? ''">
      Last proposals {{ ago(lastPlannerRun.started_at) }}: {{ lastPlannerRun.outcome ?? 'running' }}
      <template v-if="lastPlannerRun.proposed"> · {{ plural(lastPlannerRun.proposed, 'task') }}</template>
      <template v-if="lastPlannerRun.note"> · {{ lastPlannerRun.note }}</template>
    </p>
    <p v-if="error" class="form-error">{{ error }}</p>
    <div class="flex items-center justify-end gap-2">
      <button type="button" :disabled="!!busy" title="Hide the repo and its tasks and stop its work; you can undo this" @click="archive">
        Archive
      </button>
      <span class="text-muted mr-auto text-sm">{{ msg }}</span>
      <button type="button" @click="proposeNow" :disabled="!!busy || !form.goals.trim()">
        {{ busy === 'propose' ? 'Proposing…' : 'Save & propose tasks' }}
      </button>
      <button class="primary" type="submit" :disabled="!!busy">Save</button>
    </div>
  </form>
  <p v-else-if="error" class="form-error mt-2.5">{{ error }}</p>
</template>
