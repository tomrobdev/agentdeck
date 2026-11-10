<script setup lang="ts">
import { computed, ref } from 'vue';
import { type DiffLine, anchorOf, anchorKey, parsePatch, splitRows } from '../../../lib/work/files/diff';
import { highlightLines, languageFor } from '../../../lib/shared/render';
import type { NewReviewComment } from '../../../api/types';
import type { ShownComment } from '../../../composables/landing/useReviews';
import CommentBox from '../../landing/CommentBox.vue';
import CommentThread from '../../landing/CommentThread.vue';

const props = defineProps<{
  path: string;
  patch: string;
  split: boolean;
  comments?: ShownComment[];
  add?: (line: Pick<NewReviewComment, 'side' | 'line'>, body: string) => Promise<boolean>;
}>();

const hunks = computed(() => parsePatch(props.patch));

const html = computed(() => {
  const lang = languageFor(props.path);
  const oldLines: DiffLine[] = [];
  const newLines: DiffLine[] = [];
  for (const h of hunks.value)
    for (const l of h.lines) {
      if (l.type !== 'add') oldLines.push(l);
      if (l.type !== 'del') newLines.push(l);
    }
  const oldHtml = highlightLines(
    oldLines.map((l) => l.text),
    lang,
  );
  const newHtml = highlightLines(
    newLines.map((l) => l.text),
    lang,
  );
  const map = new Map<DiffLine, string>();
  oldLines.forEach((l, i) => map.set(l, oldHtml[i]));
  newLines.forEach((l, i) => map.set(l, newHtml[i]));
  return map;
});

const present = computed(() => new Set(hunks.value.flatMap((h) => h.lines.map((l) => anchorKey(anchorOf(l))))));
const byLine = computed(() => {
  const out = new Map<string, ShownComment[]>();
  for (const c of props.comments ?? []) {
    const k = anchorKey(c);
    if (present.value.has(k)) out.set(k, [...(out.get(k) ?? []), c]);
  }
  return out;
});
const outdated = computed(() => (props.comments ?? []).filter((c) => !present.value.has(anchorKey(c))));
const commentsOn = (...lines: (DiffLine | null)[]) =>
  [...new Set(lines)].flatMap((l) => (l ? (byLine.value.get(anchorKey(anchorOf(l))) ?? []) : []));

const composing = ref<string | null>(null);
const composingOn = (...lines: (DiffLine | null)[]) => lines.some((l) => l && anchorKey(anchorOf(l)) === composing.value);
const composeAt = (l: DiffLine | null) => (composing.value = l ? anchorKey(anchorOf(l)) : null);
const saveAt = (l: DiffLine | null) => (body: string) => (l ? props.add!(anchorOf(l), body) : Promise.resolve(false));
const rowLines = (r: { left: DiffLine | null; right: DiffLine | null }) => (r.left === r.right ? [r.left] : [r.left, r.right]);

const splitHunks = computed(() => hunks.value.map((h) => ({ header: h.header, rows: splitRows(h.lines) })));
</script>

<template>
  <div class="diff overflow-x-auto font-mono text-sm leading-normal" :class="{ split }">
    <div v-if="outdated.length" class="px-3 py-1.5 font-sans">
      <div class="text-sm font-medium text-muted">Outdated comments</div>
      <CommentThread v-for="c in outdated" :key="c.id" :comment="c" outdated />
    </div>
    <p v-if="!hunks.length" class="text-muted px-3.5 py-2.5 font-sans">No line changes (mode or rename only).</p>
    <table v-else-if="!split">
      <tbody v-for="(h, hi) in hunks" :key="hi">
        <tr class="hunk">
          <td class="no" colspan="2" />
          <td class="code">{{ h.header }}</td>
        </tr>
        <template v-for="(l, i) in h.lines" :key="i">
          <tr :class="l.type">
            <td class="no">
              <button v-if="add" class="plus" title="Comment on this line" @click="composeAt(l)">+</button>{{ l.old ?? '' }}
            </td>
            <td class="no">{{ l.new ?? '' }}</td>
            <td class="code">
              <span class="sign">{{ l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ' }}</span
              ><span v-html="html.get(l)" />
            </td>
          </tr>
          <tr v-if="commentsOn(l).length || composingOn(l)" class="thread">
            <td colspan="3">
              <CommentThread v-for="c in commentsOn(l)" :key="c.id" :comment="c" />
              <CommentBox v-if="composingOn(l)" :save="saveAt(l)" @close="composing = null" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <table v-else>
      <colgroup>
        <col class="no-col" />
        <col />
        <col class="no-col" />
        <col />
      </colgroup>
      <tbody v-for="(h, hi) in splitHunks" :key="hi">
        <tr class="hunk">
          <td class="no" />
          <td class="code" colspan="3">{{ h.header }}</td>
        </tr>
        <template v-for="(r, i) in h.rows" :key="i">
          <tr>
            <td class="no" :class="r.left?.type">
              <button v-if="add && r.left" class="plus" title="Comment on this line" @click="composeAt(r.left)">+</button
              >{{ r.left?.old ?? '' }}
            </td>
            <td class="code half" :class="r.left ? r.left.type : 'blank'"><span v-if="r.left" v-html="html.get(r.left)" /></td>
            <td class="no" :class="r.right?.type">
              <button v-if="add && r.right" class="plus" title="Comment on this line" @click="composeAt(r.right)">+</button
              >{{ r.right?.new ?? '' }}
            </td>
            <td class="code half" :class="r.right ? r.right.type : 'blank'"><span v-if="r.right" v-html="html.get(r.right)" /></td>
          </tr>
          <tr v-if="commentsOn(...rowLines(r)).length || composingOn(...rowLines(r))" class="thread">
            <td colspan="4">
              <CommentThread v-for="c in commentsOn(...rowLines(r))" :key="c.id" :comment="c" />
              <template v-for="l in rowLines(r)" :key="l ? anchorKey(anchorOf(l)) : 'none'">
                <CommentBox v-if="l && composingOn(l)" :save="saveAt(l)" @close="composing = null" />
              </template>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
table {
  border-collapse: collapse;
  width: 100%;
}
.split table {
  table-layout: fixed;
}
td {
  padding: 0 8px;
  vertical-align: top;
}
.no {
  width: 1%;
  min-width: 42px;
  text-align: right;
  color: var(--muted);
  user-select: none;
  white-space: nowrap;
}
.no-col {
  width: 64px;
}
.code {
  white-space: pre;
}
.split .code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sign {
  display: inline-block;
  width: 14px;
  color: var(--muted);
  user-select: none;
}
.hunk td {
  background: color-mix(in srgb, var(--running) 9%, var(--panel));
  color: var(--muted);
  padding: 3px 8px;
}
tr.add td,
td.add {
  background: color-mix(in srgb, var(--done) 14%, var(--panel));
}
tr.del td,
td.del {
  background: color-mix(in srgb, var(--failed) 13%, var(--panel));
}
tr.add .no,
td.no.add {
  background: color-mix(in srgb, var(--done) 22%, var(--panel));
}
tr.del .no,
td.no.del {
  background: color-mix(in srgb, var(--failed) 20%, var(--panel));
}
td.no {
  position: relative;
}
.plus {
  position: absolute;
  left: 2px;
  top: 1px;
  width: 18px;
  height: 18px;
  padding: 0;
  line-height: 16px;
  border-radius: 4px;
  background: var(--accent);
  color: white;
  border: 0;
  opacity: 0;
}
tr:hover > td > .plus,
.plus:focus-visible {
  opacity: 1;
}
tr.thread td {
  background: var(--panel-2);
  padding: 4px 12px;
  white-space: normal;
}
td.blank {
  background: var(--panel-2);
}
</style>
