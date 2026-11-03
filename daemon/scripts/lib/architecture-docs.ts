// Builds the generated blocks of docs/architecture.md from the code. Deterministic: sorted, no timestamps.
// `renderDocs` replaces the blocks between `<!-- generated:NAME -->` and `<!-- /generated -->` and leaves the rest alone.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import ts from 'typescript';
import { SETTING_DEFAULTS } from '../../src/db/settings.ts';
import * as tables from '../../src/db/tables.ts';
import { RULES, TASK_STATUSES, type TaskStatus } from '../../src/domain/task/lifecycle.ts';
import { type Source, readSources } from './sources.ts';

const SRC = join(import.meta.dirname, '../../src');
export const DOCS_PATH = join(import.meta.dirname, '../../../docs/architecture.md');

/** What each setting means. A setting with no entry here fails the docs, so a new one gets described. */
const SETTING_MEANINGS: Record<string, string> = {
  paused: 'The daemon starts no new work while this is 1; it starts paused until someone resumes it',
  rate_limited_until: 'Unix seconds until which a run that hit the usage limit keeps new work from starting; 0 for none',
  pr_check_requested: 'Set to 1 to have the scheduler check open pull requests on its next tick',
  reload_on_change: 'Restart the daemon onto new code when daemon/src changes and nothing is running',
  max_concurrent: 'Slots: how many tasks may run at once',
  notify_desktop: 'Show desktop notifications',
  notify_events: 'The notification kinds to send, comma-separated',
  ntfy_topic: 'The ntfy topic to push notifications to; empty for none',
  ntfy_server: 'The ntfy server',
  planner_enabled: "Let the planner propose tasks when a repo's queue runs dry",
  planner_interval_hours: 'The fewest hours between two planner runs on a repo',
  planner_max_tasks: 'The most proposals one planner run keeps',
  planner_model: 'The model the planner runs with',
  five_hour_max: 'Governor: no new work above this share of the 5-hour window',
  five_hour_soft: 'Governor: one task at a time above this share of the 5-hour window',
  weekly_max: 'Governor: the share of the 7-day window the weekly allowance grows to',
  pace_slack: 'Governor: how far ahead of the even weekly pace spending may run',
};

const ident = (s: string) => s.replace(/\W/g, '_');
const escapeCell = (s: string) => s.replace(/\|/g, '\\|');

/** A markdown table laid out as Prettier lays it out, so the file stays formatted. */
function table(headers: string[], rows: string[][]): string {
  const cells = [headers, ...rows].map((r) => r.map(escapeCell));
  const widths = headers.map((_, i) => Math.max(3, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(cells[0]), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

const mermaid = (body: string[]) => ['```mermaid', ...body, '```'].join('\n');

/** The layer a file belongs to: its top folder under src/, or the file itself for `config.ts`, `daemon.ts` and `cli.ts`. */
const layerOf = (path: string) => (path.includes('/') ? path.split('/')[0] : path);

function layers(sources: Source[]): string {
  const count = new Map<string, number>();
  const names = new Set<string>();
  for (const s of sources) {
    names.add(layerOf(s.path));
    for (const i of s.imports) {
      if (!i.target || layerOf(i.target) === layerOf(s.path)) continue;
      const key = `${layerOf(s.path)}\0${layerOf(i.target)}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const edges = [...count]
    .map(([key, n]) => ({ from: key.split('\0')[0], to: key.split('\0')[1], n }))
    .sort((a, b) => cmp(a.from + a.to, b.from + b.to));
  return mermaid([
    'flowchart TD',
    ...[...names].sort().map((n) => `  ${ident(n)}["${n}"]`),
    // No counts on the edges: they changed with almost every PR and said little.
    ...edges.map((e) => `  ${ident(e.from)} --> ${ident(e.to)}`),
  ]);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function dataModel(): string {
  const configs = Object.values(tables)
    .map((t) => getTableConfig(t))
    .sort((a, b) => cmp(a.name, b.name));
  const lines = ['erDiagram'];
  const relations: string[] = [];
  const tableNames = new Set(configs.map((c) => c.name));
  for (const c of configs) {
    const fks = c.foreignKeys.map((fk) => fk.reference());
    const fkColumns = new Set(fks.flatMap((r) => r.columns.map((col) => col.name)));
    const pkColumns = new Set([
      ...c.columns.filter((col) => col.primary).map((col) => col.name),
      ...c.primaryKeys.flatMap((pk) => pk.columns.map((col) => col.name)),
    ]);
    lines.push(`  ${c.name} {`);
    for (const col of c.columns) {
      const keys = [pkColumns.has(col.name) && 'PK', fkColumns.has(col.name) && 'FK'].filter(Boolean).join(',');
      lines.push(`    ${col.getSQLType()} ${col.name}${keys ? ` ${keys}` : ''}${col.notNull ? '' : ' "nullable"'}`);
    }
    lines.push('  }');
    for (const r of fks) {
      const col = r.columns[0];
      relations.push(
        `  ${getTableConfig((r.foreignColumns[0] as unknown as { table: SQLiteTable }).table).name} ${col.notNull ? '||' : '|o'}--o{ ${c.name} : "${col.name}"`,
      );
    }
    // A column that names another row but has no foreign key: shown dotted so the missing key is visible.
    for (const col of c.columns) {
      if (fkColumns.has(col.name) || !(col.name.endsWith('_id') || col.name === 'after_task')) continue;
      const parent = col.name === 'after_task' ? 'tasks' : `${col.name.slice(0, -3)}s`;
      if (!tableNames.has(parent)) continue; // e.g. session_id names a claude session, not a row
      relations.push(`  ${parent} ${col.notNull ? '||' : '|o'}..o{ ${c.name} : "${col.name}"`);
    }
  }
  return mermaid([...lines, ...relations.sort()]);
}

function lifecycle(): string {
  // A run-ending event is one that also applies to a cancel_requested task (the cancel wins there).
  const runEnds = Object.entries(RULES)
    .filter(([, r]) => r.cancel_requested)
    .map(([key]) => key)
    .sort();
  const edges = new Map<string, string[]>();
  for (const [event, rule] of Object.entries(RULES)) {
    for (const [from, to] of Object.entries(rule)) edges.set(`${from}\0${to}`, [...(edges.get(`${from}\0${to}`) ?? []), event]);
  }
  const order = (s: string) => TASK_STATUSES.indexOf(s as TaskStatus);
  const lines = [...edges]
    .map(([key, events]) => {
      const [from, to] = key.split('\0');
      const label = events.length === runEnds.length && [...events].sort().join() === runEnds.join() ? 'any run end' : events.join(', ');
      return { from, to, label: label.replace(/:/g, '/') };
    })
    .sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to))
    .map((e) => `  ${e.from} --> ${e.to}: ${e.label}`);
  return mermaid(['stateDiagram-v2', ...lines]);
}

/** `/^\/api\/tasks\/(\d+)\/links$/` → `/api/tasks/:id/links`. */
function routePath(regex: string): string {
  let n = 0;
  return regex
    .replace(/^\^|\$$/g, '')
    .replace(/\\\//g, '/')
    .replace(/\(\\d\+\)/g, () => (n++ ? `:id${n}` : ':id'));
}

function routes(): string {
  const rows: string[][] = [];
  for (const s of readSources(join(SRC, 'api/routes'))) {
    const locals = new Map<string, ts.Node>();
    const imported = new Set<string>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) locals.set(node.name.text, node.initializer);
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings))
        for (const e of node.importClause.namedBindings.elements) imported.add(e.name.text);
      ts.forEachChild(node, collect);
    };
    collect(s.ast);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'route') {
        const [method, path, handler] = node.arguments;
        if (ts.isStringLiteral(method) && ts.isRegularExpressionLiteral(path)) {
          rows.push([method.text, `\`${routePath(path.text.slice(1, path.text.lastIndexOf('/')))}\``, useCases(handler, locals, imported)]);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  rows.sort((a, b) => cmp(a[1], b[1]) || cmp(a[0], b[0]));
  return table(['Method', 'Path', 'Use case'], rows);
}

/** The `actions.x` and `db.x` calls a handler makes, looking into the local helpers it calls; else the imported functions it calls. */
function useCases(handler: ts.Node, locals: Map<string, ts.Node>, imported: Set<string>): string {
  const found = new Set<string>();
  const others = new Set<string>();
  const seen = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ['actions', 'db'].includes(callee.expression.text))
        found.add(`${callee.expression.text}.${callee.name.text}`);
      else if (ts.isIdentifier(callee)) {
        const local = locals.get(callee.text);
        if (local && !seen.has(callee.text)) (seen.add(callee.text), visit(local));
        else if (imported.has(callee.text)) others.add(callee.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
  return [...(found.size ? found : others)].map((n) => `\`${n}\``).join(', ');
}

function settings(): string {
  const keys = Object.keys(SETTING_DEFAULTS).sort();
  const missing = keys.filter((k) => !(k in SETTING_MEANINGS));
  if (missing.length)
    throw new Error(`docs: describe these settings in SETTING_MEANINGS (scripts/lib/architecture-docs.ts): ${missing.join(', ')}`);
  const stale = Object.keys(SETTING_MEANINGS).filter((k) => !(k in SETTING_DEFAULTS));
  if (stale.length) throw new Error(`docs: SETTING_MEANINGS describes settings that no longer exist: ${stale.join(', ')}`);
  return table(
    ['Setting', 'Default', 'Meaning'],
    keys.map((k) => [`\`${k}\``, SETTING_DEFAULTS[k] === '' ? '(empty)' : `\`${SETTING_DEFAULTS[k]}\``, SETTING_MEANINGS[k]]),
  );
}

function migrations(sources: Source[]): string {
  const ast = sources.find((s) => s.path === 'db/schema.ts')!.ast;
  const text = ast.getFullText();
  let list: ts.ArrayLiteralExpression | undefined;
  const find = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'MIGRATIONS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    )
      list = node.initializer;
    ts.forEachChild(node, find);
  };
  find(ast);
  if (!list) throw new Error('docs: MIGRATIONS is not an array literal in db/schema.ts');
  const rows = list.elements.map((el, i) => {
    const comment = (ts.getLeadingCommentRanges(text, el.getFullStart()) ?? [])
      .map((c) =>
        text
          .slice(c.pos, c.end)
          .replace(/^\/\/\s?/, '')
          .trim(),
      )
      .join(' ')
      .replace(/^\d+:\s*/, '');
    return [String(i + 1), comment];
  });
  return table(['Step', 'What it does'], rows);
}

/** Every generated block, by name. */
export function generateBlocks(): Record<string, string> {
  const sources = readSources(SRC);
  return {
    layers: layers(sources),
    'data-model': dataModel(),
    lifecycle: lifecycle(),
    routes: routes(),
    settings: settings(),
    migrations: migrations(sources),
  };
}

const BLOCK = /<!-- generated:([\w-]+) -->\n[^]*?<!-- \/generated -->/g;

/** `markdown` with every generated block replaced by what the code says now. */
export function renderDocs(markdown: string): string {
  const blocks = generateBlocks();
  const used = new Set<string>();
  const out = markdown.replace(BLOCK, (_, name: string) => {
    if (!(name in blocks)) throw new Error(`docs: unknown generated block "${name}"`);
    used.add(name);
    return `<!-- generated:${name} -->\n\n${blocks[name]}\n\n<!-- /generated -->`;
  });
  const missing = Object.keys(blocks).filter((n) => !used.has(n));
  if (missing.length) throw new Error(`docs: docs/architecture.md has no <!-- generated:NAME --> block for: ${missing.join(', ')}`);
  return out;
}

export const readDocs = () => readFileSync(DOCS_PATH, 'utf8');

/** The text of a `## heading` section of the docs, up to the next `## `. */
export function section(markdown: string, heading: string): string {
  const m = new RegExp(`^## ${heading}\\n([^]*?)(?=^## |(?![^]))`, 'm').exec(markdown);
  if (!m) throw new Error(`docs: docs/architecture.md has no "## ${heading}" section`);
  return m[1];
}
