import { join } from 'node:path';
import ts from 'typescript';
import { MERGE_REQUEST_MOVES, MERGE_REQUEST_STATES } from '#domain/landing/merge/merge-request.ts';
import { PR_FROM, PR_MOVES } from '#domain/landing/pull-request/pr-moves.ts';
import { COMMENT_MOVES, COMMENT_STATES } from '#domain/landing/review/review.ts';
import { FOLLOW_UPS } from '#domain/work/lifecycle/follow-ups.ts';
import { PLAN_BRANCH_MOVES, PLAN_BRANCH_STATUSES } from '#domain/work/plans/plan-branch.ts';
import {
  DOMAIN_EVENT_TYPES,
  RULES,
  type RuleKey,
  TASK_STATUSES,
  type TaskStatus,
  domainEventType,
} from '#domain/work/lifecycle/lifecycle.ts';
import { type Source, readSources } from '#scripts/lib/sources.ts';

const SRC = join(import.meta.dirname, '../../src');
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(headers: string[], rows: string[][]): string {
  const cells = [headers, ...rows].map((r) => r.map(escapeCell));
  const widths = headers.map((_, i) => Math.max(3, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(cells[0]), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

let cached: ts.Program | undefined;
function program(): ts.Program {
  if (cached) return cached;
  const root = join(SRC, '..');
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const files = parsed.fileNames.filter((f) => f.startsWith(`${SRC}/`));
  cached = ts.createProgram(files, parsed.options);
  return cached;
}

const typeText = (checker: ts.TypeChecker, type: ts.Type) =>
  checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);

function commentOf(node: ts.Node): string {
  const text = node.getSourceFile().getFullText();
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const doc = docs
    .map((d) => (typeof d.comment === 'string' ? d.comment : (d.comment?.map((c) => c.text).join('') ?? '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (doc) return doc;
  const trailing = ts.getTrailingCommentRanges(text, node.getEnd()) ?? [];
  const after = text.slice(node.getEnd()).match(/^[ \t]*[;,]?[ \t]*\/\/\s?([^\n]*)/);
  if (after) return after[1].trim();
  return trailing
    .filter((c) => c.kind === ts.SyntaxKind.SingleLineCommentTrivia)
    .map((c) =>
      text
        .slice(c.pos, c.end)
        .replace(/^\/\/\s?/, '')
        .trim(),
    )
    .join(' ');
}

interface Model {
  name: string;
  folder: string;
  comment: string;
  fields: { name: string; type: string; optional: boolean; comment: string }[];
}

export function readModels(): Model[] {
  const prog = program();
  const checker = prog.getTypeChecker();
  const out: Model[] = [];
  for (const source of readSources(SRC).filter((s) => s.path.startsWith('domain/'))) {
    const file = prog.getSourceFile(join(SRC, source.path));
    if (!file) continue;
    for (const stmt of file.statements) {
      const exported = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      const isModel = ts.isInterfaceDeclaration(stmt) || (ts.isTypeAliasDeclaration(stmt) && isObjectAlias(stmt.type));
      if (!isModel) continue;
      const type = checker.getTypeAtLocation(stmt.name);
      const fields = checker.getPropertiesOfType(type).map((p) => {
        const decl = p.declarations?.[0];
        const propType = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
        return {
          name: p.name,
          type: typeText(checker, propType),
          optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
          comment: decl ? commentOf(decl) : '',
        };
      });
      if (!fields.length) continue;
      const parts = source.path.split('/');
      out.push({ name: stmt.name.text, folder: parts.length > 2 ? `domain/${parts[1]}` : 'domain', comment: commentOf(stmt), fields });
    }
  }
  return out.sort((a, b) => cmp(a.folder, b.folder) || cmp(a.name, b.name));
}

function isObjectAlias(node: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) return true;
  if (ts.isIntersectionTypeNode(node)) return node.types.every(isObjectAlias) || node.types.some(ts.isTypeReferenceNode);
  return ts.isTypeReferenceNode(node) && ['Omit', 'Pick'].includes(node.typeName.getText());
}

export function modelsBody(): string {
  const models = readModels();
  const byFolder = new Map<string, Model[]>();
  for (const m of models) byFolder.set(m.folder, [...(byFolder.get(m.folder) ?? []), m]);
  const sections: string[] = [];
  for (const [folder, list] of [...byFolder].sort((a, b) => cmp(a[0], b[0]))) {
    sections.push(`## \`${folder}/\``);
    for (const m of list) {
      sections.push(
        `### ${m.name}`,
        ...(m.comment ? [m.comment] : []),
        table(
          ['Field', 'Type', 'Comment'],
          m.fields.map((f) => [code(f.name + (f.optional ? '?' : '')), code(f.type), f.comment]),
        ),
      );
    }
  }
  return sections.join('\n\n');
}

export interface UseCase {
  name: string;
  kind: 'function' | 'type' | 'value';
  input: string | null;
  output: string;
  adapters: string[];
}

export function readUseCases(): UseCase[] {
  const prog = program();
  const checker = prog.getTypeChecker();
  const file = prog.getSourceFile(join(SRC, 'application/actions.ts'));
  if (!file) throw new Error('docs: application/actions.ts not found');
  const sources = new Map<string, Source>(readSources(SRC).map((s) => [s.path, s]));
  const moduleSymbol = checker.getSymbolAtLocation(file)!;
  const out: UseCase[] = [];
  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decl = target.declarations?.[0];
    const declared = decl ? decl.getSourceFile().fileName.slice(SRC.length + 1) : '';
    const adapterFile = declared.startsWith('adapters/');
    const adapters = adapterFile
      ? ['adapter']
      : [...new Set((sources.get(declared)?.imports ?? []).flatMap((i) => (i.target?.startsWith('adapters/') ? [i.target] : [])))].sort();
    const isType = !(target.flags & ts.SymbolFlags.Value);
    if (isType) {
      const type = checker.getDeclaredTypeOfSymbol(target);
      out.push({ name: exp.name, kind: 'type', input: null, output: typeText(checker, type), adapters });
      continue;
    }
    const type = decl ? checker.getTypeOfSymbolAtLocation(target, decl) : checker.getTypeOfSymbol(target);
    const [sig] = type.getCallSignatures();
    if (!sig) {
      out.push({ name: exp.name, kind: 'value', input: null, output: typeText(checker, type), adapters });
      continue;
    }
    const input = sig.parameters
      .map((p) => {
        const pd = p.declarations?.[0];
        const pt = pd ? checker.getTypeOfSymbolAtLocation(p, pd) : checker.getTypeOfSymbol(p);
        const optional = pd && ts.isParameter(pd) && (pd.questionToken || pd.initializer) ? '?' : '';
        return `${p.name}${optional}: ${typeText(checker, pt)}`;
      })
      .join(', ');
    out.push({ name: exp.name, kind: 'function', input, output: typeText(checker, sig.getReturnType()), adapters });
  }
  return out.sort((a, b) => cmp(a.name, b.name));
}

export function useCasesBody(): string {
  const rows = readUseCases().map((u) => [
    code(u.name),
    u.kind,
    u.input === null ? '' : code(`(${u.input})`),
    code(u.output),
    u.adapters.map((a) => code(a)).join(', '),
  ]);
  return table(['Export', 'Kind', 'Input', 'Output', 'Adapters reached'], rows);
}

export interface StateMachine {
  name: string;
  source: { file: string; constant: string };
  stateType: string;
  moves: string;
  states: readonly string[];
  rules: Record<string, Partial<Record<string, string>>>;
}

export const STATE_MACHINES: StateMachine[] = [
  {
    name: 'Task lifecycle',
    source: { file: 'domain/work/lifecycle/lifecycle.ts', constant: 'RULES' },
    stateType: 'TaskStatus',
    moves: 'event',
    states: TASK_STATUSES,
    rules: RULES,
  },
  {
    name: 'Review comment',
    source: { file: 'domain/landing/review/review.ts', constant: 'COMMENT_MOVES' },
    stateType: 'CommentState',
    moves: 'action',
    states: COMMENT_STATES,
    rules: COMMENT_MOVES,
  },
  {
    name: 'Pull request',
    source: { file: 'domain/landing/pull-request/pr-moves.ts', constant: 'PR_MOVES' },
    stateType: 'PrState',
    moves: 'move',
    states: PR_FROM,
    rules: PR_MOVES,
  },
  {
    name: 'Merge request',
    source: { file: 'domain/landing/merge/merge-request.ts', constant: 'MERGE_REQUEST_MOVES' },
    stateType: 'MergeRequestState',
    moves: 'move',
    states: MERGE_REQUEST_STATES,
    rules: MERGE_REQUEST_MOVES,
  },
  {
    name: 'Plan branch',
    source: { file: 'domain/work/plans/plan-branch.ts', constant: 'PLAN_BRANCH_MOVES' },
    stateType: 'PlanBranchStatus',
    moves: 'move',
    states: PLAN_BRANCH_STATUSES,
    rules: PLAN_BRANCH_MOVES,
  },
];

export const NOT_YET_TABLES: Record<string, string> = {
  CheckState: 'a value read from GitHub for each check, not a state a thing moves through',
  AutoMergeState:
    'a verdict computed from the pull request each time (in a repo with auto_review on, with the review run of its changes: it waits for one, and needs a person when it asked for changes), not a state with moves',
  HeadlineState: 'computed from the daemon and queue each time, not a state with moves',
  LinkState: 'computed from the linked task each time, not a state with moves',
  StartState: "computed from a task's links each time, not a state with moves",
  PlanStepStatus: 'set from the plan page by a person or worker; any step may take any status',
  ChangeStatus: 'a git file change letter, read from git',
  TaskState: 'the states of the Task lifecycle table, with what a task carries in each',
};

export function stateMachinesBody(): string {
  const sections: string[] = [];
  for (const m of STATE_MACHINES) {
    const edges = new Map<string, string[]>();
    for (const [move, rule] of Object.entries(m.rules)) {
      for (const [from, to] of Object.entries(rule)) edges.set(`${from}\0${to}`, [...(edges.get(`${from}\0${to}`) ?? []), move]);
    }
    const order = (s: string) => m.states.indexOf(s);
    const sorted = [...edges]
      .map(([key, moves]) => ({ from: key.split('\0')[0], to: key.split('\0')[1], moves }))
      .sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to));
    const diagram = [
      '```mermaid',
      'stateDiagram-v2',
      ...sorted.map((e) => `  ${e.from} --> ${e.to}: ${e.moves.join(', ').replace(/:/g, '/')}`),
      '```',
    ].join('\n');
    const rows = Object.entries(m.rules).map(([move, rule]) => [
      code(move),
      Object.entries(rule)
        .map(([from, to]) => `${from} → ${to}`)
        .join(', ') || 'none: ignored from every state',
    ]);
    sections.push(
      `## ${m.name}`,
      `The rule table is \`${m.source.constant}\` in \`${m.source.file}\`. States: ${m.states.map((s) => code(s)).join(', ')}.`,
      diagram,
      table([m.moves[0].toUpperCase() + m.moves.slice(1), 'Moves'], rows),
    );
  }
  const causes = new Map<string, Map<RuleKey, TaskStatus[]>>();
  for (const [key, rule] of Object.entries(RULES) as [RuleKey, Partial<Record<TaskStatus, TaskStatus>>][]) {
    for (const [from, to] of Object.entries(rule) as [TaskStatus, TaskStatus][]) {
      const byKey = causes.get(domainEventType(key, to)) ?? new Map<RuleKey, TaskStatus[]>();
      byKey.set(key, [...(byKey.get(key) ?? []), from]);
      causes.set(domainEventType(key, to), byKey);
    }
  }
  sections.push(
    '## Follow-ups',
    "What the daemon does after a task's status changes: each domain event `transition` makes, the moves that make it (event, from which statuses) and its follow-ups. The table is `FOLLOW_UPS` in `domain/work/lifecycle/follow-ups.ts`, run by `application/landing/settle.ts`. `task_events` is the outbox: a change whose event has follow-ups writes its row pending in the same transaction, `settle` runs the daemon's at once and marks the row, and the daemon's tick runs whatever is still pending: a person's events (only the daemon follows up), crash recovery's, and any a crash cut off.",
    table(
      ['Domain event', 'Made by', 'Follow-ups'],
      DOMAIN_EVENT_TYPES.map((type) => [
        code(type),
        [...(causes.get(type) ?? [])].map(([key, from]) => `${code(key)} (${from.join(', ')})`).join(', '),
        FOLLOW_UPS[type].map((f) => code(f)).join(', ') || 'none',
      ]),
    ),
  );
  sections.push(
    '## Not yet tables',
    'State types in `domain/` that no rule table drives, and why.',
    table(
      ['State type', 'Why'],
      Object.entries(NOT_YET_TABLES)
        .filter(([name]) => name !== 'TaskState')
        .sort((a, b) => cmp(a[0], b[0]))
        .map(([name, why]) => [code(name), why]),
    ),
  );
  return sections.join('\n\n');
}

export function readStateTypes(): { states: string[]; tables: { file: string; constant: string }[] } {
  const prog = program();
  const checker = prog.getTypeChecker();
  const states: string[] = [];
  const tables: { file: string; constant: string }[] = [];
  for (const source of readSources(SRC).filter((s) => s.path.startsWith('domain/'))) {
    const file = prog.getSourceFile(join(SRC, source.path));
    if (!file) continue;
    for (const stmt of file.statements) {
      if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
        const name = stmt.name.text;
        const isState = ts.isTypeAliasDeclaration(stmt) && /(State|Status)$/.test(name);
        const exported = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isState && exported) states.push(name);
      }
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const text = typeText(checker, checker.getTypeAtLocation(d.name));
          if (/^Record<[^]*Partial<Record<[^]*>>>$/.test(text)) tables.push({ file: source.path, constant: d.name.text });
        }
      }
    }
  }
  return { states, tables };
}
