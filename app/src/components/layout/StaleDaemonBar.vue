<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../../api/client';
import { describeStaleDaemon } from '../../lib/operations/daemon-wording';
import type { Status } from '../../api/types';
import { appCommit } from '../../platform/build';
import { useActions } from '../../composables/shared/useActions';

// Shown when the dashboard and the daemon run different commits, so a missing field is explained, not mysterious.
const props = defineProps<{ status: Status | null }>();
const { run } = useActions();

const message = computed(() => describeStaleDaemon(props.status, appCommit.value));
const waiting = ref<string | null>(null);
const asked = ref(false);

// The restarted daemon reports the new commit, which clears the banner; forget the request then.
watch(message, (m) => {
  if (!m) asked.value = false;
});

async function restart() {
  await run(async () => {
    const res = await api.restartDaemon();
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
