import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { MAY_IMPORT, PACKAGE_AREAS, areaOf } from '../../scripts/lib/dashboard-layout.ts';
import { type Source, lineOf, parseSource, readSources } from '../../scripts/lib/sources.ts';
import { TASK_STATUSES } from '../../src/domain/work/lifecycle/lifecycle.ts';

const APP_SRC = join(import.meta.dirname, '../../../app/src');
const sources = readSources(APP_SRC, { vue: true });

const ENTRY = ['App.vue', 'main.ts', 'vite-env.d.ts'];

const daemonAllowed = (target: string) =>
  /^(\.\.\/)+daemon\/src\/domain\//.test(target) || /^(\.\.\/)+daemon\/src\/api\/contract\/[a-z-]+\.ts$/.test(target);

export function layoutViolations(sources: Source[]): string[] {
  const found: string[] = [];
  for (const s of sources) {
    const area = areaOf(s.path);
    for (const i of s.imports) {
      const pkg = PACKAGE_AREAS[i.spec];
      if (pkg && !pkg.areas.includes(area)) found.push(`${s.path}:${i.line} imports ${i.spec}: ${pkg.why}`);
    }
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
        if (!daemonAllowed(i.target)) found.push(`${at}: only the daemon's domain/ and api/contract/ are imported`);
      } else if (to !== area && !rule.areas.includes(to)) found.push(`${at}: ${rule.why}`);
    }
  }
  return found;
}

test('[dashboard-layout] each folder of app/src imports only the folders below it', () => {
  assert.deepEqual(layoutViolations(sources), []);
});

test('[dashboard-layout] the layout check fails when components/ui/ imports from a context', () => {
  const bad = parseSource(
    'components/ui/Chip.vue',
    `<script setup lang="ts">\nimport Card from '../work/overview/PlanCard.vue';\n</script>`,
  );
  assert.deepEqual(layoutViolations([bad]), [
    'components/ui/Chip.vue:2 imports components/work/overview/PlanCard.vue: components/ui/ is shared by every context, so it imports none of them in its layer',
  ]);
  const ok = parseSource(
    'components/work/overview/PlanCard.vue',
    `import Chip from '../../ui/Chip.vue';\nimport PrCard from '../../landing/PullRequestCard.vue';\nimport { x } from '../../../lib/work/task-view';`,
  );
  assert.deepEqual(layoutViolations([ok]), []);
  const daemon = parseSource('lib/shared/x.ts', `import { a } from '../../../../daemon/src/db/index.ts';`);
  assert.equal(layoutViolations([daemon]).length, 1);
});

test('[dashboard-layout] the layout check fails when one context imports another', () => {
  const repos = parseSource(
    'components/repos/RepoEditor.vue',
    `<script setup lang="ts">\nimport Peek from '../work/queue/TaskPeek.vue';\n</script>`,
  );
  assert.deepEqual(layoutViolations([repos]), [
    'components/repos/RepoEditor.vue:2 imports components/work/queue/TaskPeek.vue: a context imports no other context',
  ]);
  const runs = parseSource('lib/runs/verify.ts', `import { taskBadges } from '../work/task-badges.ts';`);
  assert.deepEqual(layoutViolations([runs]), ['lib/runs/verify.ts:1 imports lib/work/task-badges.ts: a context imports no other context']);
  for (const context of ['work', 'runs', 'landing', 'repos', 'operations', 'insights']) {
    const shared = parseSource('lib/shared/forms.ts', `import { x } from '../${context}/x.ts';`);
    assert.equal(layoutViolations([shared]).length, 1, `lib/shared/ importing lib/${context}/`);
  }
});

test('[dashboard-layout] the layout check fails when a component imports from pages/, and only App uses a page', () => {
  const vue = (from: string) => `<script setup lang="ts">\nimport Page from '${from}';\n</script>`;
  const layout = parseSource('components/layout/Overlays.vue', vue('../../pages/TaskPage.vue'));
  assert.equal(layoutViolations([layout]).length, 1, 'components/layout/ importing a page');
  const task = parseSource('components/work/task/TaskView.vue', vue('../../../pages/TaskPage.vue'));
  assert.equal(layoutViolations([task]).length, 1, 'a context component importing a page');
  const app = parseSource('App.vue', vue('./pages/TaskPage.vue'));
  assert.deepEqual(layoutViolations([app]), []);
});

test('[dashboard-layout] vue-router is imported only by the router, the entry files, composables and components', () => {
  const line = `import { useRoute } from 'vue-router';`;
  const use = (path: string) => parseSource(path, path.endsWith('.vue') ? `<script setup lang="ts">\n${line}\n</script>` : line);
  for (const path of ['router.ts', 'App.vue', 'main.ts', 'composables/work/useX.ts', 'components/ui/X.vue', 'components/layout/X.vue'])
    assert.deepEqual(layoutViolations([use(path)]), [], path);
  for (const path of ['pages/TaskPage.vue', 'lib/shared/x.ts', 'api/work.ts', 'platform/theme.ts'])
    assert.equal(layoutViolations([use(path)]).length, 1, path);
});

export function reExports(s: Source): { name: string; line: number }[] {
  const imported = new Set<string>();
  for (const st of s.ast.statements) {
    const b = ts.isImportDeclaration(st) ? st.importClause : undefined;
    if (b?.name) imported.add(b.name.text);
    if (b?.namedBindings && ts.isNamedImports(b.namedBindings)) b.namedBindings.elements.forEach((e) => imported.add(e.name.text));
    if (b?.namedBindings && ts.isNamespaceImport(b.namedBindings)) imported.add(b.namedBindings.name.text);
  }
  const out: { name: string; line: number }[] = [];
  for (const st of s.ast.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const e of st.exportClause.elements) {
      const local = (e.propertyName ?? e.name).text;
      if (st.moduleSpecifier || imported.has(local)) out.push({ name: e.name.text, line: lineOf(s.ast, e) });
    }
  }
  return out;
}

test('[dashboard-layout] a file in lib/ re-exports no name it imports', () => {
  const found = sources
    .filter((s) => s.path.startsWith('lib/'))
    .flatMap((s) => reExports(s).map((r) => `${s.path}:${r.line} re-exports ${r.name}: import it from where it is declared`));
  assert.deepEqual(found, []);
});

test('[dashboard-layout] the re-export finder sees an imported name exported, and ignores what a file declares', () => {
  const s = parseSource(
    'lib/work/view.ts',
    [
      `import { a, type B } from './x.ts';`,
      `import { c } from './y.ts';`,
      `export { a, type B };`,
      `export { d } from './z.ts';`,
      `const e = c + 1;`,
      `export { e };`,
      `export const f = 1;`,
    ].join('\n'),
  );
  assert.deepEqual(
    reExports(s).map((r) => [r.name, r.line]),
    [
      ['a', 3],
      ['B', 3],
      ['d', 4],
    ],
  );
});

const STATUSES = new Set<string>(TASK_STATUSES);

const QUESTION = /^(can|is|has|should|may)[A-Z]|(Shown|Allowed|Enabled|Visible|Available)$/;

function declaredIn(node: ts.Node): string | null {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
  }
  return null;
}

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

const KNOWN_RULES: Record<string, string> = {
  'components/work/queue/BoardView.vue:canDrag': 'domain/work/lifecycle/lifecycle.ts: when a task can be moved',
  'components/work/task/Sidebar.vue:autoMergeShown': 'domain/landing/merge/auto-merge.ts: when auto-merge applies to a task',
  'lib/work/queue/graph.ts:isFinished': 'domain/work/task/stage.ts: when a task counts as finished',
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
