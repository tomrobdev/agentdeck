// The Boundaries and Rules in CLAUDE.md, checked against the source. Each failure names the file, the line and the rule.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import ts from 'typescript';
import { MIGRATIONS, migrate } from '../src/db/index.ts';

const SRC = join(import.meta.dirname, '../src');

interface Import {
  spec: string;
  /** The imported file relative to src/, or null for a package. */
  target: string | null;
  line: number;
  typeOnly: boolean;
}

interface Source {
  /** Relative to src/, e.g. `domain/task/task.ts`. */
  path: string;
  ast: ts.SourceFile;
  imports: Import[];
}

function lineOf(ast: ts.SourceFile, node: ts.Node): number {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

const sources: Source[] = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((path) => {
    const ast = ts.createSourceFile(path, readFileSync(join(SRC, path), 'utf8'), ts.ScriptTarget.Latest, true);
    return { path, ast, imports: importsOf(path, ast) };
  });

function importsOf(path: string, ast: ts.SourceFile): Import[] {
  const out: Import[] = [];
  const add = (node: ts.Node, spec: ts.Expression, typeOnly: boolean) => {
    if (!ts.isStringLiteral(spec)) return;
    const target = spec.text.startsWith('.') ? join(dirname(path), spec.text) : null;
    out.push({ spec: spec.text, target, line: lineOf(ast, node), typeOnly });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allTypes =
        !!clause &&
        (clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.every((e) => e.isTypeOnly)));
      add(node, node.moduleSpecifier, allTypes);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const allTypes = node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly));
      add(node, node.moduleSpecifier, allTypes);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      add(node, node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

/** The layer a file belongs to: its top folder under src/, or the file itself for `config.ts`, `daemon.ts` and `cli.ts`. */
const layerOf = (path: string) => (path.includes('/') ? path.split('/')[0] : path);

/** Which layers each layer may import, and why. Imports point down the list in CLAUDE.md's Boundaries. */
const MAY_IMPORT: Record<string, { layers: string[]; why: string }> = {
  domain: { layers: ['domain'], why: 'domain/ is pure and imports no other layer' },
  'config.ts': { layers: [], why: 'config.ts is read by every layer and imports none' },
  db: { layers: ['db', 'domain', 'config.ts'], why: 'db/ holds the SQL and knows only the domain' },
  adapters: {
    layers: ['adapters', 'domain', 'config.ts'],
    why: 'adapters import domain/ and config.ts only; they report through callbacks',
  },
  application: {
    layers: ['application', 'adapters', 'db', 'domain', 'config.ts'],
    why: 'application/ is never imported by db/ or adapters/',
  },
  api: { layers: ['api', 'application', 'db', 'domain', 'config.ts'], why: 'entry points reach adapters through application/' },
  cli: {
    layers: ['cli', 'api', 'application', 'db', 'domain', 'config.ts', 'daemon.ts'],
    why: 'entry points reach adapters through application/',
  },
  'daemon.ts': {
    layers: ['api', 'application', 'adapters', 'db', 'domain', 'config.ts'],
    why: 'the composition root does not use the CLI',
  },
  'cli.ts': { layers: ['cli', 'application', 'db', 'config.ts'], why: 'cli.ts only dispatches to cli/' },
};

/** Packages, and the only files that may import them. */
const PACKAGES: { match: RegExp; allowed: (path: string) => boolean; why: string }[] = [
  { match: /^node:sqlite$/, allowed: (p) => p.startsWith('db/'), why: 'SQL lives only in db/' },
  { match: /^node:child_process$/, allowed: (p) => p.startsWith('adapters/'), why: 'processes are started by adapters/' },
  { match: /^node:/, allowed: (p) => !p.startsWith('domain/'), why: 'domain/ is pure: no I/O' },
  { match: /^drizzle-orm(\/|$)/, allowed: (p) => p === 'db/tables.ts', why: 'Drizzle is dev tooling, for db/tables.ts only' },
  { match: /^(?!node:)/, allowed: () => false, why: 'no runtime dependencies' },
];

const at = (s: Source, line: number) => `${s.path}:${line}`;

test('each layer imports only the layers below it', () => {
  const found: string[] = [];
  for (const s of sources) {
    const rule = MAY_IMPORT[layerOf(s.path)];
    assert.ok(rule, `${s.path} is in no known layer; add it to MAY_IMPORT`);
    for (const i of s.imports) {
      if (!i.target) continue;
      const to = layerOf(i.target);
      if (to !== layerOf(s.path) && !rule.layers.includes(to)) found.push(`${at(s, i.line)} imports ${i.target}: ${rule.why}`);
    }
  }
  assert.deepEqual(found, []);
});

test('api/contract.ts imports nothing', () => {
  const contract = sources.find((s) => s.path === 'api/contract.ts')!;
  assert.deepEqual(
    contract.imports.map((i) => `${at(contract, i.line)} imports ${i.spec}`),
    [],
  );
});

test('packages are imported only where they belong', () => {
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

test('db/tables.ts is imported only for its types', () => {
  // Drizzle at runtime is deferred until 1.0 is stable (docs/plans/drizzle.html).
  const found = sources.flatMap((s) =>
    s.imports.filter((i) => i.target === 'db/tables.ts' && !i.typeOnly).map((i) => `${at(s, i.line)} imports db/tables.ts at runtime`),
  );
  assert.deepEqual(found, []);
});

test('there are no import cycles', () => {
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

test('domain/ reads no clock, randomness or environment, except as a parameter default', () => {
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

test('SQL runs only in db/', () => {
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

/** The text of a string or template literal, with each `${…}` as `?`. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `?${s.literal.text}`).join('');
  return null;
}

/** The method or function a node is in, looking past the arrow functions inside it. */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) return n;
  }
  return undefined;
}

test('a task status changes only through a guarded transition', () => {
  // Every status write is an `UPDATE … WHERE status …` in a function that asks the lifecycle for the next status.
  const found: string[] = [];
  for (const s of sources.filter((s) => s.path.startsWith('db/'))) {
    const visit = (node: ts.Node) => {
      const text = literalText(node);
      if (text !== null) {
        const update = /UPDATE\s+tasks\s+SET\b([^]*?)(\bWHERE\b|$)/i.exec(text);
        const writes = update ? /(^|,)\s*status\s*=/i.test(update[1]) : /^\s*status\s*=/i.test(text);
        if (writes) {
          const where = `${at(s, lineOf(s.ast, node))} writes a task status`;
          const fn = enclosingFunction(node);
          if (!/\b(nextStatus|transition)\(/.test(fn?.body?.getText(s.ast) ?? ''))
            found.push(`${where} without asking the lifecycle (domain/task/lifecycle.ts)`);
          if (update && !/\bWHERE\b[^]*\bstatus\s*(IN\s*\(|=)/i.test(text)) found.push(`${where} without a WHERE on the status`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  assert.deepEqual(found, []);
});

test('claude runs only from adapters/claude.ts, in its own process group', () => {
  // So crash recovery can stop the whole process tree by its pid.
  const found: string[] = [];
  for (const s of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && /^(spawn|exec|execFile|fork)(Sync)?$/.test(node.expression.getText(s.ast))) {
        const [bin, , options = node.arguments[1]] = node.arguments;
        if (bin?.getText(s.ast).includes('claudeBin')) {
          const where = `${at(s, lineOf(s.ast, node))} starts claude`;
          if (s.path !== 'adapters/claude.ts') found.push(`${where} outside adapters/claude.ts`);
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
const LOCK = join(import.meta.dirname, 'migrations.lock');

function schemaAfterEachStep(): string[] {
  return MIGRATIONS.map((_, i) => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, i + 1));
    const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    db.close();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  });
}

test('shipped migration steps are unchanged', () => {
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
