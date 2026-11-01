<script setup lang="ts">
import { type CallItem, type Item, changeLines, firstLine, offsetLabel, pending } from '../../lib/transcript';
import { parseAnsi } from '../../lib/ansi';
import Markdown from '../files/Markdown.vue';
import LogItem from './LogItem.vue';

// One transcript item and, under a subagent call, its own items.
const props = defineProps<{
  items: Item[];
  first?: string;
  live: boolean;
  repoPath: (file: string | undefined) => string | null;
  isPath?: (p: string) => boolean;
}>();
const emit = defineEmits<{ file: [path: string]; path: [path: string, line: number | null] }>();

const ANSI = ['#6e7681', 'var(--failed)', 'var(--done)', '#d29922', 'var(--running)', '#bc8cff', '#39c5cf', 'inherit'];
const gutter = (at: string | undefined) => offsetLabel(props.first, at);
const isSubagent = (c: CallItem) => c.call.name === 'Task' || c.call.name === 'Agent';
</script>

<template>
  <div v-for="item in items" :key="item.key" class="flex gap-2 px-3.5 py-[3px]">
    <span class="w-9 flex-none text-right text-xs text-muted tabular-nums select-none">{{ gutter(item.at) }}</span>
    <div class="min-w-0 flex-1">
      <!-- claude's text -->
      <Markdown
        v-if="item.type === 'plain' && item.entry.kind === 'text'"
        :text="item.entry.text"
        :is-path="isPath"
        @path="(p, l) => emit('path', p, l)"
      />

      <!-- a run of reads -->
      <details v-else-if="item.type === 'explored'">
        <summary class="cursor-pointer text-muted">
          <b class="font-semibold text-running">◦</b> Explored {{ item.calls.length }} files
        </summary>
        <LogItem
          :items="item.calls"
          :first="first"
          :live="live"
          :repo-path="repoPath"
          :is-path="isPath"
          @file="(p) => emit('file', p)"
          @path="(p, l) => emit('path', p, l)"
        />
      </details>

      <!-- a tool call and what came back -->
      <template v-else-if="item.type === 'call'">
        <code class="flex items-baseline gap-1.5 text-muted">
          <span
            v-if="pending(item, live)"
            class="inline-block size-2.5 flex-none animate-spin rounded-full border border-running border-t-transparent"
          />
          <b v-else class="font-semibold" :class="item.result && !item.result.ok ? 'text-failed' : 'text-running'">●</b>
          <b class="font-semibold text-text">{{ item.call.name }}</b>
          <button
            v-if="repoPath(item.call.file)"
            class="btn-ghost flex-none text-accent underline"
            :title="`Open ${repoPath(item.call.file)}`"
            @click="emit('file', repoPath(item.call.file)!)"
          >
            {{ repoPath(item.call.file) }}
          </button>
          <span class="truncate">{{ repoPath(item.call.file) ? '' : item.call.summary || item.call.input }}</span>
          <span v-if="item.call.change" class="flex-none text-xs"
            ><span class="text-done">+{{ item.call.change.added }}</span>
            <span class="text-failed">−{{ item.call.change.removed }}</span></span
          >
        </code>
        <details v-if="item.call.change" class="ml-4">
          <summary class="cursor-pointer text-sm text-muted">▸ diff</summary>
          <pre class="my-1 max-h-65 overflow-auto text-sm"><span
            v-for="(l, i) in changeLines(item.call.change)"
            :key="i"
            class="block whitespace-pre-wrap"
            :class="l.sign === '+' ? 'text-done' : 'text-failed'"
          >{{ l.sign }} {{ l.text }}</span></pre>
        </details>
        <div v-if="item.result" class="ml-4 text-sm" :class="item.result.ok ? 'text-muted' : 'text-failed'">
          <details v-if="item.result.lines > 1" class="group" :open="!item.result.ok">
            <summary class="cursor-pointer truncate">
              <span class="group-open:hidden">{{ firstLine(item.result.output) }}</span> ▸ {{ item.result.lines }} lines
            </summary>
            <pre class="my-1 max-h-65 overflow-auto whitespace-pre-wrap">{{ item.result.output }}</pre>
          </details>
          <div v-else class="truncate">{{ firstLine(item.result.output) || '(no output)' }}</div>
        </div>
        <details v-if="item.children.length" class="ml-4 border-l border-border pl-2" open>
          <summary class="cursor-pointer text-sm text-muted">
            {{ isSubagent(item) ? 'Subagent' : 'Nested' }} · {{ item.children.length }} steps
          </summary>
          <LogItem
            :items="item.children"
            :first="first"
            :live="live"
            :repo-path="repoPath"
            :is-path="isPath"
            @file="(p) => emit('file', p)"
            @path="(p, l) => emit('path', p, l)"
          />
        </details>
      </template>

      <!-- everything else -->
      <template v-else-if="item.type === 'plain'">
        <div v-if="item.entry.kind === 'result'" class="mt-1.5 border-t border-dashed border-border pt-1.5 text-sm text-muted">
          result: {{ item.entry.subtype }} · {{ item.entry.turns }} turns
        </div>
        <details v-else-if="item.entry.kind === 'setup' || item.entry.kind === 'tests'" :open="!item.entry.passed">
          <summary class="cursor-pointer" :class="item.entry.passed ? 'text-done' : 'text-failed'">
            <template v-if="item.entry.kind === 'setup'">Setup {{ item.entry.passed ? 'done' : 'failed' }}: {{ item.entry.cmd }}</template>
            <template v-else>Tests {{ item.entry.passed ? 'passed' : 'failed' }}</template>
          </summary>
          <pre class="my-1.5 max-h-65 overflow-auto whitespace-pre-wrap"><span
            v-for="(s, i) in parseAnsi(item.entry.output)"
            :key="i"
            :class="{ 'font-bold': s.bold }"
            :style="s.color === null ? undefined : { color: ANSI[s.color] }"
          >{{ s.text }}</span></pre>
        </details>
        <code v-else-if="item.entry.kind === 'error'" class="text-failed">{{ item.entry.text }}</code>
      </template>
    </div>
  </div>
</template>
