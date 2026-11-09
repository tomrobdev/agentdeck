// The Boundaries and Rules in CLAUDE.md, checked against the source. Each failure names the file, the line and the rule.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import ts from 'typescript';
import { checkContextImports, checkContextIndexes, checkUnusedIndexExports } from '../../scripts/lib/contexts.ts';
import { LAYERS, layerOf, mayImport } from '../../scripts/lib/layers.ts';
import { type LayoutFile, checkContextFolders, checkFileSize, checkFolderSize, readLayout } from '../../scripts/lib/layout.ts';
import {
  LONG_FILES,
  OVERSIZED_FOLDERS,
  PLAIN_TASK_WRITES,
  UNPLACED_FOLDERS,
  checkFolderCycles,
  checkRowShapedFields,
} from '../../scripts/lib/progress.ts';
import { type Source, lineOf, parseSource, readSources } from '../../scripts/lib/sources.ts';
import { MIGRATIONS, migrate } from '../../src/db/index.ts';

const SRC = join(import.meta.dirname, '../../src');

const sources = readSources(SRC);

/** Packages, and the only files that may import them. */
const PACKAGES: { match: RegExp; allowed: (path: string) => boolean; why: string }[] = [
  { match: /^node:sqlite$/, allowed: (p) => p.startsWith('db/'), why: 'SQL lives only in db/' },
  { match: /^node:child_process$/, allowed: (p) => p.startsWith('adapters/'), why: 'processes are started by adapters/' },
  { match: /^node:/, allowed: (p) => !p.startsWith('domain/'), why: 'domain/ is pure: no I/O' },
  { match: /^drizzle-orm(\/|$)/, allowed: (p) => p.startsWith('db/'), why: 'Drizzle is the db layer, for db/ only' },
  { match: /^(?!node:)/, allowed: () => false, why: 'no runtime dependencies' },
];

const at = (s: Source, line: number) => `${s.path}:${line}`;

/** The imports that break the layer rules, as `path:line imports target: why`. */
const layerViolations = (files: Source[]) =>
  files.flatMap((s) => {
    const rule = LAYERS[layerOf(s.path)];
    return s.imports
      .filter((i) => i.target && !mayImport(layerOf(s.path), layerOf(i.target)))
      .map((i) => `${at(s, i.line)} imports ${i.target}: ${rule?.why}`);
  });

test('[ports] application/ imports only itself and domain/, and only compose.ts names db/ and adapters/', () => {
  const namers = sources
    .filter((s) => s.imports.some((i) => ['db', 'adapters'].includes(layerOf(i.target ?? ''))))
    .map((s) => s.path)
    .filter((p) => !['compose.ts', 'db', 'adapters'].includes(layerOf(p)));
  assert.deepEqual(namers, [], 'a layer above db/ and adapters/ reaches them through a port in application/ports/, built in compose.ts');
});

test('[ports] a sample where application/ imports adapters/git.ts or db/ fails', () => {
  const sample = [
    parseSource('application/work/x.ts', "import { git } from '../../adapters/git/exec.ts';\nexport const x = git;\n"),
    parseSource('application/work/y.ts', "import { openDb } from '../../db/index.ts';\nexport const y = openDb;\n"),
    parseSource('api/z.ts', "import { openDb } from '../db/index.ts';\nexport const z = openDb;\n"),
    parseSource('compose.ts', "import { openDb } from './db/index.ts';\nexport const c = openDb;\n"),
  ];
  assert.equal(layerViolations(sample).length, 3);
});

test('[layers, domain-pure, adapters-io, entry-points] each layer imports only the layers below it', () => {
  const found: string[] = [];
  for (const s of sources) {
    const rule = LAYERS[layerOf(s.path)];
    assert.ok(rule, `${s.path} is in no known layer; add it to LAYERS (scripts/lib/layers.ts)`);
    for (const i of s.imports) {
      if (!i.target) continue;
      if (!mayImport(layerOf(s.path), layerOf(i.target))) found.push(`${at(s, i.line)} imports ${i.target}: ${rule.why}`);
    }
  }
  assert.deepEqual(found, []);
});

test('[actions-only, entry-points] api/ and cli/ reach application/ only through actions.ts', () => {
  const found: string[] = [];
  for (const s of sources.filter((s) => ['api', 'cli', 'cli.ts'].includes(layerOf(s.path)))) {
    for (const i of s.imports) {
      if (i.target?.startsWith('application/') && i.target !== 'application/actions.ts')
        found.push(`${at(s, i.line)} imports ${i.target}: entry points use the use cases through application/actions.ts`);
    }
  }
  assert.deepEqual(found, []);
});

test('[contract-types] api/contract/ imports only types, only from domain/ and each other', () => {
  const found = sources
    .filter((s) => s.path.startsWith('api/contract/'))
    .flatMap((s) =>
      s.imports.flatMap((i) => {
        if (!i.typeOnly) return [`${at(s, i.line)} imports ${i.spec} as a value: the contract imports types only`];
        if (!i.target?.startsWith('domain/') && !i.target?.startsWith('api/contract/'))
          return [`${at(s, i.line)} imports ${i.spec}: the contract imports only from domain/ and its own files`];
        return [];
      }),
    );
  assert.deepEqual(found, []);
});

test('[domain-pure, sql-in-db, no-runtime-deps] packages are imported only where they belong', () => {
  const found: string[] = [];
  for (const s of sources) {
    for (const i of s.imports) {
      if (i.target) continue;
      const rule = PACKAGES.find((p) => p.match.test(i.spec));
      if (rule && !rule.allowed(s.path)) found.push(`${at(s, i.line)} imports ${i.spec}: ${rule.why}`);
    }
  }
  assert.deepEqual(found, []);
});

test('[sql-in-db] db/tables.ts is imported at runtime only by files in db/', () => {
  const found = sources.flatMap((s) =>
    s.imports
      .filter((i) => i.target === 'db/tables.ts' && !i.typeOnly && !s.path.startsWith('db/'))
      .map((i) => `${at(s, i.line)} imports db/tables.ts at runtime, outside db/`),
  );
  assert.deepEqual(found, []);
});

test('[layers] there are no import cycles', () => {
  // Type-only imports are erased, so only runtime imports can form a cycle.
  const edges = new Map(sources.map((s) => [s.path, s.imports.filter((i) => i.target && !i.typeOnly).map((i) => i.target!)]));
  const cycles: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (path: string) => {
    state.set(path, 'open');
    stack.push(path);
    for (const next of edges.get(path) ?? []) {
      if (state.get(next) === 'open') cycles.push([...stack.slice(stack.indexOf(next)), next].join(' → '));
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(path, 'done');
  };
  for (const path of edges.keys()) if (!state.has(path)) visit(path);
  assert.deepEqual(cycles, []);
});

const dashboard = readSources(join(SRC, '../../app/src'), { vue: true });

test('[contexts] every context has an index.ts of named exports, and every context is imported only through it', () => {
  assert.deepEqual([...checkContextIndexes(sources), ...checkContextImports(sources, dashboard)], []);
});

test('[contexts] an index exports only what something outside its context imports', () => {
  assert.deepEqual(checkUnusedIndexExports(sources, dashboard), []);
});

test('[contexts] a sample that reaches into another context, or has a bare or starred index, fails', () => {
  const sample = [
    parseSource('domain/work/lifecycle/lifecycle.ts', 'export const RULES = 1;\n'),
    parseSource('domain/work/index.ts', "export { RULES } from './lifecycle.ts';\n"),
    parseSource('domain/runs/run.ts', "import { RULES } from '../work/lifecycle.ts';\nexport const r = RULES;\n"),
    parseSource('domain/runs/index.ts', "export * from './run.ts';\n"),
    parseSource('domain/capacity/quota.ts', "import { RULES } from '../work/index.ts';\nexport const q = RULES;\n"),
  ];
  const found = [...checkContextIndexes(sample), ...checkContextImports(sample)];
  assert.equal(found.length, 3);
  assert.match(found.join('\n'), /domain\/runs\/run\.ts:1 imports domain\/work\/lifecycle\.ts/);
  assert.match(found.join('\n'), /domain\/runs\/index\.ts:1 must be/);
  assert.match(found.join('\n'), /domain\/capacity\/ has no index\.ts/);
  const dash = [parseSource('x.ts', "import { PATCH_LIMIT } from '../../daemon/src/domain/work/read/files.ts';\n")];
  assert.equal(checkContextImports(sample, dash).filter((m) => m.startsWith('x.ts:1')).length, 1);
  assert.deepEqual(checkUnusedIndexExports(sample), []);
  assert.match(checkUnusedIndexExports(sample.slice(0, 2)).join('\n'), /domain\/work\/index\.ts exports RULES/);
});

/** Each `export * from` in the sources, as `path:line`. */
const exportStars = (files: Source[]) =>
  files.flatMap((s) =>
    s.ast.statements
      .filter((n) => ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier)
      .map((n) => `${at(s, lineOf(s.ast, n))}: name what it re-exports`),
  );

test('[no-export-star] nothing in daemon/src or app/src re-exports with `export *`', () => {
  assert.deepEqual([...exportStars(sources), ...exportStars(dashboard)], []);
});

test('[no-export-star] a sample with `export *` fails, naming the line; a named re-export passes', () => {
  const sample = [
    parseSource('api/index.ts', "// the api\nexport * from './client.ts';\n"),
    parseSource('lib/view.ts', "export { boardMove, type BoardMove } from './board-move.ts';\nexport * as moves from './moves.ts';\n"),
  ];
  assert.deepEqual(exportStars(sample), ['api/index.ts:2: name what it re-exports']);
});

test('[folder-cycles] domain/ and application/ folders form no cycle beyond the allowed ones, and no allowed entry is stale', () => {
  const { found, stale } = checkFolderCycles(sources);
  assert.deepEqual([...found, ...stale], []);
});

test('[folder-cycles] a sample with a new folder cycle fails, naming the folders and files; a stale entry fails too', () => {
  const sample = [
    parseSource('domain/a/a.ts', "import { b } from '../b/b.ts';\nexport const a = b;\n"),
    parseSource('domain/b/b.ts', "import type { a } from '../a/a.ts';\nexport const b = 1 as typeof a;\n"),
    parseSource('domain/c/c.ts', "import { a } from '../a/a.ts';\nexport const c = a;\n"),
  ];
  const fresh = checkFolderCycles(sample, {});
  assert.equal(fresh.found.length, 1);
  assert.match(fresh.found[0], /domain\/a, domain\/b/);
  assert.match(fresh.found[0], /domain\/a\/a\.ts:1/);
  assert.match(fresh.found[0], /domain\/b\/b\.ts:1/);
  assert.deepEqual(checkFolderCycles(sample, { domain: ['domain/a, domain/b'] }), { found: [], stale: [] });
  const stale = checkFolderCycles([sample[0], sample[2]], { domain: ['domain/a, domain/b'] });
  assert.equal(stale.stale.length, 1);
  assert.match(stale.stale[0], /no longer a cycle/);
});

const layout = readLayout(join(SRC, '../..'));

test('[folder-size] no folder has more than 12 files beyond the listed ones, and no listed folder is back under the limit', () => {
  const { found, stale } = checkFolderSize(layout, OVERSIZED_FOLDERS);
  assert.deepEqual([...found, ...stale], []);
});

test('[folder-size] a sample with a 13th file in an unlisted folder fails, naming it; a listed folder may grow; a stale entry fails', () => {
  const files = (dir: string, n: number): LayoutFile[] => Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}.ts`, lines: 1 }));
  const sample = [...files('daemon/src/a', 13), ...files('daemon/src/b', 12), ...files('daemon/src/c', 20)];
  const fresh = checkFolderSize(sample, ['daemon/src/c']);
  assert.equal(fresh.found.length, 1);
  assert.match(fresh.found[0], /^daemon\/src\/a has 13 files, over 12/);
  assert.deepEqual(fresh.stale, []);
  assert.deepEqual(checkFolderSize(sample, ['daemon/src/a', 'daemon/src/c']), { found: [], stale: [] });
  const stale = checkFolderSize(sample, ['daemon/src/a', 'daemon/src/b', 'daemon/src/c']);
  assert.equal(stale.stale.length, 1);
  assert.match(stale.stale[0], /daemon\/src\/b is on OVERSIZED_FOLDERS but is within the limit/);
  // Subfolders do not count: 12 files in a folder with a subfolder of 12 more is within the limit.
  assert.deepEqual(checkFolderSize([...files('daemon/src/d', 12), ...files('daemon/src/d/e', 12)], []), { found: [], stale: [] });
});

test('[file-size] no file has more than 400 lines beyond the listed ones, and no listed file is back under the limit', () => {
  const { found, stale } = checkFileSize(layout, LONG_FILES);
  assert.deepEqual([...found, ...stale], []);
});

test('[file-size] a sample with a 401-line file fails, naming it; a listed file may grow; a stale entry fails', () => {
  const sample: LayoutFile[] = [
    { path: 'daemon/src/a.ts', lines: 401 },
    { path: 'daemon/src/b.ts', lines: 400 },
    { path: 'daemon/src/c.ts', lines: 900 },
  ];
  const fresh = checkFileSize(sample, ['daemon/src/c.ts']);
  assert.equal(fresh.found.length, 1);
  assert.match(fresh.found[0], /^daemon\/src\/a\.ts has 401 lines, over 400/);
  assert.deepEqual(checkFileSize(sample, ['daemon/src/a.ts', 'daemon/src/c.ts']), { found: [], stale: [] });
  const stale = checkFileSize(sample, ['daemon/src/a.ts', 'daemon/src/b.ts', 'daemon/src/c.ts']);
  assert.equal(stale.stale.length, 1);
  assert.match(stale.stale[0], /daemon\/src\/b\.ts is on LONG_FILES but is within the limit/);
});

test('[context-folders] files in db/, adapters/, api/routes/, cli/ and daemon/test/ sit in context folders beyond the listed folders', () => {
  const { found, stale } = checkContextFolders(layout, UNPLACED_FOLDERS);
  assert.deepEqual([...found, ...stale], []);
});

test('[context-folders] a sample with a loose file or an unknown folder fails; a listed folder may keep loose files; a stale entry fails', () => {
  const at = (path: string): LayoutFile => ({ path, lines: 1 });
  const sample = [
    at('daemon/src/db/index.ts'),
    at('daemon/src/db/work/tasks.ts'),
    at('daemon/src/db/loose.ts'),
    at('daemon/src/db/misc/x.ts'),
    at('daemon/src/cli/work/tasks.ts'),
  ];
  const fresh = checkContextFolders(sample, ['daemon/src/cli']);
  assert.equal(fresh.found.length, 2);
  assert.match(fresh.found.join('\n'), /daemon\/src\/db\/ has 1 files outside a context folder, such as daemon\/src\/db\/loose\.ts/);
  assert.match(fresh.found.join('\n'), /daemon\/src\/db\/misc/);
  assert.match(fresh.stale.join('\n'), /daemon\/src\/cli is on UNPLACED_FOLDERS but holds only shared files/);
  const listed = checkContextFolders(sample.slice(0, 3), ['daemon/src/db']);
  assert.deepEqual(listed, { found: [], stale: [] });
});

/** Globals that read the clock, randomness, the environment or the outside world. */
const AMBIENT = new Set([
  'Date.now',
  'Math.random',
  'performance.now',
  'crypto',
  'process',
  'console',
  'fetch',
  'setTimeout',
  'setInterval',
]);

test('[domain-pure] domain/ reads no clock, randomness or environment, except as a parameter default', () => {
  const found: string[] = [];
  for (const s of sources.filter((s) => s.path.startsWith('domain/'))) {
    const visit = (node: ts.Node) => {
      let name: string | null = null;
      if (ts.isPropertyAccessExpression(node) && AMBIENT.has(node.getText(s.ast))) name = node.getText(s.ast);
      else if (ts.isIdentifier(node) && AMBIENT.has(node.text) && isFreeReference(node)) name = node.text;
      else if (ts.isNewExpression(node) && node.expression.getText(s.ast) === 'Date' && !node.arguments?.length) name = 'new Date()';
      if (name && !inParameterDefault(node))
        found.push(`${at(s, lineOf(s.ast, node))} uses ${name}: domain/ is pure; take it as a parameter`);
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  assert.deepEqual(found, []);
});

/** The parsers of outside formats in domain/ that may call JSON.parse: claude's log, a review run's answer, GitHub's answers, and a stored list a repo's setting reads. A stored column is parsed in db/mappers.ts. */
const OUTSIDE_JSON = ['domain/runs/translate/log.ts', 'domain/runs/review.ts', 'domain/landing/merge/merge.ts', 'domain/shared/text.ts'];

test('[domain-pure] domain/ calls JSON.parse only in the parsers of outside formats', () => {
  const found = sources
    .filter((s) => s.path.startsWith('domain/') && !OUTSIDE_JSON.includes(s.path))
    .filter((s) => s.ast.text.includes('JSON.parse'))
    .map(
      (s) =>
        `${s.path} calls JSON.parse: parse a stored column in db/mappers.ts, or list the file on OUTSIDE_JSON if it reads an outside format`,
    );
  assert.deepEqual(found, []);
});

/** An identifier that refers to a variable, not a property name or a declaration. */
function isFreeReference(node: ts.Identifier): boolean {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === node) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === node) return false;
  return true;
}

function inParameterDefault(node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    if (ts.isParameter(n.parent) && n.parent.initializer === n) return true;
  }
  return false;
}

test('[sql-in-db] SQL runs only in db/', () => {
  const found: string[] = [];
  for (const s of sources.filter((s) => !s.path.startsWith('db/'))) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'prepare')
        found.push(`${at(s, lineOf(s.ast, node))} prepares a statement: SQL lives only in db/`);
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  assert.deepEqual(found, []);
});

test('[sql-in-db] nothing outside db/ uses db.raw', () => {
  assert.deepEqual(findRawHandleUse('const n = db.raw.prepare("x");'), [1]);
  assert.deepEqual(findRawHandleUse('const n = deps.db.raw;'), [1]);
  assert.deepEqual(findRawHandleUse('const n = sql.raw("x"); const m = flags.raw;'), []);
  const found = sources
    .filter((s) => !s.path.startsWith('db/'))
    .flatMap((s) =>
      findRawHandleUse(s.ast.text).map((line) => `${at(s, line)} uses db.raw: the handle is for tests; SQL lives only in db/`),
    );
  assert.deepEqual(found, []);
});

test('[sql-in-db] raw sql in db/ carries a `// guard:` comment saying what the builder cannot express', () => {
  // The query builder is the default; a raw `sql` fragment is for what it hides or lacks, and says so on its line or the one above.
  const found: string[] = [];
  for (const s of sources.filter((s) => s.path.startsWith('db/'))) {
    const lines = s.ast.text.split('\n');
    const visit = (node: ts.Node) => {
      const tag = ts.isTaggedTemplateExpression(node) ? node.tag : ts.isCallExpression(node) ? node.expression : null;
      const raw =
        !!tag &&
        ((ts.isIdentifier(tag) && tag.text === 'sql') ||
          (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) && tag.expression.text === 'sql'));
      if (raw) {
        const line = lineOf(s.ast, node);
        const guarded = [lines[line - 1], lines[line - 2]].some((l) => /\/\/ guard: \S.{8,}/.test(l ?? ''));
        if (!guarded)
          found.push(`${at(s, line)} uses raw sql without a "// guard: <what the builder can't express>" comment on it or the line above`);
      }
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  assert.deepEqual(found, []);
});

/** The text of a string or template literal, with each `${…}` as `?`. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `?${s.literal.text}`).join('');
  return null;
}

/** The function a node is in, looking past the arrow functions inside it, named by its method, declaration or `const`. */
function enclosingFunction(node: ts.Node): { name: string; body: ts.Node } | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.body) return { name: n.name?.getText() ?? '', body: n.body };
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name))
      return { name: n.parent.name.text, body: n.body };
  }
  return undefined;
}

/** The only functions that may write a task's status. */
const STATUS_WRITERS = ['applyEvent'];

interface StatusWrite {
  line: number;
  /** The builder's `.update(tasks).set({ status … })`, or a raw SQL string that sets the status. */
  kind: 'builder' | 'raw';
  /** What is wrong with it; empty when it is a guarded write by an allowed function. */
  problems: string[];
}

/** Every write of a task's status in a source string, and what is wrong with each. */
function findStatusWrites(source: string): StatusWrite[] {
  const ast = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  const writes: StatusWrite[] = [];
  const check = (node: ts.Node, kind: StatusWrite['kind'], guarded: boolean) => {
    const problems: string[] = [];
    const fn = enclosingFunction(node);
    if (!fn || !STATUS_WRITERS.includes(fn.name)) problems.push(`is in ${fn?.name || 'no function'}, not ${STATUS_WRITERS.join(' or ')}`);
    else if (!/\b(nextStatus|transition)\(/.test(fn.body.getText(ast)))
      problems.push('does not ask the lifecycle (domain/work/lifecycle/lifecycle.ts)');
    if (!guarded) problems.push('has no WHERE on the status');
    writes.push({ line: lineOf(ast, node), kind, problems });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set') {
      const [fields] = node.arguments;
      const setsStatus =
        !!fields &&
        ts.isObjectLiteralExpression(fields) &&
        fields.properties.some(
          (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(ast) === 'status',
        );
      let updatesTasks = false;
      for (let r: ts.Expression = node.expression.expression; ts.isCallExpression(r) && ts.isPropertyAccessExpression(r.expression);) {
        if (r.expression.name.text === 'update' && r.arguments[0]?.getText(ast) === 'tasks') updatesTasks = true;
        r = r.expression.expression;
      }
      if (setsStatus && updatesTasks) {
        // The calls chained after .set(…): the .where(…) must name the status column.
        let guarded = false;
        for (let n: ts.Node = node; ts.isPropertyAccessExpression(n.parent) && ts.isCallExpression(n.parent.parent); n = n.parent.parent) {
          const [arg] = n.parent.parent.arguments;
          if (n.parent.name.text === 'where' && arg && /\bstatus\b/.test(arg.getText(ast))) guarded = true;
        }
        check(node, 'builder', guarded);
      }
    }
    const text = literalText(node);
    if (text !== null) {
      const update = /UPDATE\s+tasks\s+SET\b([^]*?)(\bWHERE\b|$)/i.exec(text);
      const writesStatus = update ? /(^|,)\s*status\s*=/i.test(update[1]) : /^\s*status\s*=/i.test(text);
      if (writesStatus) check(node, 'raw', !update || /\bWHERE\b[^]*\bstatus\s*(IN\s*\(|=)/i.test(text));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return writes;
}

/** Every `db.raw` (the handle for tests) in a source string: nothing outside db/ may use it. */
function findRawHandleUse(source: string): number[] {
  const ast = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'raw' && /(^|\.)db$/.test(node.expression.getText(ast)))
      lines.push(lineOf(ast, node));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return lines;
}

const UNGUARDED = `const applyEvent = () => { transition(); orm.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 1)).run(); };`;
const GUARDED = `const applyEvent = () => { transition(); orm.update(tasks).set({ status: to }).where(and(eq(tasks.id, 1), eq(tasks.status, 'queued'))).run(); };`;

test('[guarded-status] the finder reports an unguarded builder write, a write outside the allowed functions, and a raw SQL write', () => {
  assert.deepEqual(findStatusWrites(GUARDED), [{ line: 1, kind: 'builder', problems: [] }]);
  assert.deepEqual(findStatusWrites(UNGUARDED)[0].problems, ['has no WHERE on the status']);
  const elsewhere = findStatusWrites(GUARDED.replace('applyEvent', 'cancelAll'));
  assert.match(elsewhere[0].problems[0], /is in cancelAll, not applyEvent$/);
  const claim = findStatusWrites(GUARDED.replace('applyEvent', 'claimNextTask'));
  assert.match(claim[0].problems[0], /is in claimNextTask, not applyEvent$/, 'the claim writes its status through applyEvent');
  const raw = findStatusWrites('function applyEvent() { transition(); db.prepare("UPDATE tasks SET status = \'x\' WHERE id = 1"); }');
  assert.deepEqual(raw[0], { line: 1, kind: 'raw', problems: ['has no WHERE on the status'] });
  assert.deepEqual(findStatusWrites('orm.update(tasks).set({ title: x }).where(eq(tasks.id, 1)); orm.update(runs).set({ status: x })'), []);
});

test('[guarded-status] a task status changes only through a guarded transition', () => {
  // Every status write is in applyEvent, the claim's included, guarded on the status, and asks the lifecycle for the next status.
  const found: string[] = [];
  let count = 0;
  for (const s of sources.filter((s) => s.path.startsWith('db/'))) {
    for (const w of findStatusWrites(s.ast.text)) {
      count++;
      for (const p of w.problems) found.push(`${at(s, w.line)} writes a task status and ${p}`);
    }
  }
  assert.deepEqual(found, []);
  assert.equal(count, STATUS_WRITERS.length, 'the finder should see exactly the status write of applyEvent');
});

interface TaskWrite {
  line: number;
  fn: string;
  /** Whether what it sets comes from a function of domain/ (a decision), or sets the status (rule:guarded-status's). */
  fromDomain: boolean;
  setsStatus: boolean;
}

/** Every `.update(tasks).set(…)` in a source string, and where its fields come from. */
function findTaskWrites(source: string): TaskWrite[] {
  const ast = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  const fromDomainNames = new Set<string>();
  for (const st of ast.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /(^|\/)domain\//.test(st.moduleSpecifier.text)) {
      const named = st.importClause?.namedBindings;
      // `stored` only turns values into columns; it decides nothing.
      if (named && ts.isNamedImports(named)) for (const e of named.elements) if (e.name.text !== 'stored') fromDomainNames.add(e.name.text);
    }
  }
  const writes: TaskWrite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set') {
      let updatesTasks = false;
      for (let r: ts.Expression = node.expression.expression; ts.isCallExpression(r) && ts.isPropertyAccessExpression(r.expression);) {
        if (r.expression.name.text === 'update' && r.arguments[0]?.getText(ast) === 'tasks') updatesTasks = true;
        r = r.expression.expression;
      }
      if (updatesTasks) {
        const [fields] = node.arguments;
        let fromDomain = false;
        let setsStatus = false;
        const inspect = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fromDomainNames.has(n.expression.text)) fromDomain = true;
          if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name.getText(ast) === 'status') setsStatus = true;
          ts.forEachChild(n, inspect);
        };
        if (fields) inspect(fields);
        writes.push({ line: lineOf(ast, node), fn: enclosingFunction(node)?.name ?? '', fromDomain, setsStatus });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return writes;
}

/** What is wrong with each non-status task write of a source string: it neither takes its fields from the domain nor is on `plain`. */
function checkTaskWrites(source: string, plain: Record<string, string>): { found: string[]; used: string[] } {
  const found: string[] = [];
  const used: string[] = [];
  for (const w of findTaskWrites(source)) {
    if (w.setsStatus || w.fromDomain) continue;
    if (plain[w.fn]) used.push(w.fn);
    else
      found.push(
        `line ${w.line}: ${w.fn || 'no function'} writes a task without a rule from domain/: ` +
          'get the changes from a function in domain/work/lifecycle/task-writes.ts, or add the function to PLAIN_TASK_WRITES with its reason',
      );
  }
  return { found, used };
}

test('[task-writes] the finder fails a write that is neither from the domain nor on the list', () => {
  const sample =
    "import { prChanges } from '../domain/work/index.ts';\nfunction a() { orm.update(tasks).set({ ...prChanges(e) }).run(); }\n";
  assert.deepEqual(checkTaskWrites(sample, {}), { found: [], used: [] });
  const bare = 'function setTitle() { orm.update(tasks).set({ title }).where(x).run(); }';
  assert.equal(checkTaskWrites(bare, {}).found.length, 1);
  assert.match(checkTaskWrites(bare, {}).found[0], /^line 1: setTitle writes a task without a rule/);
  assert.deepEqual(checkTaskWrites(bare, { setTitle: 'a plain edit' }), { found: [], used: ['setTitle'] });
  assert.deepEqual(checkTaskWrites('function applyEvent() { orm.update(tasks).set({ status: to }).run(); }', {}), { found: [], used: [] });
});

test('[task-writes] a task write with a rule takes its changes from domain/, and a plain one is on the list with its reason', () => {
  const found: string[] = [];
  const used = new Set<string>();
  for (const s of sources.filter((s) => s.path.startsWith('db/'))) {
    const r = checkTaskWrites(s.ast.text, PLAIN_TASK_WRITES);
    found.push(...r.found.map((m) => `${s.path}:${m}`));
    for (const fn of r.used) used.add(fn);
  }
  const stale = Object.keys(PLAIN_TASK_WRITES)
    .filter((fn) => !used.has(fn))
    .map((fn) => `${fn} is on PLAIN_TASK_WRITES but no longer writes a task without a rule: remove the entry`);
  const noReason = Object.entries(PLAIN_TASK_WRITES)
    .filter(([, why]) => !why.trim())
    .map(([fn]) => `${fn} is on PLAIN_TASK_WRITES with no reason`);
  assert.deepEqual([...found, ...stale, ...noReason], []);
});

/** The tables whose rows reach the domain only through a mapper, and those mappers. */
const MAPPED_TABLES = ['tasks', 'repos', 'runs'];
const MAPPERS = ['toTask', 'toTaskSummary', 'toRepo', 'toRun'];
/** The query builder's calls that name a table. */
const TABLE_CALLS = ['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin', 'crossJoin', 'update', 'insert', 'delete'];

interface RowRead {
  line: number;
  tables: string[];
  mapped: boolean;
}

/**
 * Every read of a whole row of a mapped table in a source string: a `select` or `returning` with no columns, with a named set of them
 * (`TASK_COLUMNS`), or spreading one in, and any raw `SELECT *`. It is mapped when its chain goes on `.map(toTask)`, or its result is the
 * argument of a mapper or of `mapFound(…, toTask)`. A selection that lists its columns is a projection, not a row.
 */
function findRowReads(source: string): RowRead[] {
  const ast = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, string>();
  const collectAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const { expression, arguments: args } = node.initializer;
      if (expression.getText(ast) === 'alias' && args[0]) aliases.set(node.name.getText(ast), args[0].getText(ast));
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(ast);
  const tableOf = (node: ts.Node | undefined) => {
    const text = node?.getText(ast) ?? '';
    return aliases.get(text) ?? text;
  };
  const method = (call: ts.CallExpression) => (ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '');
  const isMapper = (node: ts.Node | undefined) => !!node && MAPPERS.includes(node.getText(ast));

  /** The calls before and after `call` in its chain, in order, and the last of them. */
  const chainOf = (call: ts.CallExpression) => {
    const calls = [call];
    for (let r = call.expression; ts.isPropertyAccessExpression(r) && ts.isCallExpression(r.expression); r = r.expression.expression)
      calls.unshift(r.expression);
    let last = call;
    while (ts.isPropertyAccessExpression(last.parent) && ts.isCallExpression(last.parent.parent)) {
      last = last.parent.parent;
      calls.push(last);
    }
    return { calls, last };
  };

  const reads: RowRead[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ['select', 'selectDistinct', 'returning'].includes(method(node))) {
      const { calls, last } = chainOf(node);
      const inChain = calls.filter((c) => TABLE_CALLS.includes(method(c))).map((c) => tableOf(c.arguments[0]));
      const [columns] = node.arguments;
      const whole =
        !columns || !ts.isObjectLiteralExpression(columns)
          ? inChain
          : columns.properties.filter(ts.isSpreadAssignment).flatMap(({ expression: e }) =>
              // `...getColumns(taskEvents)` is that table's row; any other spread could be anything in the chain.
              ts.isCallExpression(e) && e.expression.getText(ast) === 'getColumns' ? [tableOf(e.arguments[0])] : inChain,
            );
      const tables = [...new Set(whole)].filter((t) => MAPPED_TABLES.includes(t));
      if (tables.length) {
        const around = last.parent;
        const mapped =
          calls.some((c) => method(c) === 'map' && isMapper(c.arguments[0])) ||
          (ts.isCallExpression(around) &&
            around.expression !== last &&
            (isMapper(around.expression) || (around.expression.getText(ast) === 'mapFound' && isMapper(around.arguments[1]))));
        reads.push({ line: lineOf(ast, node), tables, mapped });
      }
    }
    const raw = literalText(node)?.match(new RegExp(String.raw`\bSELECT\s+(\w+\.)?\*\s+FROM\s+(${MAPPED_TABLES.join('|')}|\?)`, 'i'));
    if (raw) reads.push({ line: lineOf(ast, node), tables: [raw[2]], mapped: false });
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return reads;
}

test('[models-not-rows] the finder tells a mapped read from an unmapped one, and a row from a projection', () => {
  const read = (source: string) => findRowReads(source).map((r) => [r.tables, r.mapped]);
  for (const unmapped of [
    'orm.select().from(tasks).get();',
    'orm.select(TASK_COLUMNS).from(tasks).all() as Task[];',
    'orm.select({ ...getColumns(tasks) }).from(tasks).all();',
    'orm.select({ ...TASK_COLUMNS, n: count() }).from(tasks).all();',
    'orm.update(tasks).set({ title }).where(x).returning().get();',
    'const t = alias(tasks, "t"); orm.select().from(t).get();',
    'orm.select().from(taskEvents).innerJoin(tasks, x).all();',
    'const row = orm.select(TASK_COLUMNS).from(tasks).get(); use(row);',
    'orm.select().from(tasks).all().map((r) => r.id);',
    'first(orm.select().from(tasks).get(), toTask);',
    'db.prepare("SELECT * FROM tasks");',
    'sql`SELECT t.* FROM ${tasks} t`;',
  ])
    assert.equal(read(unmapped)[0]?.[1], false, unmapped);
  for (const mapped of [
    'orm.select().from(repos).all().map(toRepo);',
    'orm.select(SUMMARY_COLUMNS).from(tasks).all().map(toTaskSummary);',
    'mapFound(orm.select().from(repos).get(), toRepo);',
    'toRun(orm.insert(runs).values(v).returning().get());',
    'mapFound(orm.update(tasks).set(v).returning(TASK_COLUMNS).get(), toTask);',
  ])
    assert.equal(read(mapped)[0]?.[1], true, mapped);
  for (const notARow of [
    'orm.select({ id: tasks.id }).from(tasks).all();',
    'orm.update(tasks).set(v).returning({ status: tasks.status }).get();',
    'orm.select().from(reviews).all();',
    'orm.select({ ...getColumns(taskEvents), title: tasks.title }).from(taskEvents).innerJoin(tasks, x).all();',
    'db.prepare("SELECT id FROM tasks");',
  ])
    assert.deepEqual(read(notARow), [], notARow);
});

test('[models-not-rows] no store returns a whole row of tasks, repos or runs unmapped', () => {
  const reads = sources.filter((s) => s.path.startsWith('db/')).map((s) => ({ s, found: findRowReads(s.ast.text) }));
  const unmapped = reads.flatMap(({ s, found }) =>
    found
      .filter((r) => !r.mapped)
      .map((r) => `${at(s, r.line)} reads a whole row of ${r.tables.join(', ')} unmapped: go through db/mappers.ts, or list the columns`),
  );
  assert.deepEqual(unmapped, []);
  const seen = new Set(reads.flatMap(({ found }) => found.flatMap((r) => r.tables)));
  assert.deepEqual([...seen].sort(), [...MAPPED_TABLES].sort(), 'the finder should see the real reads of each mapped table');
});

test('[models-not-rows] domain entities have no flags or JSON documents beyond the shrinking list, and no entry is stale', () => {
  const { found, stale } = checkRowShapedFields(sources);
  assert.deepEqual([...found, ...stale], []);
});

test('[models-not-rows] a sample with a new row-shaped field fails; a stale entry fails too', () => {
  const sample = [
    parseSource(
      'domain/work/task/task.ts',
      'export interface Task {\n  a: number; // 1 = on\n  b: string; // JSON list\n  c: string;\n}\n',
    ),
  ];
  assert.deepEqual(checkRowShapedFields(sample, ['Task.a', 'Task.b']), { found: [], stale: [] });
  const fresh = checkRowShapedFields(sample, ['Task.a']);
  assert.equal(fresh.found.length, 1);
  assert.match(fresh.found[0], /^Task\.b /);
  const stale = checkRowShapedFields(sample, ['Task.a', 'Task.b', 'Task.c']);
  assert.equal(stale.stale.length, 1);
  assert.match(stale.stale[0], /^Task\.c is on ROW_SHAPED_FIELDS/);
});

test('[claude-process-group] claude runs only from adapters/claude/claude.ts, in its own process group', () => {
  // So crash recovery can stop the whole process tree by its pid.
  const found: string[] = [];
  for (const s of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && /^(spawn|exec|execFile|fork)(Sync)?$/.test(node.expression.getText(s.ast))) {
        const [bin, , options = node.arguments[1]] = node.arguments;
        if (bin?.getText(s.ast).includes('claudeBin')) {
          const where = `${at(s, lineOf(s.ast, node))} starts claude`;
          if (s.path !== 'adapters/claude/claude.ts') found.push(`${where} outside adapters/claude/claude.ts`);
          if (!options || !/\bdetached:\s*true\b/.test(options.getText(s.ast))) found.push(`${where} without detached: true`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  assert.deepEqual(found, []);
});

// Shipped migration steps never change. Each line of migrations.lock is the schema a fresh database has after that step.
const LOCK = join(import.meta.dirname, '../db/migrations.lock');

function schemaAfterEachStep(): string[] {
  return MIGRATIONS.map((_, i) => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, i + 1));
    const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    db.close();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  });
}

test('[migrations-append] shipped migration steps are unchanged', () => {
  const locked = readFileSync(LOCK, 'utf8').split('\n').filter(Boolean);
  const actual = schemaAfterEachStep();
  const found: string[] = [];
  for (const [i, hash] of locked.entries()) {
    if (actual[i] === undefined) found.push(`step ${i + 1} is in ${relative(process.cwd(), LOCK)} but no longer in MIGRATIONS`);
    else if (actual[i] !== hash) found.push(`step ${i + 1} changed the schema it leaves behind; append a new step instead`);
  }
  for (let i = locked.length; i < actual.length; i++) {
    found.push(`step ${i + 1} is new: once it is final, append \`${actual[i]}\` to ${relative(process.cwd(), LOCK)}`);
  }
  assert.deepEqual(found, []);
});

/** The last step that renames or drops. Step 29's rename crashed the running daemon's worker for task 204. */
const LAST_BREAKING_STEP = 29;

/** The 1-based numbers of the steps after `after` that rename or drop. A function step is judged by its source. */
const breakingSteps = (steps: readonly unknown[], after: number): number[] =>
  steps.flatMap((step, i) => (i >= after && /\b(RENAME|DROP)\b/i.test(String(step)) ? [i + 1] : []));

test('[migrations-append] a new migration step only adds', () => {
  // Any process migrates when it opens the database, so the CLI on freshly pulled code migrates while a daemon on older code runs.
  const found = breakingSteps(MIGRATIONS, LAST_BREAKING_STEP).map(
    (n) => `step ${n} renames or drops: a daemon still on older code would fail its queries. Add a column and stop reading the old one`,
  );
  assert.deepEqual(found, []);
});

test('[migrations-append] the additive check finds renames and drops, in SQL and in function steps', () => {
  const steps = [
    'ALTER TABLE a RENAME COLUMN b TO c;',
    'ALTER TABLE a ADD COLUMN d TEXT;',
    'alter table a drop column d;',
    () => 'DROP TABLE a',
  ];
  assert.deepEqual(breakingSteps(steps, 0), [1, 3, 4]);
  assert.deepEqual(breakingSteps(steps, 1), [3, 4]);
});

/** Module-level state in application/ that is allowed, each with why. Keys are `<file>:<name>`. */
const ALLOWED_MODULE_STATE: Record<string, string> = {
  'application/work/checkout-locks.ts:syncing':
    'the sync lock: a task being synced in this process; the database is the state the processes share',
  'application/proposals/planner.ts:proposing': 'the propose lock: a repo being planned in this process',
  'application/work/checkout-locks.ts:merging': 'the merge lock: a task being merged in this process',
  'application/landing/settle.ts:following':
    'the follow-up lock: history rows whose follow-ups run in this process; the outbox in the database is what the processes share',
  'application/work/files.ts:changedCache': 'a cache of immutable diff results: the same two commits always differ the same way',
  'application/work/files.ts:mergeCache': 'a cache of immutable merges: the same two commits always merge to the same commit',
  'application/work/proposal-check.ts:stalenessCache':
    'a cache of immutable staleness results: the same task, base commit and prompt always come to the same commits and paths',
};

const MUTATORS = /^(set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/;

test('[no-module-state] application/ keeps no module-level state except a lock or a cache of immutable results', () => {
  const found: string[] = [];
  const used = new Set<string>();
  for (const s of sources.filter((s) => s.path.startsWith('application/'))) {
    const collections = new Set<string>();
    for (const stmt of s.ast.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      const isLet = !(stmt.declarationList.flags & ts.NodeFlags.Const);
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const key = `${s.path}:${d.name.text}`;
        let init = d.initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)))
          init = init.expression;
        const isCollection =
          !!init &&
          (ts.isArrayLiteralExpression(init) ||
            (ts.isNewExpression(init) && ['Map', 'Set', 'WeakMap', 'WeakSet', 'Array'].includes(init.expression.getText(s.ast))));
        if (isLet) {
          if (ALLOWED_MODULE_STATE[key]) used.add(key);
          else
            found.push(
              `${at(s, lineOf(s.ast, d))} declares module-level let ${d.name.text}: application code keeps no state between calls`,
            );
        } else if (isCollection) collections.add(d.name.text);
      }
    }
    const changed = new Map<string, number>();
    const visit = (node: ts.Node) => {
      let target: ts.Expression | null = null;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && MUTATORS.test(node.expression.name.text))
        target = node.expression.expression;
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isElementAccessExpression(node.left)) target = node.left.expression;
        else if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'length') target = node.left.expression;
      }
      if (target && ts.isIdentifier(target) && collections.has(target.text) && !changed.has(target.text))
        changed.set(target.text, lineOf(s.ast, node));
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
    for (const [name, line] of changed) {
      const key = `${s.path}:${name}`;
      if (ALLOWED_MODULE_STATE[key]) used.add(key);
      else
        found.push(`${at(s, line)} changes module-level ${name}: application code keeps no state between calls, except a lock or a cache`);
    }
  }
  for (const key of Object.keys(ALLOWED_MODULE_STATE))
    if (!used.has(key)) found.push(`${key} is on the allow list but no longer module state`);
  assert.deepEqual(found, []);
});
