<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { type Status, api, describeStaleDaemon } from '../api';
import { appCommit } from '../build';

// Shown when the dashboard and the daemon run different commits, so a missing field is explained, not mysterious.
const props = defineProps<{ status: Status | null }>();
const emit = defineEmits<{ error: [message: string] }>();

const message = computed(() => describeStaleDaemon(props.status, appCommit.value));
const waiting = ref<string | null>(null);
const asked = ref(false);

// The restarted daemon reports the new commit, which clears the banner; forget the request then.
watch(message, (m) => {
  if (!m) asked.value = false;
});

async function restart() {
  try {
    const res = await api.restartDaemon();
    asked.value = true;
    waiting.value = res.waiting;
  } catch (e) {
    emit('error', (e as Error).message);
  }
}
</script>

<template>
  <div v-if="message" class="stale s-blocked" role="status">
    <span class="what">{{ asked && waiting ? `Waiting for ${waiting} to finish, then the daemon restarts.` : message }}</span>
    <button class="primary" :disabled="asked" @click="restart">{{ asked ? (waiting ? 'Waiting…' : 'Restarting…') : 'Restart' }}</button>
  </div>
</template>

<style scoped>
.stale {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 24px 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
  background: color-mix(in srgb, var(--c) 9%, var(--panel));
}
.what {
  flex: 1;
}
</style>
