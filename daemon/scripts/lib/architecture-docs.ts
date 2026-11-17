// Builds the generated blocks of docs/architecture.md from the code. Deterministic: sorted, no timestamps.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import ts from 'typescript';
import { SETTING_DEFAULTS } from '#db/operations/settings.ts';
import { LAYERS, layerOf, mayImport } from '#scripts/lib/layers.ts';
import * as tables from '#db/tables.ts';
import { RULES, TASK_STATUSES, type TaskStatus } from '#domain/work/lifecycle/lifecycle.ts';
import { dashboardBody, dashboardReference } from '#scripts/lib/dashboard-layout.ts';
import { adapterUse, contextMap } from '#scripts/lib/graphs.ts';
import { modelsBody, stateMachinesBody, useCasesBody } from '#scripts/lib/model-docs.ts';
import { COVERAGE_FLOORS, progress } from '#scripts/lib/progress.ts';
import { UNCHECKED } from '#scripts/lib/rules.ts';
import { readStrictnessOffences } from '#scripts/lib/strictness.ts';
import { type Source, readSources } from '#scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../../src');
export const DOCS_PATH = join(import.meta.dirname, '../../../docs/architecture.md');

const SETTING_MEANINGS: Record<string, string> = {
  paused: 'The daemon starts no new work while this is 1; it starts paused until someone resumes it',
  rate_limited_until: 'Unix seconds until which a run that hit the usage limit keeps new work from starting; 0 for none',
  pr_check_requested: 'Set to 1 to have the scheduler check open pull requests on its next tick',
  app_seen_at:
    'When the desktop app last said it is running (ms since the epoch); within 90 s of it the app shows desktop notifications and osascript is skipped',
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
  default_model: "The model a new task takes when neither it nor its repo names one (a repo's own is repos.model)",
  support_model: 'The model resolve and unblock runs use, in place of their task’s',
  review_model: 'The model review runs use: a reviewer at least as strong as the worker',
  review_due_days: 'A repo is due for an area review once its oldest refs/reviewed/* mark is older than this many days',
  review_due_lines:
    'A repo is due for an area review once more than this many lines merged since its oldest mark (or, with none, since it was added)',
  reviews_due: 'The repos due for an area review as the daemon’s last check found them (JSON), for the headline',
  review_due_told:
    'When a person was last told each repo is due for an area review (JSON of repo id to ms since the epoch); at most once a day',
  five_hour_max: 'Governor: no new work above this share of the 5-hour window',
  five_hour_soft: 'Governor: one task at a time above this share of the 5-hour window',
  weekly_max: 'Governor: the share of the 7-day window the weekly allowance grows to',
  pace_slack: 'Governor: how far ahead of the even weekly pace spending may run',
};

const ident = (s: string) => s.replace(/\W/g, '_');
const escapeCell = (s: string) => s.replace(/\|/g, '\\|');

function table(headers: string[], rows: string[][]): string {
  const cells = [headers, ...rows].map((r) => r.map(escapeCell));
  const widths = headers.map((_, i) => Math.max(3, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(cells[0]), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

const mermaid = (body: string[]) => ['```mermaid', ...body, '```'].join('\n');

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function layers(sources: Source[]): string {
  const names = Object.keys(LAYERS);
  const outside = new Map<string, string[]>();
  for (const s of sources) {
    for (const i of s.imports) {
      if (!i.target || mayImport(layerOf(s.path), layerOf(i.target))) continue;
      const key = `${layerOf(s.path)}\0${layerOf(i.target)}`;
      outside.set(key, [...(outside.get(key) ?? []), `${s.path}:${i.line}`]);
    }
  }
  const label = (n: string) => (n.endsWith('.ts') ? n : `${n}/`);
  const rows = names.map((n) => [
    `\`${label(n)}\``,
    LAYERS[n].holds,
    LAYERS[n].imports.length ? LAYERS[n].imports.map((l) => `\`${label(l)}\``).join(', ') : 'nothing',
    LAYERS[n].why,
  ]);
  const allowed = names.filter((n) => LAYERS[n].imports.length).map((n) => `  ${ident(n)} --> ${LAYERS[n].imports.map(ident).join(' & ')}`);
  const called = [...outside].map(([key, where]) => {
    const [from, to] = key.split('\0');
    return `- \`${label(from)}\` imports \`${label(to)}\`, outside the rule: ${where.map((w) => `\`${w}\``).join(', ')}`;
  });
  return [
    table(['Layer', 'Holds', 'May import', 'Why'], rows),
    mermaid(['flowchart TD', ...names.map((n) => `  ${ident(n)}["${label(n)}"]`), ...allowed]),
    called.length
      ? `Imports outside the rule (the architecture test fails on these):\n\n${called.join('\n')}`
      : 'No import falls outside the rule.',
  ].join('\n\n');
}

function firstSentence(source: Source): string {
  const lines: string[] = [];
  for (const line of source.ast.getFullText().split('\n')) {
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/\s?/, '').trim());
  }
  const text = lines.join(' ');
  const end = text.search(/\.(\s|$)/);
  return end < 0 ? text : text.slice(0, end + 1);
}

function adapters(sources: Source[]): string {
  const rows = sources
    .filter((s) => s.path.startsWith('adapters/'))
    .map((s) => [`\`${s.path}\``, firstSentence(s) || '(no leading comment)']);
  return table(['Adapter', 'What it does'], rows);
}

export function contextMapBody(sources: Source[]): string {
  const map = contextMap(sources);
  const lines = map.edges.map((e) => {
    const arrow = e.typeOnly ? '-.->' : '-->';
    return `  ${ident(e.from)} ${arrow}${e.inCycle ? '|cycle|' : ''} ${ident(e.to)}`;
  });
  const cycles = map.cycles.length
    ? `Cycles:\n\n${map.cycles.map((c) => `- ${c.map((n) => `\`${n}\``).join(' ↔ ')}`).join('\n')}`
    : 'No cycles.';
  return [mermaid(['flowchart LR', ...map.contexts.map((c) => `  ${ident(c)}["${c}"]`), ...lines]), cycles].join('\n\n');
}

export function adapterUseBody(sources: Source[]): string {
  return table(
    ['Area', 'Adapters imported'],
    adapterUse(sources).map((u) => [
      `\`application/${u.area}\``,
      u.adapters.map((a) => `\`${a.adapter}\`${a.imports > 1 ? ` (${a.imports})` : ''}`).join(', '),
    ]),
  );
}

function strictnessRows(): string[][] {
  const offences = readStrictnessOffences();
  const count = (rule: string) => offences.filter((o) => o.rule === rule);
  const where = (list: { file: string }[]) => [...new Set(list.map((o) => `\`${o.file}\``))].join(', ');
  const strict = count('strict-types');
  const deterministic = count('domain-deterministic');
  return [
    ['Explicit `any`, non-null `!` and open switches in `daemon/src` and `app/src`', String(strict.length), where(strict)],
    ['Clock, randomness and `process` reads in `domain/`', String(deterministic.length), where(deterministic)],
  ];
}

export function progressBody(sources: Source[]): string {
  const p = progress(sources);
  const lists = [...p.lists, { name: 'UNCHECKED rules (`scripts/lib/rules.ts`)', size: Object.keys(UNCHECKED).length }];
  const rows: string[][] = [
    ['Flags left in domain entities (stored as numbers)', String(p.flags.length), p.flags.map((f) => `\`${f}\``).join(', ')],
    [
      'JSON fields left in domain entities (stored as strings)',
      String(p.jsonFields.length),
      p.jsonFields.map((f) => `\`${f}\``).join(', '),
    ],
    ['Runtime imports of adapters from `application/`', String(p.adapterImports.length), ''],
    ['Store calls (`db.…`) in `api/` and `cli/`', String(p.storeCalls.length), ''],
    [
      'Folder cycles in `domain/` and `application/`',
      String(p.cycles.length),
      p.cycles.map((c) => `${c.layer}: ${c.folders.length} folders`).join('; '),
    ],
    ...strictnessRows(),
  ];
  const cycleLines = p.cycles.map((c) => `- \`${c.layer}/\`: ${c.folders.map((f) => `\`${f}\``).join(', ')}`);
  return [
    table(['Measure', 'Count', 'Where'], rows),
    '## Shrinking lists',
    'Each list can only shrink: an entry that stops applying fails `pnpm test`.',
    table(
      ['List', 'Entries'],
      lists.map((l) => [l.name, String(l.size)]),
    ),
    '## Folder cycles',
    'Folders that import each other, counting runtime and type-only imports (`rule:folder-cycles`).',
    cycleLines.length ? cycleLines.join('\n') : 'None.',
  ].join('\n\n');
}

export function coverageBody(): string {
  const holds = (group: string) =>
    group === 'src'
      ? 'the files at the top of `daemon/src/` (`cli.ts`, `compose.ts`, `config.ts`, `daemon.ts`)'
      : group === 'application'
        ? 'the files directly in `application/` (`actions.ts`)'
        : `\`${group}/\``;
  return table(
    ['Group', 'Holds', 'Lines', 'Branches'],
    Object.entries(COVERAGE_FLOORS)
      .sort(([a], [b]) => cmp(a, b))
      .map(([group, floor]) => [`\`${group}\``, holds(group), `${floor.lines}%`, `${floor.branches}%`]),
  );
}

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
    for (const col of c.columns) {
      if (fkColumns.has(col.name) || !(col.name.endsWith('_id') || col.name === 'after_task')) continue;
      const parent = col.name === 'after_task' ? 'tasks' : `${col.name.slice(0, -3)}s`;
      if (!tableNames.has(parent)) continue;
      relations.push(`  ${parent} ${col.notNull ? '||' : '|o'}..o{ ${c.name} : "${col.name}"`);
    }
  }
  return mermaid([...lines, ...relations.sort()]);
}

function lifecycle(): string {
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

export function generateBlocks(): Record<string, string> {
  return { layers: layers(readSources(SRC)), dashboard: dashboardBody() };
}

const REFERENCE_NOTE = '<!-- Generated by `pnpm docs:gen` from the code. Do not edit: `pnpm test` fails when it is stale. -->';

export function generateReference(): Record<string, string> {
  const sources = readSources(SRC);
  const file = (title: string, intro: string, body: string) =>
    `${[`# ${title}`, REFERENCE_NOTE, intro, body].filter(Boolean).join('\n\n')}\n`;
  return {
    'data-model.md': file(
      'Data model',
      'Solid lines are foreign keys. Dotted lines are columns that name another row but have no foreign key.',
      dataModel(),
    ),
    'lifecycle.md': file('Task lifecycle', 'Every status change a task can make, and the events that cause it.', lifecycle()),
    'routes.md': file('HTTP API', "The dashboard's routes, and the use case each calls.", routes()),
    'settings.md': file('Settings', 'The rows of the settings table, with their defaults.', settings()),
    'migrations.md': file('Migrations', 'The steps of `db/schema.ts`, in order.', migrations(sources)),
    'context-map.md': file(
      'Context map',
      'The folders under `domain/` and the imports between them. A solid arrow is a runtime import, a dotted one is type-only; an edge inside a cycle is labelled `cycle`.',
      contextMapBody(sources),
    ),
    'adapter-use.md': file(
      'Adapter use',
      'Each area of `application/` and the adapters it imports, with the number of imports where there is more than one.',
      adapterUseBody(sources),
    ),
    'models.md': file(
      'Models',
      'The exported interfaces and object types of `domain/`, grouped by folder, with their fields as the type checker reads them.',
      modelsBody(),
    ),
    'use-cases.md': file(
      'Use cases',
      'Every export of `application/actions.ts`, the module the CLI and the API call, with its input and output and the adapters the file that declares it imports.',
      useCasesBody(),
    ),
    'state-machines.md': file('State machines', 'Each state machine of `domain/`, read from its rule table.', stateMachinesBody()),
    'progress.md': file(
      'Migration progress',
      'How far the move to a domain model has come, counted from the code. Each number should fall to zero.',
      progressBody(sources),
    ),
    'coverage.md': file(
      'Coverage floors',
      'The least line and branch coverage each group of `daemon/src/` may have (`COVERAGE_FLOORS` in `daemon/scripts/lib/progress.ts`). `pnpm coverage` runs the tests with coverage, prints what each group has now, and fails when one drops below its floor. The floors only rise: raise one, to its number rounded down, when it is beaten by more than 2 points. A file that holds only types never loads, so it is not counted.',
      coverageBody(),
    ),
    'dashboard.md': file(
      'Dashboard',
      'Each area of `app/src`, what it may import and why, and its number of files. The rule is `MAY_IMPORT` in `daemon/scripts/lib/dashboard-layout.ts`, which `daemon/test/architecture/dashboard-layout.test.ts` enforces; `pages/` and `components/layout/` combine the contexts, and `components/ui/` holds the pieces they share.',
      dashboardReference(),
    ),
    'adapters.md': file('Adapters', 'The files of `daemon/src/adapters/`, each the I/O of one outside system.', adapters(sources)),
  };
}

export const REFERENCE_DIR = join(import.meta.dirname, '../../../docs/reference');

const BLOCK = /<!-- generated:([\w-]+) -->\n[^]*?<!-- \/generated -->/g;

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

export function section(markdown: string, heading: string): string {
  const m = new RegExp(`^## ${heading}\\n([^]*?)(?=^## |(?![^]))`, 'm').exec(markdown);
  if (!m) throw new Error(`docs: docs/architecture.md has no "## ${heading}" section`);
  return m[1];
}
