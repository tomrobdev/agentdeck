<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { archivedReposQuery } from '#api/repos.ts';
import type { Repo } from '#api/types.ts';
import type { RepoId } from '#daemon/domain/shared/index.ts';
import Modal from '#components/ui/Modal.vue';
import AddRepoForm from '#components/repos/AddRepoForm.vue';
import ArchivedRepos from '#components/repos/ArchivedRepos.vue';
import RepoEditor from '#components/repos/RepoEditor.vue';

type Choice = { kind: 'repo'; id: RepoId } | { kind: 'add' } | { kind: 'archived' };
type Pane = { kind: 'repo'; repo: Repo } | { kind: 'add' } | { kind: 'archived' };

const props = defineProps<{ repos: Repo[] }>();
defineEmits<{ close: [] }>();

const archivedQ = useQuery(archivedReposQuery());
const archivedCount = computed(() => archivedQ.data.value?.length ?? 0);

const chosen = ref<Choice | null>(null);
const pane = computed<Pane>(() => {
  const c = chosen.value;
  if (c && c.kind !== 'repo') return c;
  const repo = (c && props.repos.find((r) => r.id === c.id)) ?? props.repos[0];
  return repo ? { kind: 'repo', repo } : { kind: 'add' };
});
const openId = computed(() => (pane.value.kind === 'repo' ? pane.value.repo.id : null));
const current = (on: boolean) => (on ? 'true' : undefined);
</script>

<template>
  <Modal title="Repos" size="xl" :scroll="false" @close="$emit('close')">
    <div class="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r border-border">
        <nav aria-label="Repos" class="min-h-0 flex-1 overflow-auto p-2">
          <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
            <li v-for="r in repos" :key="r.id">
              <button
                type="button"
                class="side-nav-item"
                :aria-current="current(openId === r.id)"
                @click="chosen = { kind: 'repo', id: r.id }"
              >
                <span class="flex w-full items-center gap-2">
                  <span
                    class="size-2 flex-none rounded-full"
                    :class="r.paused_reason ? 'bg-blocked' : 'bg-done'"
                    :title="r.paused_reason ? 'Paused' : 'Active'"
                  />
                  <span class="min-w-0 truncate font-semibold">{{ r.name }}</span>
                </span>
                <span class="text-muted pl-4 text-xs">{{ r.paused_reason ? 'paused · ' : '' }}base {{ r.base_branch }}</span>
              </button>
            </li>
          </ul>
          <p v-if="!repos.length" class="text-muted m-0 px-2.5 py-2 text-sm">No repos yet.</p>
          <div v-if="archivedCount" class="mt-2 border-t border-border pt-2">
            <button
              type="button"
              class="side-nav-item"
              :aria-current="current(pane.kind === 'archived')"
              @click="chosen = { kind: 'archived' }"
            >
              <span
                >Archived <span class="text-muted">· {{ archivedCount }}</span></span
              >
            </button>
          </div>
        </nav>
        <div class="pane-footer px-2">
          <button type="button" class="side-nav-item" :aria-current="current(pane.kind === 'add')" @click="chosen = { kind: 'add' }">
            + Add a repo
          </button>
        </div>
      </aside>

      <section class="flex min-h-0 flex-col">
        <RepoEditor v-if="pane.kind === 'repo'" :key="pane.repo.id" :repo="pane.repo" @archived="chosen = null" />
        <AddRepoForm v-else-if="pane.kind === 'add'" @added="(repo) => (chosen = { kind: 'repo', id: repo.id })" />
        <ArchivedRepos v-else />
      </section>
    </div>
  </Modal>
</template>
