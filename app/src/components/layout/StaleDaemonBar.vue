<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { operationsApi } from '#api/operations.ts';
import { describeStaleDaemon } from '#lib/operations/daemon-wording.ts';
import type { Status } from '#api/types.ts';
import { appCommit } from '#platform/build.ts';
import { useActions } from '#composables/shared/useActions.ts';

const props = defineProps<{ status: Status | null }>();
const { run } = useActions();

const message = computed(() => describeStaleDaemon(props.status, appCommit.value));
const waiting = ref<string | null>(null);
const asked = ref(false);

watch(message, (m) => {
  if (!m) asked.value = false;
});

async function restart() {
  await run(async () => {
    const res = await operationsApi.restartDaemon();
    asked.value = true;
    waiting.value = res.waiting;
  });
}
</script>

<template>
  <div
    v-if="message"
    class="s-blocked mx-6 mt-3 flex items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--c)_40%,transparent)] bg-[color-mix(in_srgb,var(--c)_9%,var(--panel))] px-3 py-2"
    role="status"
  >
    <span class="flex-1">{{ asked && waiting ? `Waiting for ${waiting} to finish, then the daemon restarts.` : message }}</span>
    <button class="primary" :disabled="asked" @click="restart">{{ asked ? (waiting ? 'Waiting…' : 'Restarting…') : 'Restart' }}</button>
  </div>
</template>
