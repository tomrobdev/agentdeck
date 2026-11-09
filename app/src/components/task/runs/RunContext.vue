<script setup lang="ts">
import { plural } from '../../../../../daemon/src/domain/shared/index.ts';
import type { PromptEntry, TouchedFile } from '../../../lib/runs/context';
import Delta from '../../ui/Delta.vue';

// The top of a run's log: what each claude of the run was told, and the files its edits touched.
defineProps<{
  prompts: PromptEntry[];
  touched: TouchedFile[];
  repoPath: (file: string | undefined) => string | null;
}>();
const emit = defineEmits<{ file: [path: string] }>();
</script>

<template>
  <div v-if="prompts.length || touched.length" class="mx-3.5 mb-2 flex flex-col gap-1 border-b border-border pb-2 text-sm">
    <details v-for="(p, i) in prompts" :key="i" data-testid="run-prompt">
      <summary class="disclose text-muted">
        <span class="chev">›</span> <b class="font-semibold text-text">What this run was told</b>
        <template v-if="p.resume"> · resumed its session</template>
        <template v-else-if="i > 0"> · started afresh</template>
        · {{ plural(p.lines, 'line') }}<template v-if="p.note"> · with a note</template>
      </summary>
      <div class="mt-1 ml-4 flex flex-col gap-1.5">
        <div v-if="p.note" class="rounded border border-border bg-panel px-2.5 py-1.5" data-testid="run-prompt-note">
          <div class="text-xs text-muted">The retry's note</div>
          <p class="whitespace-pre-wrap text-text">{{ p.note }}</p>
        </div>
        <pre class="max-h-80 overflow-auto whitespace-pre-wrap text-muted">{{ p.text }}</pre>
      </div>
    </details>
    <details v-if="touched.length">
      <summary class="disclose text-muted">
        <span class="chev">›</span> <b class="font-semibold text-text">Files this run touched</b> · {{ touched.length }}
      </summary>
      <ul class="mt-1 ml-4 flex flex-col">
        <li v-for="f in touched" :key="f.file" class="flex items-baseline gap-2">
          <button
            v-if="repoPath(f.file)"
            class="btn-ghost truncate text-text underline"
            :title="`Open ${repoPath(f.file)}`"
            @click="emit('file', repoPath(f.file)!)"
          >
            {{ repoPath(f.file) }}
          </button>
          <span v-else class="truncate text-muted">{{ f.file }}</span>
          <span
            class="flex-none text-xs"
            :title="`Lines of the edited text over ${plural(f.calls, 'call')}, not git's count of the file's changes`"
          >
            <Delta :add="f.added" :del="f.removed" />
          </span>
        </li>
      </ul>
    </details>
  </div>
</template>
