<script setup lang="ts">
import { computed } from 'vue';
import { type DiffLine, parsePatch, splitRows } from '../../diff';
import { highlightLines, languageFor } from '../../render';

// One file's patch, unified or side by side, highlighted by the file's language.
const props = defineProps<{ path: string; patch: string; split: boolean }>();

const hunks = computed(() => parsePatch(props.patch));

/**
 * Highlight the old and new sides as continuous text, so a multi-line comment or string keeps its
 * colour across lines; then look each line's HTML up by side and line number.
 */
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
  // Context lines are on both sides; the new side's HTML wins, which is the same text.
  newLines.forEach((l, i) => map.set(l, newHtml[i]));
  return map;
});

const splitHunks = computed(() => hunks.value.map((h) => ({ header: h.header, rows: splitRows(h.lines) })));
</script>

<template>
  <div class="diff" :class="{ split }">
    <p v-if="!hunks.length" class="muted empty">No line changes (mode or rename only).</p>
    <table v-else-if="!split">
      <tbody v-for="(h, hi) in hunks" :key="hi">
        <tr class="hunk">
          <td class="no" colspan="2" />
          <td class="code">{{ h.header }}</td>
        </tr>
        <tr v-for="(l, i) in h.lines" :key="i" :class="l.type">
          <td class="no">{{ l.old ?? '' }}</td>
          <td class="no">{{ l.new ?? '' }}</td>
          <!-- eslint-disable-next-line vue/no-v-html -- escaped by highlight.js -->
          <td class="code">
            <span class="sign">{{ l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ' }}</span
            ><span v-html="html.get(l)" />
          </td>
        </tr>
      </tbody>
    </table>
    <table v-else>
      <tbody v-for="(h, hi) in splitHunks" :key="hi">
        <tr class="hunk">
          <td class="no" />
          <td class="code" colspan="3">{{ h.header }}</td>
        </tr>
        <tr v-for="(r, i) in h.rows" :key="i">
          <td class="no" :class="r.left?.type">{{ r.left?.old ?? '' }}</td>
          <!-- eslint-disable-next-line vue/no-v-html -- escaped by highlight.js -->
          <td class="code half" :class="r.left ? r.left.type : 'blank'"><span v-if="r.left" v-html="html.get(r.left)" /></td>
          <td class="no" :class="r.right?.type">{{ r.right?.new ?? '' }}</td>
          <!-- eslint-disable-next-line vue/no-v-html -- escaped by highlight.js -->
          <td class="code half" :class="r.right ? r.right.type : 'blank'"><span v-if="r.right" v-html="html.get(r.right)" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.diff {
  overflow-x: auto;
  font:
    12px/1.5 ui-monospace,
    'SF Mono',
    Menlo,
    monospace;
}
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
.split .no {
  width: 48px;
}
.code {
  white-space: pre;
}
.split .code {
  white-space: pre-wrap;
  word-break: break-all;
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
td.blank {
  background: var(--panel-2);
}
.empty {
  padding: 10px 14px;
  font-family: inherit;
}
</style>
