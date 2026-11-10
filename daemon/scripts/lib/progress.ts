import ts from 'typescript';
import type { Floor } from './coverage.ts';
import { type FolderCycle, folderCycles } from './graphs.ts';
import { type Source, lineOf } from './sources.ts';

export const CYCLE_LAYERS = ['domain', 'application'];

export const ALLOWED_FOLDER_CYCLES: Record<string, string[]> = {};

export const OVERSIZED_FOLDERS: string[] = [];

export const LONG_FILES: string[] = [
  'daemon/src/application/scheduler/scheduler.ts',
  'daemon/src/domain/landing/pull-request/checks.ts',
  'daemon/src/domain/runs/run.ts',
];

export const UNPLACED_FOLDERS: string[] = [];

export const cycleKey = (c: FolderCycle) => c.folders.join(', ');

const tie = (t: FolderCycle['imports'][number]) => `${t.file}:${t.line} (${t.from} → ${t.to}${t.typeOnly ? ', type-only' : ''})`;

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

export const ROW_SHAPED_FIELDS: string[] = [];

export const PLAIN_TASK_WRITES: Record<string, string> = {
  noteEvent: 'only touches updated_at to record a history row; the status stays',
  addTask: "sets the task's own plan right after the insert; no rule decides it",
  editTask: 'stores the fields a person gave; the only rule is the status guard',
  attachOwnPlan: 'only touches updated_at; the plan itself is stored in plans',
  setCheckout: 'where the work is checked out; a fact the worker reports, no decision',
  setSyncing: 'marks that a sync is running; a lock, no decision',
  recoverOrphans: 'clears the sync marks a crash left; a lock, no decision',
};

export const COVERAGE_FLOORS: Record<string, Floor> = {
  adapters: { lines: 88, branches: 83 },
  api: { lines: 99, branches: 94 },
  application: { lines: 100, branches: 100 },
  'application/capacity': { lines: 100, branches: 100 },
  'application/insights': { lines: 100, branches: 96 },
  'application/landing': { lines: 99, branches: 90 },
  'application/operations': { lines: 98, branches: 93 },
  'application/proposals': { lines: 92, branches: 82 },
  'application/repos': { lines: 98, branches: 88 },
  'application/runs': { lines: 94, branches: 82 },
  'application/scheduler': { lines: 98, branches: 91 },
  'application/shared': { lines: 100, branches: 97 },
  'application/work': { lines: 99, branches: 92 },
  cli: { lines: 73, branches: 62 },
  db: { lines: 99, branches: 94 },
  'domain/capacity': { lines: 100, branches: 94 },
  'domain/insights': { lines: 100, branches: 98 },
  'domain/landing': { lines: 100, branches: 97 },
  'domain/operations': { lines: 100, branches: 97 },
  'domain/proposals': { lines: 100, branches: 89 },
  'domain/repos': { lines: 100, branches: 99 },
  'domain/runs': { lines: 98, branches: 94 },
  'domain/shared': { lines: 100, branches: 95 },
  'domain/work': { lines: 99, branches: 95 },
  src: { lines: 96, branches: 81 },
};

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

const ENTITIES = ['Repo', 'Task', 'TaskCore', 'BlockedState', 'FailedState', 'CancelledState', 'DoneState', 'Run', 'PlannerRun'];

const FLAG = /^\/\/\s*(1 =|1 or 0|1, 0)/;
const JSON_FIELD = /^\/\/\s*JSON\b/;

export interface Progress {
  flags: string[];
  jsonFields: string[];
  adapterImports: string[];
  storeCalls: string[];
  cycles: { layer: string; folders: string[] }[];
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
      { name: 'OVERSIZED_FOLDERS (`scripts/lib/progress.ts`)', size: OVERSIZED_FOLDERS.length },
      { name: 'LONG_FILES (`scripts/lib/progress.ts`)', size: LONG_FILES.length },
      { name: 'UNPLACED_FOLDERS (`scripts/lib/progress.ts`)', size: UNPLACED_FOLDERS.length },
      { name: 'ROW_SHAPED_FIELDS (`scripts/lib/progress.ts`)', size: ROW_SHAPED_FIELDS.length },
      { name: 'PLAIN_TASK_WRITES (`scripts/lib/progress.ts`)', size: Object.keys(PLAIN_TASK_WRITES).length },
    ],
  };
}
