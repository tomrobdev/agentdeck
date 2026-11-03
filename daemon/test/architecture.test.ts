// The Boundaries and Rules in CLAUDE.md, checked against the source. Each failure names the file, the line and the rule.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import ts from 'typescript';
import { type Source, lineOf, readSources } from '../scripts/lib/sources.ts';
import { MIGRATIONS, migrate } from '../src/db/index.ts';

const SRC = join(import.meta.dirname, '../src');

const sources = readSources(SRC);

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
  { match: /^drizzle-orm(\/|$)/, allowed: (p) => p.startsWith('db/'), why: 'Drizzle is the db layer, for db/ only' },
  { match: /^(?!node:)/, allowed: () => false, why: 'no runtime dependencies' },
];

const at = (s: Source, line: number) => `${s.path}:${line}`;

test('[layers, domain-pure, adapters-io, entry-points] each layer imports only the layers below it', () => {
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

test('[contract-types] api/contract.ts imports nothing', () => {
  const contract = sources.find((s) => s.path === 'api/contract.ts')!;
  assert.deepEqual(
    contract.imports.map((i) => `${at(contract, i.line)} imports ${i.spec}`),
    [],
  );
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

/** The method or function a node is in, looking past the arrow functions inside it. */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) return n;
  }
  return undefined;
}

test('[guarded-status] a task status changes only through a guarded transition', () => {
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

test('[claude-process-group] claude runs only from adapters/claude.ts, in its own process group', () => {
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

/** Module-level state in application/ that is allowed, each with why. Keys are `<file>:<name>`. */
const ALLOWED_MODULE_STATE: Record<string, string> = {
  'application/sync.ts:syncing': 'the sync lock: a task being synced in this process; the database is the state the processes share',
  'application/planner.ts:proposing': 'the propose lock: a repo being planned in this process',
  'application/pull-request/merge-lock.ts:merging': 'the merge lock: a task being merged in this process',
  'application/task/files.ts:changedCache': 'a cache of immutable diff results: the same two commits always differ the same way',
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

// Domain language: "hold" is the governor's word (domain/usage/, the scheduler's announcement, the `hold` notification kind).
const HOLD = /\b(hold|holds|holding|held)\b/i;

const PLAIN = 'plain English: a thing contains, keeps or presses something';
/** Lines that may say hold: the governor's, and the plain-English senses. Paths are under daemon/src/, or app/src/ when prefixed. */
const HOLD_ALLOWED: { file: string; line: RegExp; why: string }[] = [
  { file: 'domain/notification.ts', line: /governor hold|'hold'/, why: 'the `hold` notification kind' },
  { file: 'api/contract.ts', line: /'hold'/, why: 'the `hold` notification kind' },
  { file: 'adapters/notify.ts', line: /^\s*hold:/, why: 'the `hold` notification kind' },
  { file: 'db/schema.ts', line: /`hold`|,hold,/, why: 'migration 16 is about the `hold` notification kind' },
  { file: 'app/src/components/panels/SettingsPanel.vue', line: /kind === 'hold'/, why: 'the `hold` notification kind' },
  { file: 'app/src/api/format.ts', line: /^\s*hold: /, why: 'the `hold` notification kind' },
  { file: 'app/src/components/panels/BudgetSettings.vue', line: /Hold new tasks above/, why: 'the governor budget setting' },
  { file: 'domain/task/digest.ts', line: /governor on hold/, why: 'the governor' },
  { file: 'domain/task/start.ts', line: /governor holds/, why: 'the governor' },
  { file: 'application/scheduler/scheduler.ts', line: /^(?!.*caffeinate)/, why: "the scheduler's hold announcement" },
  { file: 'cli/daemon.ts', line: /on hold|HOLD:/, why: "the governor's state, shown" },
  { file: 'app/src/api/format.ts', line: /On hold/, why: "the governor's state, shown" },
  { file: 'app/src/components/layout/StatusBar.vue', line: /On hold/, why: "the governor's state, shown" },
  { file: 'app/src/App.vue', line: /hold lifting/, why: "the governor's hold lifting" },
  { file: 'domain/run/run.ts', line: /it holds the old prompt/, why: PLAIN },
  { file: 'domain/run/prompt.ts', line: /holds the same comments|already holds the task|files hold conflict markers/, why: PLAIN },
  { file: 'domain/task/needs.ts', line: /A task holds it/, why: PLAIN },
  { file: 'domain/task/listing.ts', line: /PRs that hold up other/, why: PLAIN },
  { file: 'domain/task/stage.ts', line: /Done holds every/, why: PLAIN },
  { file: 'domain/daemon/health.ts', line: /another daemon holds port/, why: PLAIN },
  { file: 'domain/plan/plan.ts', line: /that holds AgentDeck's files/, why: PLAIN },
  { file: 'application/sync.ts', line: /sync in this process holds/, why: PLAIN },
  { file: 'api/contract.ts', line: /holds the use cases to/, why: PLAIN },
  { file: 'db/tasks.ts', line: /Later pages hold older tasks/, why: PLAIN },
  { file: 'db/sql.ts', line: /caller already holds/, why: PLAIN },
  { file: 'adapters/git.ts', line: /branch holds all its work|still hold conflict markers/, why: PLAIN },
  { file: 'app/src/lib/forms.ts', line: /panels only hold the form/, why: PLAIN },
  { file: 'app/src/components/task/TaskPage.vue', line: /Dialogs hold the Escape key/, why: PLAIN },
  { file: 'app/src/components/task/ChangesTab.vue', line: /maps only hold what/, why: PLAIN },
  { file: 'app/src/lib/queueDisplay.ts', line: /Done now, which holds the finished history/, why: PLAIN },
  { file: 'application/scheduler/scheduler.ts', line: /Hold a `caffeinate/, why: PLAIN },
  { file: 'app/src/platform/native.ts', line: /`copied` holds the key/, why: PLAIN },
];

test('[domain-language] "hold" is used only for the governor, the `hold` notification kind, and plain-English senses', () => {
  const found: string[] = [];
  const used = new Set<(typeof HOLD_ALLOWED)[number]>();
  const roots = [
    { dir: SRC, prefix: '' },
    { dir: join(import.meta.dirname, '../../app/src'), prefix: 'app/src/' },
  ];
  for (const { dir, prefix } of roots) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(ts|vue|css)$/.test(f)) continue;
      const path = prefix + f;
      if (path.startsWith('domain/usage/')) continue;
      for (const [i, line] of readFileSync(join(dir, f), 'utf8').split('\n').entries()) {
        if (!HOLD.test(line)) continue;
        const ok = HOLD_ALLOWED.find((a) => a.file === path && a.line.test(line));
        if (ok) used.add(ok);
        else found.push(`${path}:${i + 1} says hold: that is the governor's word; say wait or keep (or add the sense to HOLD_ALLOWED)`);
      }
    }
  }
  for (const a of HOLD_ALLOWED) if (!used.has(a)) found.push(`${a.file} ${a.line} is on the allow list but matches no line`);
  assert.deepEqual(found, []);
});
