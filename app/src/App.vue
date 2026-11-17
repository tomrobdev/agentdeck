<script setup lang="ts">
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { RouterView } from 'vue-router';
import { isOffline } from '#api/api-error.ts';
import { refreshAll } from '#api/http.ts';
import { liveStatusQuery } from '#api/operations.ts';
import { tasksQuery } from '#api/work.ts';
import AppHeader from '#components/layout/AppHeader.vue';
import OfflineScreen from '#components/layout/OfflineScreen.vue';
import Overlays from '#components/layout/Overlays.vue';
import StatusBar from '#components/layout/StatusBar.vue';
import AppProvider from '#components/ui/AppProvider.vue';
import { provideActions } from '#composables/shared/useActions.ts';
import { useAppLinks } from '#composables/shared/useAppLinks.ts';
import { useChangeStream } from '#composables/shared/useChangeStream.ts';
import { usePause } from '#composables/shared/usePause.ts';
import { useToasts } from '#composables/shared/useToasts.ts';
import { provideApprovals } from '#composables/work/useApprovals.ts';

const statusQ = useQuery(liveStatusQuery());
useChangeStream();
useAppLinks();
const tasksQ = useQuery(tasksQuery());
const offline = computed(() => isOffline(statusQ.error.value));

const queryClient = useQueryClient();
const actions = provideActions(() => refreshAll(queryClient), useToasts().flash);
provideApprovals(queryClient, actions);
const { status, pausing, togglePause } = usePause(actions);
</script>

<template>
  <AppProvider>
    <div class="flex h-screen flex-col">
      <AppHeader :status="status" :offline="offline" />
      <OfflineScreen v-if="offline" @started="() => void statusQ.refetch()" />
      <RouterView v-else />
      <StatusBar :status="status" :tasks="tasksQ.data.value ?? []" :offline="offline" :busy="pausing" @toggle="togglePause" />
      <Overlays />
    </div>
  </AppProvider>
</template>
