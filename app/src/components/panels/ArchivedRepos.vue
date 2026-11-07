<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { type Repo, type RepoDeletion, api, archivedReposQuery, queryKeys, repoDeletionQuery } from '../../api';
import { useActions } from '../../composables/useActions';
import { errorMessage, plural } from '../../../../daemon/src/domain/shared/text.ts';

// The archived repos, to unarchive or delete for good.
const { run } = useActions();
const queryClient = useQueryClient();

// A write's refresh refetches the list; the others on screen are read on request.
const archivedQ = useQuery(archivedReposQuery());
const archived = computed<Repo[]>(() => archivedQ.data.value ?? []);
const actionError = ref('');
const archiveError = computed(() => actionError.value || archivedQ.error.value?.message || '');
const deleting = ref<{ repo: Repo; counts: RepoDeletion } | null>(null);
const typed = ref('');
const deleteBusy = ref(false);

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
    actionError.value = errorMessage(e);
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
  <div v-if="archived.length || archiveError" class="mb-4 flex flex-col gap-2 border-t border-border pt-3.5">
    <h4 class="m-0">Archived</h4>
    <ul v-if="archived.length" class="m-0 flex list-none flex-col gap-2 p-0">
      <li v-for="r in archived" :key="r.id" class="flex flex-col gap-2 rounded-md border border-border px-2.5 py-2">
        <div class="flex items-center gap-2">
          <span class="font-semibold">{{ r.name }}</span>
          <code class="text-muted min-w-0 truncate text-sm">{{ r.path }}</code>
          <button class="ml-auto" @click="unarchive(r)">Unarchive</button>
          <button class="text-failed" :disabled="deleting?.repo.id === r.id" @click="askDelete(r)">Delete</button>
        </div>
        <form v-if="deleting?.repo.id === r.id" class="flex flex-col gap-2" @submit.prevent="confirmDelete">
          <p class="m-0 text-sm">
            Delete <b>{{ r.name }}</b> for good? This removes {{ plural(deleting.counts.tasks, 'task') }},
            {{ plural(deleting.counts.runs, 'run') }} and {{ plural(deleting.counts.worktrees, 'worktree') }} with their local branches,
            logs and goals file. GitHub and the repo's own folder are not touched.
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
</template>
