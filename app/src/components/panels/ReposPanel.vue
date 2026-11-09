<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Repo } from '../../api/types';
import Accordion from '../ui/disclosure/Accordion.vue';
import AccordionItem from '../ui/disclosure/AccordionItem.vue';
import AccordionTrigger from '../ui/disclosure/AccordionTrigger.vue';
import Modal from '../ui/Modal.vue';
import AddRepoForm from './AddRepoForm.vue';
import ArchivedRepos from './ArchivedRepos.vue';
import RepoEditor from './RepoEditor.vue';

const props = defineProps<{ repos: Repo[] }>();
defineEmits<{ close: [] }>();

// Which repo's editor is open; the editor reads the repo itself.
const openId = ref<number | null>(null);
const open = computed(() => props.repos.find((r) => r.id === openId.value) ?? null);

// The accordion opens one repo's editor, or closes it.
function toggle(id: string | undefined) {
  openId.value = (id && props.repos.find((x) => String(x.id) === id)?.id) || null;
}
</script>

<template>
  <Modal title="Repos" @close="$emit('close')">
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
            <span class="text-muted">base {{ r.base_branch }}<template v-if="r.auto_approve"> · auto-approve</template></span>
            <span class="text-muted ml-auto">{{ open?.id === r.id ? '▾' : '▸' }}</span>
          </AccordionTrigger>
          <code class="text-muted truncate text-sm">{{ r.path }}</code>
        </template>

        <RepoEditor v-if="open?.id === r.id" :key="r.id" :repo="r" @archived="openId = null" />
      </AccordionItem>
    </Accordion>
    <p v-else class="text-muted">No repos yet.</p>

    <ArchivedRepos />
    <AddRepoForm @added="(repo) => (openId = repo.id)" />
  </Modal>
</template>
