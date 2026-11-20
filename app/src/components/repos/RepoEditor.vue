<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { repoQuery, reposApi } from '#api/repos.ts';
import { MODEL_LABELS } from '#lib/runs/run-wording.ts';
import { PR_MODE_OPTIONS } from '#lib/repos/repos-wording.ts';
import { ago } from '#lib/shared/time.ts';
import { MERGE_METHODS, type Repo } from '#api/types.ts';
import { type RepoForm, modelChoices, toRepoForm, toRepoPatch } from '#lib/shared/forms.ts';
import { useActions } from '#composables/shared/useActions.ts';
import { plural } from '#daemon/domain/shared/index.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';
import SwitchRow from '#components/ui/form/SwitchRow.vue';
import NumberInput from '#components/ui/form/NumberInput.vue';
import SegmentedControl from '#components/ui/form/SegmentedControl.vue';

const props = defineProps<{ repo: Repo }>();
const emit = defineEmits<{ archived: [] }>();
const { run } = useActions();
const queryClient = useQueryClient();
const id = props.repo.id;

const q = useQuery(repoQuery(id));
const detail = computed(() => q.data.value);
const lastPlannerRun = computed(() => detail.value?.planner_runs[0]);
const toolsInUse = computed(() => {
  const d = detail.value;
  if (!d?.tools_source) return '';
  return d.tools_source === 'own'
    ? 'In use: the repo’s own rules.'
    : `In use: the defaults plus the rules detected from its toolchain (${d.toolchain ?? 'none found'}).`;
});

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

async function drain() {
  actionError.value = '';
  if (await run(() => reposApi.drainRepo(id))) msg.value = 'Draining: it pauses once the work in flight finishes';
}
</script>

<template>
  <form v-if="form && detail" class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
    <div class="pane-body">
      <header class="mb-5 flex flex-col gap-0.5">
        <h3 class="m-0 text-lg font-semibold">{{ repo.name }}</h3>
        <code class="text-muted truncate text-sm" :title="repo.path">{{ repo.path }}</code>
        <p v-if="repo.paused_reason" class="m-0 mt-1 line-clamp-2 text-sm text-blocked" :title="repo.paused_reason">
          Paused: {{ repo.paused_reason }}
        </p>
      </header>

      <div class="flex flex-col gap-8">
        <FieldSection title="Basics">
          <FieldRow label="Base branch" hint="New task worktrees start from it, and pull requests target it.">
            <input v-model="form.baseBranch" class="max-w-xs font-mono" spellcheck="false" />
          </FieldRow>
          <FieldRow label="Setup command" hint="Runs in each worktree before claude. Empty for none.">
            <textarea v-model="form.setupCmd" class="resize-y font-mono text-sm" rows="3" spellcheck="false" placeholder="npm ci" />
          </FieldRow>
          <FieldRow label="Test command" hint="Runs after each task. Empty for none.">
            <input v-model="form.testCmd" class="font-mono" spellcheck="false" placeholder="npm test" />
          </FieldRow>
          <FieldRow label="Model" hint="For a new task that names none.">
            <select v-model="form.model">
              <option value="">The default model setting</option>
              <option v-for="m in modelChoices(form.model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
            </select>
          </FieldRow>
        </FieldSection>

        <FieldSection title="Pull requests">
          <FieldRow as="div" label="Open a pull request" hint="When a task is done, push its branch and open one.">
            <SegmentedControl v-model="form.prMode" label="Open a pull request" :options="PR_MODE_OPTIONS" />
          </FieldRow>
          <FieldRow label="Merge method" hint="When a pull request is merged from the app or on its own.">
            <select v-model="form.mergeMethod">
              <option v-for="m in MERGE_METHODS" :key="m.key" :value="m.key">{{ m.label }} · {{ m.hint }}</option>
            </select>
          </FieldRow>
        </FieldSection>

        <FieldSection title="Automation">
          <SwitchRow
            v-model="form.autoApprove"
            label="Auto-approve proposals"
            hint="The planner's tasks are queued without a person approving them."
          />
          <SwitchRow
            v-model="form.autoResolve"
            label="Resolve conflicts"
            hint="A claude run when a branch or an open pull request conflicts with the base. Clean merges always happen."
          />
          <SwitchRow
            v-model="form.autoUnblock"
            label="Unblock runs"
            hint="A short run when a task blocks: it retries with a note, or asks you a question."
          />
          <SwitchRow
            v-model="form.autoReview"
            label="Review runs"
            hint="A run that reads a done task's changes against its goal and plan steps."
          />
          <SwitchRow v-model="form.autoMerge" label="Merge automatically" hint="Once tests and checks pass. Turn it off per task." />
          <template v-if="form.autoMerge">
            <FieldRow label="Most lines" hint="A pull request changing more needs you.">
              <NumberInput class="w-28" v-model="form.autoMergeMaxLines" label="Most lines" />
            </FieldRow>
            <FieldRow label="Paths that need you" hint="Path prefixes, comma-separated.">
              <input v-model="form.autoMergeSkip" class="font-mono" placeholder=".github/, db/schema.ts" />
            </FieldRow>
            <SwitchRow
              v-model="form.ciNotRunOk"
              label="Merge when CI did not run"
              hint="A check that never started, such as a billing stop, doesn't stop it when the last run passed the tests."
              data-testid="repo-ci-not-run-ok"
            />
          </template>
        </FieldSection>

        <FieldSection title="Merging">
          <FieldRow
            label="Keep both sides"
            hint="Path globs, comma-separated. A conflict in one of these in a sync keeps both sides' lines, for files every task appends to."
          >
            <input v-model="form.unionPaths" class="font-mono" placeholder="docs/review-areas.md, *.lock" data-testid="repo-union-paths" />
          </FieldRow>
          <FieldRow
            label="Generated files"
            hint="Path globs, comma-separated, of files the command below rebuilds. A sync that conflicts only in these reruns the command instead of a resolve run."
          >
            <input
              v-model="form.generatedPaths"
              class="font-mono"
              placeholder="docs/architecture.md, docs/reference/**"
              data-testid="repo-generated-paths"
            />
          </FieldRow>
          <FieldRow label="Regenerate with" hint="The command that rebuilds the generated files, run in the task's worktree.">
            <input
              v-model="form.generatedCmd"
              class="font-mono"
              spellcheck="false"
              placeholder="pnpm docs:gen"
              data-testid="repo-generated-cmd"
            />
          </FieldRow>
        </FieldSection>

        <FieldSection title="Code comments" hint="A branch over either limit is flagged. 0 turns a limit off.">
          <FieldRow label="Most lines" hint="Code comment lines a branch may add.">
            <NumberInput v-model="form.codeCommentMaxLines" class="w-28" label="Code comment lines" data-testid="repo-code-comment-lines" />
          </FieldRow>
          <FieldRow label="Largest share" hint="Of the lines a branch adds.">
            <span class="flex items-center gap-1.5"
              ><NumberInput
                v-model="form.codeCommentMaxPercent"
                class="w-28"
                label="Code comment share"
                data-testid="repo-code-comment-percent"
              />%</span
            >
          </FieldRow>
        </FieldSection>

        <FieldSection title="Sandbox and tools">
          <SwitchRow
            v-model="form.sandbox"
            label="Sandbox"
            hint="Confine the agent's shell commands to the worktree and the hosts below."
          />
          <FieldRow v-if="form.sandbox" label="Network hosts" hint="Sandboxed commands may reach these. Empty for none.">
            <input v-model="form.network" class="font-mono" placeholder="registry.npmjs.org, github.com" />
          </FieldRow>
          <FieldRow label="Tool rules" :hint="`One per line; they replace the detected rules, and empty goes back to them. ${toolsInUse}`">
            <textarea
              class="resize-y font-mono text-sm"
              v-model="form.tools"
              rows="10"
              placeholder="Read&#10;Edit&#10;Bash(make *)"
              data-testid="repo-tools"
            />
          </FieldRow>
        </FieldSection>

        <FieldSection title="Goals and planner">
          <FieldRow as="div" label="Goals">
            <template #hint
              >The planner reads these when the queue runs dry. Stored in <code class="break-all">{{ detail.goals_path }}</code
              >, which you can also edit in any editor.</template
            >
            <textarea
              class="resize-y font-mono text-sm"
              v-model="form.goals"
              aria-label="Goals"
              rows="10"
              placeholder="What should this repo become? Priorities first, then anything the agents must not touch."
            />
            <span class="flex items-center gap-2">
              <button
                type="button"
                :disabled="!!busy || !form.goals.trim()"
                :title="form.goals.trim() ? 'Save, then let the planner propose tasks now' : 'Write some goals first'"
                @click="proposeNow"
              >
                {{ busy === 'propose' ? 'Proposing…' : 'Save & propose tasks' }}
              </button>
              <small v-if="!form.goals.trim()" class="text-muted text-xs">Write some goals first.</small>
            </span>
            <small v-if="lastPlannerRun" class="text-muted line-clamp-2 text-xs" :title="lastPlannerRun.note ?? ''">
              Last proposals {{ ago(lastPlannerRun.started_at) }}: {{ lastPlannerRun.outcome ?? 'running' }}
              <template v-if="lastPlannerRun.proposed"> · {{ plural(lastPlannerRun.proposed, 'task') }}</template>
              <template v-if="lastPlannerRun.note"> · {{ lastPlannerRun.note }}</template>
            </small>
          </FieldRow>
        </FieldSection>
      </div>
    </div>

    <footer class="pane-footer">
      <button type="button" :disabled="!!busy" title="Hide the repo and its tasks and stop its work; you can undo this" @click="archive">
        Archive
      </button>
      <button
        v-if="!repo.paused_reason"
        type="button"
        :disabled="!!busy"
        title="Start none of its new tasks, finish its work in flight, then pause it and send a 'drained' notification"
        @click="drain"
      >
        Drain
      </button>
      <p v-if="error" class="form-error min-w-0 truncate" :title="error">{{ error }}</p>
      <span v-else class="text-muted min-w-0 truncate text-sm">{{ msg }}</span>
      <span class="spacer" />
      <button class="primary" type="submit" :disabled="!!busy">Save</button>
    </footer>
  </form>
  <p v-else-if="error" class="form-error pane-body">{{ error }}</p>
  <p v-else class="text-muted pane-body">Loading…</p>
</template>
