// The dashboard's layout in CLAUDE.md (app/src/), checked against the source: which folders may import which, and which
// task status comparisons are rules the dashboard decides for itself. Each failure names the file, the line and the rule.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { type Source, lineOf, parseSource, readSources } from '../scripts/lib/sources.ts';
import { TASK_STATUSES } from '../src/domain/task/lifecycle.ts';

const APP_SRC = join(import.meta.dirname, '../../app/src');
const sources = readSources(APP_SRC, { vue: true });

/** The area a file belongs to: `components/<area>`, another top folder, or the file itself (`App.vue`, `router.ts`, `main.ts`). */
export function areaOf(path: string): string {
  if (path.startsWith('..')) return path.includes('daemon/src/') ? 'daemon' : 'repo';
  const parts = path.split('/');
  if (parts[0] === 'components' && parts.length > 2) return `components/${parts[1]}`;
  return parts.length > 1 ? parts[0] : path;
}

const UI = 'components/ui';
const BELOW_COMPONENTS = ['api', 'lib', 'composables', 'platform', 'router'];

/** Which areas each area may import, and why. Imports point down: a shared piece never imports the area that uses it. */
const MAY_IMPORT: Record<string, { areas: string[]; why: string }> = {
  api: { areas: ['api'], why: 'api/ is the base: types, calls and wording' },
  lib: { areas: ['lib', 'api'], why: 'lib/ is pure helpers over the api' },
  platform: { areas: ['platform', 'lib'], why: 'platform/ is the Tauri shell, build commit and theme' },
  composables: { areas: ['composables', 'api', 'lib', 'platform', 'router'], why: 'composables/ never reach into components/' },
  router: { areas: ['api', 'lib'], why: 'the router is below the components' },
  [UI]: { areas: [UI, ...BELOW_COMPONENTS], why: 'components/ui/ is shared by every area, so it imports none of them' },
  'components/files': { areas: ['components/files', UI, ...BELOW_COMPONENTS], why: 'components/files/ is used by task/ and queue/' },
  'components/task': { areas: ['components/task', 'components/files', UI, ...BELOW_COMPONENTS], why: 'task/ may use files/ and ui/' },
  'components/queue': {
    areas: ['components/queue', 'components/task', 'components/files', UI, ...BELOW_COMPONENTS],
    why: 'queue/ may use task/, files/ and ui/',
  },
  'components/layout': { areas: ['components/layout', UI, ...BELOW_COMPONENTS], why: 'layout/ is the frame and uses ui/ only' },
  'components/panels': { areas: ['components/panels', UI, ...BELOW_COMPONENTS], why: 'panels/ use ui/ only' },
  'components/insights': { areas: ['components/insights', UI, ...BELOW_COMPONENTS], why: 'insights/ uses ui/ only' },
};

/** Files at the top of app/src and `styles/` that import anything: the entry points. */
const ENTRY = ['App.vue', 'main.ts', 'vite-env.d.ts'];

/** The daemon files the dashboard may import: rules come from `domain/`, types from the contract. */
const daemonAllowed = (target: string) =>
  /^(\.\.\/)+daemon\/src\/domain\//.test(target) || /^(\.\.\/)+daemon\/src\/api\/contract\.ts$/.test(target);

/** What each import in a source breaks, as `file:line imports target: why`. */
export function layoutViolations(sources: Source[]): string[] {
  const found: string[] = [];
  for (const s of sources) {
    const area = areaOf(s.path).replace(/\.ts$/, '');
    if (ENTRY.includes(s.path) || area === 'styles') continue;
    const rule = MAY_IMPORT[area];
    if (!rule) {
      found.push(`${s.path}:1 is in no known area (${area}); add it to MAY_IMPORT`);
      continue;
    }
    for (const i of s.imports) {
      if (!i.target) continue;
      const to = areaOf(i.target);
      const at = `${s.path}:${i.line} imports ${i.target}`;
      if (to === 'repo') {
        if (!/\/docs\/plans\/plan\.css\?raw$/.test(i.target))
          found.push(`${at}: only the plan stylesheet is imported from outside app/ and daemon/`);
      } else if (to === 'daemon') {
        if (!daemonAllowed(i.target)) found.push(`${at}: only the daemon's domain/ and api/contract.ts are imported`);
      } else if (to !== area && !rule.areas.includes(to)) found.push(`${at}: ${rule.why}`);
    }
  }
  return found;
}

test('[dashboard-layout] each folder of app/src imports only the folders below it', () => {
  assert.deepEqual(layoutViolations(sources), []);
});

test('[dashboard-layout] the layout check fails when components/ui/ imports from components/task/', () => {
  const bad = parseSource('components/ui/Chip.vue', `<script setup lang="ts">\nimport Card from '../task/PlanCard.vue';\n</script>`);
  assert.deepEqual(layoutViolations([bad]), [
    'components/ui/Chip.vue:2 imports components/task/PlanCard.vue: components/ui/ is shared by every area, so it imports none of them',
  ]);
  const ok = parseSource('components/task/PlanCard.vue', `import Chip from '../ui/Chip.vue';\nimport { x } from '../../lib/taskView';`);
  assert.deepEqual(layoutViolations([ok]), []);
  const daemon = parseSource('lib/x.ts', `import { a } from '../../../daemon/src/db/index.ts';`);
  assert.equal(layoutViolations([daemon]).length, 1);
});

const STATUSES = new Set<string>(TASK_STATUSES);

/** A declaration named like a yes-or-no question about a task: what it answers is a rule, whatever the markup does with it. */
const QUESTION = /^(can|is|has|should|may)[A-Z]|(Shown|Allowed|Enabled|Visible|Available)$/;

/** The name of the declaration (`const canDrag = …`, a function or a method) a node is in, or null at the top of a file. */
function declaredIn(node: ts.Node): string | null {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
  }
  return null;
}

/** Every `x.status === 'queued'` (or `!==`) in a source, as `file:name` of the declaration it is in and the line. */
export function statusComparisons(s: Source): { key: string; line: number; name: string | null }[] {
  const out: ReturnType<typeof statusComparisons> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
    ) {
      const [prop, lit] = [node.left, node.right].some((e) => ts.isStringLiteralLike(e))
        ? ts.isStringLiteralLike(node.right)
          ? [node.left, node.right]
          : [node.right, node.left]
        : [];
      if (
        prop &&
        lit &&
        ts.isPropertyAccessExpression(prop) &&
        prop.name.text === 'status' &&
        STATUSES.has((lit as ts.StringLiteralLike).text)
      ) {
        const name = declaredIn(node);
        out.push({ key: `${s.path}:${name ?? '(top)'}`, line: lineOf(s.ast, node), name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(s.ast);
  return out;
}

/**
 * Task status comparisons in the dashboard that are rules (a question like "can this be dragged?"), each with where the
 * rule belongs. They are not fixed yet: this list only shrinks. Fix one by moving the rule into the daemon's domain/ and
 * deleting its line here.
 */
const KNOWN_RULES: Record<string, string> = {
  'components/queue/BoardView.vue:canDrag': 'domain/task/lifecycle.ts: when a task can be moved',
  'components/task/Sidebar.vue:autoMergeShown': 'domain/pull-request/auto-merge.ts: when auto-merge applies to a task',
  'lib/graph.ts:isFinished': 'domain/task/stage.ts: when a task counts as finished',
};

test('[dashboard-layout] the status comparison finder sees a rule by its name and ignores other comparisons', () => {
  const s = parseSource(
    'components/x/A.vue',
    `<script setup lang="ts">\nconst canDrag = (t) => t.status !== 'running';\nconst label = (t) => (t.status === 'done' ? 'a' : 'b');\nconst other = t.kind === 'running' || f.status === 'D';\n</script>`,
  );
  assert.deepEqual(
    statusComparisons(s).map((c) => [c.key, c.line]),
    [
      ['components/x/A.vue:canDrag', 2],
      ['components/x/A.vue:label', 3],
    ],
  );
});

test('[dashboard-layout] the dashboard decides no new rule on a task status, and the known ones are still there', () => {
  const found = new Set(sources.flatMap((s) => statusComparisons(s).flatMap((c) => (c.name && QUESTION.test(c.name) ? [c.key] : []))));
  const found_ = [...found];
  assert.deepEqual(
    found_.filter((k) => !(k in KNOWN_RULES)),
    [],
    "a new task status comparison that is a rule: put the rule in the daemon's domain/ (rules come from the daemon, never copied), or rename the declaration if it is not a rule",
  );
  assert.deepEqual(
    Object.keys(KNOWN_RULES).filter((k) => !found.has(k)),
    [],
    'a known rule is fixed or gone: delete it from KNOWN_RULES',
  );
});
