<script setup lang="ts">
import {
  type CallItem,
  type Item,
  type ToolKind,
  TOOL_ICONS,
  firstLine,
  offsetLabel,
  outputParts,
  pending,
  readRange,
  resultHidden,
  toolKind,
} from '../../lib/runs/transcript';
import { parseAnsi } from '../../lib/runs/ansi';
import { CHANGE_MAX } from '../../../../daemon/src/domain/runs/index.ts';
import { lineDiff } from '../../lib/runs/line-diff';
import { callDuration, durationLabel, isSlow } from '../../lib/runs/log-filter';
import Markdown from '../ui/Markdown.vue';
import Delta from '../ui/status/Delta.vue';
import LogItem from './LogItem.vue';

// One transcript item and, under a subagent call, its own items.
const props = defineProps<{
  items: Item[];
  first?: string;
  live: boolean;
  /** Keys of the items that are failures, which the failure jump finds by `data-failure`. */
  failures?: Set<string>;
  repoPath: (file: string | undefined) => string | null;
  isPath?: (p: string) => boolean;
  /** Cuts the worktree's root from an output; absent when the worktree is gone. */
  cut?: (text: string) => string;
}>();
const emit = defineEmits<{ file: [path: string]; path: [path: string, line: number | null] }>();

const ANSI = ['#6e7681', 'var(--failed)', 'var(--done)', '#d29922', 'var(--running)', '#bc8cff', '#39c5cf', 'inherit'];
const gutter = (at: string | undefined) => offsetLabel(props.first, at);
const isSubagent = (c: CallItem) => c.call.name === 'Task' || c.call.name === 'Agent';
const TONE: Record<ToolKind, string> = {
  read: 'text-tool-read',
  edit: 'text-tool-edit',
  command: 'text-tool-cmd',
  agent: 'text-muted',
  other: 'text-muted',
};
// An edit's diff: shared lines as context, with no file line numbers (the log has none).
const DIFF_SIGN = { ctx: ' ', del: '−', add: '+' } as const;
const DIFF_TONE = { ctx: 'text-muted', del: 'text-failed', add: 'text-done' } as const;
const cutText = (t: string) => (props.cut ? props.cut(t) : t);
const parts = (c: CallItem) =>
  outputParts(cutText(c.result!.output), {
    grep: c.call.name === 'Grep' ? c.call.input : undefined,
    file: props.repoPath(c.call.file),
    isPath: props.isPath,
  });
</script>

<template>
  <div
    v-for="item in items"
    :key="item.key"
    :data-at="item.at"
    :data-failure="failures?.has(item.key) || undefined"
    class="flex gap-2 px-3.5 py-[3px]"
  >
    <span class="w-9 flex-none text-right text-xs text-muted tabular-nums select-none">{{ gutter(item.at) }}</span>
    <div class="min-w-0 flex-1">
      <!-- claude's text -->
      <Markdown
        v-if="item.type === 'plain' && item.entry.kind === 'text'"
        class="text-text"
        :text="item.entry.text"
        :is-path="isPath"
        @path="(p, l) => emit('path', p, l)"
      />

      <!-- a run of reads -->
      <details v-else-if="item.type === 'explored'">
        <summary class="disclose text-sm text-muted">
          <span class="chev">›</span> <b class="font-semibold text-tool-read">{{ TOOL_ICONS.read }}</b> Explored
          {{ item.calls.length }} files
        </summary>
        <LogItem
          :items="item.calls"
          :first="first"
          :live="live"
          :failures="failures"
          :repo-path="repoPath"
          :is-path="isPath"
          :cut="cut"
          @file="(p) => emit('file', p)"
          @path="(p, l) => emit('path', p, l)"
        />
      </details>

      <!-- a tool call and what came back -->
      <template v-else-if="item.type === 'call'">
        <code class="flex items-baseline gap-1.5 text-sm text-muted">
          <span
            v-if="pending(item, live)"
            class="inline-block size-2.5 flex-none animate-spin rounded-full border border-running border-t-transparent"
          />
          <b v-else class="font-semibold" :class="item.result && !item.result.ok ? 'text-failed' : TONE[toolKind(item.call.name)]">{{
            TOOL_ICONS[toolKind(item.call.name)]
          }}</b>
          <b class="font-semibold text-text">{{ item.call.name }}</b>
          <button
            v-if="repoPath(item.call.file)"
            class="btn-ghost flex-none text-text underline"
            :title="`Open ${repoPath(item.call.file)}`"
            @click="emit('file', repoPath(item.call.file)!)"
          >
            {{ repoPath(item.call.file) }}
          </button>
          <span class="truncate">{{ repoPath(item.call.file) ? '' : item.call.summary || item.call.input }}</span>
          <Delta v-if="item.call.change" class="text-xs" :add="item.call.change.added" :del="item.call.change.removed" />
          <span
            v-if="callDuration(item) !== null"
            class="ml-auto flex-none text-xs tabular-nums"
            :class="isSlow(callDuration(item)) ? 'font-semibold text-blocked' : 'text-muted'"
            :title="isSlow(callDuration(item)) ? 'A slow call: over a minute' : 'How long the call took'"
            >{{ isSlow(callDuration(item)) ? '⏱ ' : '' }}{{ durationLabel(callDuration(item)!) }}</span
          >
        </code>
        <details v-if="item.call.change" class="ml-4">
          <summary class="disclose text-sm text-muted"><span class="chev">›</span> diff</summary>
          <pre
            class="my-1 max-h-65 overflow-auto text-sm [tab-size:4]"
          ><template v-for="(l, i) in lineDiff(item.call.change)" :key="i"><span
            v-if="l.type === 'cut'"
            class="block text-muted italic"
            :title="`The log keeps the first ${CHANGE_MAX} characters of each text`"
          >⋯ the log cut the {{ l.side }} text here</span><span
            v-else
            class="block whitespace-pre"
            :class="DIFF_TONE[l.type]"
          >{{ DIFF_SIGN[l.type] }} {{ l.text }}</span></template></pre>
        </details>
        <div v-if="item.result && !resultHidden(item)" class="ml-4 text-sm" :class="item.result.ok ? 'text-muted' : 'text-failed'">
          <details v-if="item.result.lines > 1" :open="!item.result.ok">
            <summary class="disclose truncate">
              <span class="chev">›</span>
              <span v-if="readRange(item)">{{ readRange(item) }}</span>
              <template v-else>
                <span class="when-closed">{{ firstLine(cutText(item.result.output)) }}</span> · {{ item.result.lines }} lines
              </template>
            </summary>
            <pre class="my-1 max-h-65 overflow-auto whitespace-pre [tab-size:4]"><template v-for="(p, i) in parts(item)" :key="i"><button
              v-if="p.path"
              class="btn-ghost text-accent underline"
              :title="`Open ${p.path}`"
              @click="emit('path', p.path, p.line ?? null)"
            >{{ p.text }}</button><span v-else :class="p.conflict ? 'text-blocked' : undefined">{{ p.text }}</span></template></pre>
          </details>
          <div v-else class="truncate">{{ readRange(item) || firstLine(cutText(item.result.output)) || '(no output)' }}</div>
        </div>
        <details v-if="item.children.length" class="ml-4 border-l border-border pl-2" open>
          <summary class="disclose text-sm text-muted">
            <span class="chev">›</span> {{ isSubagent(item) ? 'Subagent' : 'Nested' }} · {{ item.children.length }} steps
          </summary>
          <LogItem
            :items="item.children"
            :first="first"
            :live="live"
            :failures="failures"
            :repo-path="repoPath"
            :is-path="isPath"
            :cut="cut"
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
          <summary class="disclose" :class="item.entry.passed ? 'text-done' : 'text-failed'">
            <span class="chev">›</span>
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
