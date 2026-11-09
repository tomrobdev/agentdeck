<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useQueries } from '@tanstack/vue-query';
import { type ProposalCheck, PERSON_CALLS, api, taskQuery } from '../../api';
import { errorMessage, plural } from '../../../../daemon/src/domain/shared/index.ts';
import { proposalCheckLine } from '../../../../daemon/src/domain/work/index.ts';
import { latestVerify } from '../../../../daemon/src/domain/runs/index.ts';
import { type BulkResult, bulkMessage, summarizeBulk } from '../../lib/bulk';
import { useActions } from '../../composables/useActions';
import Checkbox from '../ui/Checkbox.vue';
import ConfirmDialog from '../ui/ConfirmDialog.vue';
import VerifyFindings from './VerifyFindings.vue';

// What to read before approving one task or many: each task with its staleness line, notes and the tasks it overlaps.
// Each prompt can be edited in place; "Save and approve" saves the edits (they show on the timeline) and then approves the
// ticked tasks. Tasks with nothing to show start ticked, and so does a lone task. One that failed stays listed with why.
// Each task shows its latest verify run's findings, and Verify starts one; the task's detail, refetched on every change,
// says when it ends.
const props = defineProps<{
  rows: { id: number; title: string; check: ProposalCheck | null }[];
  ticked: number[];
}>();
const emit = defineEmits<{ done: [results: BulkResult[] | null] }>();
const { refresh, flash } = useActions();

const on = reactive(new Set<number>(props.ticked));
const checks = reactive(new Map<number, ProposalCheck | null>(props.rows.map((r) => [r.id, r.check])));
// A prompt as saved, loaded for every row; an edit is the draft where it differs. Editing opens a textarea.
const saved = reactive(new Map<number, string>());
const drafts = reactive(new Map<number, string>());
const editing = reactive(new Set<number>());
const results = ref<BulkResult[] | null>(null);
const running = ref(false);
const details = useQueries({ queries: computed(() => props.rows.map((r) => taskQuery(r.id))) });
const verifyOf = (id: number) => {
  const runs = details.value[props.rows.findIndex((r) => r.id === id)]?.data?.runs ?? [];
  return latestVerify(runs, checks.get(id)?.staleness?.base ?? null);
};
const starting = reactive(new Set<number>());
async function startVerify(id: number) {
  starting.add(id);
  try {
    await api.verify(id);
    await details.value[props.rows.findIndex((r) => r.id === id)]?.refetch();
  } catch (e) {
    flash(errorMessage(e));
  } finally {
    starting.delete(id);
  }
}

onMounted(() =>
  props.rows.forEach((r) =>
    api.task(r.id).then(
      (t) => saved.set(r.id, t.prompt),
      () => {}, // no prompt, no edit: the row still approves
    ),
  ),
);

const edited = (id: number) => drafts.has(id) && drafts.get(id) !== saved.get(id);
const editedIds = computed(() => props.rows.filter((r) => edited(r.id)).map((r) => r.id));
const approving = computed(() => props.rows.filter((r) => on.has(r.id)).map((r) => r.id));
const confirmLabel = computed(() => {
  if (running.value) return 'Working…';
  if (results.value) return 'Close';
  const verb = editedIds.value.length ? 'Save and approve' : 'Approve';
  return approving.value.length ? `${verb} ${approving.value.length}` : verb;
});
const lineOf = (id: number) => {
  const c = checks.get(id);
  return c ? proposalCheckLine(c) : null;
};
const why = (id: number) => results.value?.find((r) => r.id === id)?.error;
const done = (id: number) => results.value?.some((r) => r.id === id && r.error === undefined);

function startEdit(id: number) {
  if (!drafts.has(id)) drafts.set(id, saved.get(id) ?? '');
  editing.add(id);
}

async function confirm() {
  if (running.value) return;
  if (results.value) return emit('done', results.value);
  running.value = true;
  const out: BulkResult[] = [];
  const saveFailed = new Set<number>();
  try {
    // Saves first, so a task's edit is on its timeline before its approval; the edit may change what the check says.
    for (const id of editedIds.value) {
      try {
        await api.editTask(id, { prompt: drafts.get(id) });
        saved.set(id, drafts.get(id)!);
        checks.set(id, await api.proposalCheck(id).catch(() => checks.get(id) ?? null));
      } catch (e) {
        saveFailed.add(id);
        if (on.has(id)) out.push({ id, error: `not saved: ${errorMessage(e)}` });
      }
    }
    for (const id of approving.value) {
      if (saveFailed.has(id)) continue;
      try {
        await PERSON_CALLS.approve(id);
        out.push({ id });
      } catch (e) {
        out.push({ id, error: errorMessage(e) });
      }
    }
    await refresh();
  } finally {
    running.value = false;
  }
  if (out.every((r) => r.error === undefined) && !saveFailed.size) {
    flash(out.length ? bulkMessage('approve', out) : 'Saved');
    return emit('done', out);
  }
  results.value = out;
}
</script>

<template>
  <ConfirmDialog
    :title="`Approve ${plural(rows.length, 'task')}`"
    :confirm-label="confirmLabel"
    :hide-cancel="!!results"
    :busy="running"
    :confirm-disabled="!results && !approving.length && !editedIds.length"
    @cancel="emit('done', results)"
    @confirm="confirm"
  >
    <ul class="m-0 flex list-none flex-col gap-3 p-0">
      <li v-for="r in rows" :key="r.id" class="flex flex-col gap-1">
        <span class="flex items-baseline gap-2">
          <span v-if="results" class="w-4 flex-none">{{ done(r.id) ? '✓' : why(r.id) ? '✕' : '' }}</span>
          <Checkbox
            v-else
            :model-value="on.has(r.id)"
            :label="`Approve #${r.id}`"
            @update:model-value="(v) => (v ? on.add(r.id) : on.delete(r.id))"
          />
          <span class="font-mono text-muted">#{{ r.id }}</span>
          <span class="min-w-0 flex-1 truncate">{{ r.title }}</span>
          <button
            v-if="!results"
            class="btn-ghost px-2 py-0 text-sm"
            :disabled="running || starting.has(r.id) || verifyOf(r.id)?.state === 'going'"
            title="Check the prompt's claims about the code against the base: a short read-only run that uses no attempt"
            @click="startVerify(r.id)"
          >
            {{ verifyOf(r.id) && verifyOf(r.id)!.state !== 'going' ? 'Verify again' : 'Verify' }}
          </button>
          <button v-if="!results && saved.has(r.id) && !editing.has(r.id)" class="btn-ghost px-2 py-0 text-sm" @click="startEdit(r.id)">
            Edit prompt
          </button>
        </span>
        <span v-if="why(r.id)" class="pl-6 text-sm text-failed">{{ why(r.id) }}</span>
        <template v-if="checks.get(r.id)">
          <span v-if="lineOf(r.id)" class="pl-6 text-sm wrap-anywhere">{{ lineOf(r.id) }}</span>
          <span v-if="checks.get(r.id)!.staleness?.changed.length" class="pl-6 font-mono text-sm text-muted wrap-anywhere">
            changed:
            {{
              checks
                .get(r.id)!
                .staleness!.changed.map((c) => c.path)
                .join(', ')
            }}
          </span>
          <ul v-if="checks.get(r.id)!.notes.length" class="m-0 list-none pl-6 text-sm text-blocked">
            <li v-for="n in checks.get(r.id)!.notes" :key="n">{{ n }}</li>
          </ul>
          <ul v-if="checks.get(r.id)!.overlaps.length" class="m-0 list-none pl-6 text-sm">
            <li v-for="o in checks.get(r.id)!.overlaps" :key="o.id">
              <span class="font-mono text-muted">#{{ o.id }}</span> {{ o.title }}
              <span class="font-mono text-muted wrap-anywhere">({{ o.paths.join(', ') }})</span>
              <span v-if="o.linked" class="text-muted"> · linked</span>
            </li>
          </ul>
        </template>
        <VerifyFindings v-if="verifyOf(r.id)" class="pl-6" :view="verifyOf(r.id)!" />
        <textarea
          v-if="editing.has(r.id) && !results"
          class="ml-6 min-h-32 font-mono text-sm"
          spellcheck="false"
          :aria-label="`Prompt of #${r.id}`"
          :disabled="running"
          :value="drafts.get(r.id)"
          @input="drafts.set(r.id, ($event.target as HTMLTextAreaElement).value)"
        />
      </li>
    </ul>
    <p v-if="results" class="mt-3">{{ summarizeBulk('approve', results) }}</p>
  </ConfirmDialog>
</template>
