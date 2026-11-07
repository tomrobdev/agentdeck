// How far the DDD migration (docs/plans/…, plan 197) has come, counted from the code: the source of docs/reference/progress.md,
// and of rule:folder-cycles. Pure: it reads `Source`s and returns numbers.
import ts from 'typescript';
import { type FolderCycle, folderCycles } from './graphs.ts';
import { type Source, lineOf } from './sources.ts';

/** The layers whose folders must not import each other in a ring. */
export const CYCLE_LAYERS = ['domain', 'application'];

/**
 * The folder cycles that exist today, per layer, each as its folders joined by ", " (sorted). The list only shrinks: a new cycle fails
 * the test, and so does an entry that is no longer a cycle, so remove an entry (or cut it down to the smaller cycle that is left) in
 * the change that breaks it. Never add one. Breaking them is Phase 3 of the plan.
 */
export const ALLOWED_FOLDER_CYCLES: Record<string, string[]> = {
  domain: ['domain, domain/branch, domain/pull-request, domain/repo, domain/review, domain/run, domain/task, domain/usage'],
  application: [
    'application, application/pull-request, application/repo, application/review, application/run, application/scheduler, application/task',
  ],
};

export const cycleKey = (c: FolderCycle) => c.folders.join(', ');

/** One of the imports that ties a cycle, as `file:line imports target-folder`. */
const tie = (t: FolderCycle['imports'][number]) => `${t.file}:${t.line} (${t.from} → ${t.to}${t.typeOnly ? ', type-only' : ''})`;

/** The cycles `sources` have that are not allowed, and the allowed entries that match no cycle. Each message names folders and files. */
export function checkFolderCycles(
  sources: Source[],
  allowed: Record<string, string[]> = ALLOWED_FOLDER_CYCLES,
): { found: string[]; stale: string[] } {
  const found: string[] = [];
  const stale: string[] = [];
  for (const layer of CYCLE_LAYERS) {
    const cycles = folderCycles(sources, layer);
    const keys = new Set(cycles.map(cycleKey));
    for (const c of cycles) {
      if ((allowed[layer] ?? []).includes(cycleKey(c))) continue;
      found.push(`${layer}/ folders import each other: ${cycleKey(c)}; through ${c.imports.map(tie).join(', ')}`);
    }
    for (const entry of allowed[layer] ?? []) {
      if (!keys.has(entry))
        stale.push(`${layer}: "${entry}" is on ALLOWED_FOLDER_CYCLES but is no longer a cycle: remove or shrink the entry`);
    }
  }
  return { found, stale };
}

/**
 * The entity fields still shaped by their row: flags stored as numbers and JSON documents stored as strings (rule:models-not-rows). The
 * list only shrinks: a new one fails the test, and so does an entry that no longer is one, so remove an entry in the change that gives
 * the field its real type, parsing it in `db/mappers.ts`. Never add one. Phase 2 of the plan empties it.
 */
export const ROW_SHAPED_FIELDS = [
  'Run.tests_passed',
  'Task.auto_merge',
  'Task.auto_merge_check',
  'Task.merge_request_check',
  'Task.needs',
  'Task.plan_steps',
  'Task.pr_checks',
  'Task.pr_checks_merged',
  'Task.pr_checks_opened',
  'Task.question',
];

/** The row-shaped fields `sources` have that are not allowed, and the allowed entries that are no longer row-shaped. */
export function checkRowShapedFields(sources: Source[], allowed: string[] = ROW_SHAPED_FIELDS): { found: string[]; stale: string[] } {
  const { flags, jsonFields } = entityFields(sources);
  const fields = [...flags, ...jsonFields];
  return {
    found: fields
      .filter((f) => !allowed.includes(f))
      .map(
        (f) => `${f} is a flag or a JSON document stored as its column is: give the domain type a real value, and read it in db/mappers.ts`,
      ),
    stale: allowed
      .filter((f) => !fields.includes(f))
      .map((f) => `${f} is on ROW_SHAPED_FIELDS but is no longer a flag or a JSON document: remove the entry`),
  };
}

/** The entity types whose fields the page counts. */
const ENTITIES = ['Repo', 'Task', 'Run', 'PlannerRun'];

/** A field comment that says the field is a flag (`1 = …`, `1 or 0`, `1, 0, or null`) or a JSON document. */
const FLAG = /^\/\/\s*(1 =|1 or 0|1, 0)/;
const JSON_FIELD = /^\/\/\s*JSON\b/;

export interface Progress {
  /** `Entity.field` of each flag stored as a number, and of each JSON document stored as a string, left in a domain entity. */
  flags: string[];
  jsonFields: string[];
  /** `file:line` of each runtime import of an adapter from application/. */
  adapterImports: string[];
  /** `file:line db.method` of each call of a store method in api/ and cli/. */
  storeCalls: string[];
  /** Folder cycles per layer, allowed or not. */
  cycles: { layer: string; folders: string[] }[];
  /** The size of each shrinking list. */
  lists: { name: string; size: number }[];
}

function entityFields(sources: Source[]): { flags: string[]; jsonFields: string[] } {
  const flags: string[] = [];
  const jsonFields: string[] = [];
  for (const s of sources.filter((s) => s.path.startsWith('domain/'))) {
    const text = s.ast.getFullText();
    for (const stmt of s.ast.statements) {
      if (!ts.isInterfaceDeclaration(stmt) || !ENTITIES.includes(stmt.name.text)) continue;
      for (const m of stmt.members) {
        if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name)) continue;
        const comment = (ts.getTrailingCommentRanges(text, m.end) ?? []).map((c) => text.slice(c.pos, c.end))[0] ?? '';
        const name = `${stmt.name.text}.${m.name.text}`;
        if (JSON_FIELD.test(comment)) jsonFields.push(name);
        else if (FLAG.test(comment)) flags.push(name);
      }
    }
  }
  return { flags: flags.sort(), jsonFields: jsonFields.sort() };
}

function storeCalls(sources: Source[]): string[] {
  const out: string[] = [];
  for (const s of sources.filter((s) => s.path.startsWith('api/') || s.path.startsWith('cli/'))) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'db'
      )
        out.push(`${s.path}:${lineOf(s.ast, node)} db.${node.expression.name.text}`);
      ts.forEachChild(node, visit);
    };
    visit(s.ast);
  }
  return out;
}

export function progress(sources: Source[]): Progress {
  const { flags, jsonFields } = entityFields(sources);
  const adapterImports = sources
    .filter((s) => s.path.startsWith('application/'))
    .flatMap((s) => s.imports.filter((i) => i.target?.startsWith('adapters/') && !i.typeOnly).map((i) => `${s.path}:${i.line}`));
  const calls = storeCalls(sources);
  const cycles = CYCLE_LAYERS.flatMap((layer) => folderCycles(sources, layer).map((c) => ({ layer, folders: c.folders })));
  return {
    flags,
    jsonFields,
    adapterImports,
    storeCalls: calls,
    cycles,
    lists: [
      { name: 'ALLOWED_FOLDER_CYCLES (`scripts/lib/progress.ts`)', size: Object.values(ALLOWED_FOLDER_CYCLES).flat().length },
      { name: 'ROW_SHAPED_FIELDS (`scripts/lib/progress.ts`)', size: ROW_SHAPED_FIELDS.length },
    ],
  };
}
