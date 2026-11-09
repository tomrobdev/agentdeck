<script setup lang="ts">
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { isOffline, refreshAll } from './api/http';
import { liveStatusQuery } from './api/operations';
import { tasksQuery } from './api/work';
import AppHeader from './components/layout/AppHeader.vue';
import OfflineScreen from './components/layout/OfflineScreen.vue';
import Overlays from './components/layout/Overlays.vue';
import StatusBar from './components/layout/StatusBar.vue';
import AppProvider from './components/ui/AppProvider.vue';
import { provideActions } from './composables/shared/useActions';
import { useAppLinks } from './composables/shared/useAppLinks';
import { useChangeStream } from './composables/shared/useChangeStream';
import { usePause } from './composables/shared/usePause';
import { useToasts } from './composables/shared/useToasts';
import { provideApprovals } from './composables/work/useApprovals';
import InsightsPage from './pages/InsightsPage.vue';
import QueuePage from './pages/QueuePage.vue';
import TaskPage from './pages/TaskPage.vue';
import { route } from './router';

// The frame: providers, header, the page the route names, status bar and overlays. Each page reads its own queries.
const statusQ = useQuery(liveStatusQuery());
// The change stream refetches what is on screen; status also refetches on a timer (liveStatusQuery).
useChangeStream();
useAppLinks();
// The status bar's activity list is built from the task list, which every page reads.
const tasksQ = useQuery(tasksQuery());
const offline = computed(() => isOffline(statusQ.error.value));

// After a change any of it may have moved (the Repos panel adds, archives and edits repos too).
const queryClient = useQueryClient();
const actions = provideActions(() => refreshAll(queryClient), useToasts().flash);
// Every way to approve goes through this gate; Overlays shows its dialog.
provideApprovals(queryClient, actions);
const { status, pausing, togglePause } = usePause(actions);
</script>

<template>
  <AppProvider>
    <div class="flex h-screen flex-col">
      <AppHeader :status="status" :offline="offline" />
      <OfflineScreen v-if="offline" @started="() => void statusQ.refetch()" />
      <TaskPage v-else-if="route.current.name === 'task'" :id="route.current.id" :tab="route.current.tab" :query="route.current.query" />
      <InsightsPage v-else-if="route.current.name === 'insights'" />
      <QueuePage v-else />
      <StatusBar :status="status" :tasks="tasksQ.data.value ?? []" :offline="offline" :busy="pausing" @toggle="togglePause" />
      <Overlays />
    </div>
  </AppProvider>
</template>
