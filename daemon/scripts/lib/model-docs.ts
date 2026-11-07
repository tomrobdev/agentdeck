// The catalogues behind docs/reference/models.md, use-cases.md and state-machines.md. Entities and use cases are read with the
// TypeScript type checker from the exported types and from application/actions.ts; state machines are read from their rule tables.
// Deterministic: sorted, no absolute paths.
import { join } from 'node:path';
import ts from 'typescript';
import { COMMENT_MOVES, COMMENT_STATES } from '../../src/domain/landing/review.ts';
import { RULES, TASK_STATUSES } from '../../src/domain/work/lifecycle.ts';
import { type Source, readSources } from './sources.ts';

const SRC = join(import.meta.dirname, '../../src');
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A markdown table laid out as Prettier lays it out, so the file stays formatted. */
function table(headers: string[], rows: string[][]): string {
  const cells = [headers, ...rows].map((r) => r.map(escapeCell));
  const widths = headers.map((_, i) => Math.max(3, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(cells[0]), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

let cached: ts.Program | undefined;
/** One type-checked program over daemon/src, shared by the catalogues. */
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

/** The comment on a declaration: its JSDoc, or the `//` comment trailing it on its line. */
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
  // A property's `;` comes after the node's end, so look past it.
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

/** Every exported interface and object-type alias under domain/, with its fields as the checker sees them. */
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

/** An alias of an object literal type, or of an intersection or Omit/Pick of object types (not a union). */
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
  /** The signature's parameters, or null for a type or value. */
  input: string | null;
  output: string;
  /** The adapters the file that declares it imports, or `adapter` when the adapter itself is exported. */
  adapters: string[];
}

/** Every export of application/actions.ts, resolved through its re-exports, with the adapters its declaring file imports. */
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
  /** Where the rule table is: file under daemon/src and constant name. */
  source: { file: string; constant: string };
  /** What the table is keyed by: the events or actions. */
  moves: string;
  states: readonly string[];
  rules: Record<string, Partial<Record<string, string>>>;
}

/** The state machines of domain/, each a rule table. A new one is added here and the generator lists it. */
export const STATE_MACHINES: StateMachine[] = [
  {
    name: 'Task lifecycle',
    source: { file: 'domain/work/lifecycle.ts', constant: 'RULES' },
    moves: 'event',
    states: TASK_STATUSES,
    rules: RULES,
  },
  {
    name: 'Review comment',
    source: { file: 'domain/landing/review.ts', constant: 'COMMENT_MOVES' },
    moves: 'action',
    states: COMMENT_STATES,
    rules: COMMENT_MOVES,
  },
];

/** State types in domain/ that no rule table drives, each with why. A state that becomes a table moves to STATE_MACHINES. */
export const NOT_YET_TABLES: Record<string, string> = {
  PrState: 'a pull request moves by what GitHub reports (domain/landing/pr.ts), not by an event table yet',
  MergeRequestView:
    'a merge request is set, cleared and read as columns (domain/landing/merge-request.ts), not a state type with a table yet',
  CheckState: 'a value read from GitHub for each check, not a state a thing moves through',
  AutoMergeState: 'a verdict computed from the pull request each time, not a state with moves',
  HeadlineState: 'computed from the daemon and queue each time, not a state with moves',
  LinkState: 'computed from the linked task each time, not a state with moves',
  StartState: "computed from a task's links each time, not a state with moves",
  PlanStepStatus: 'set from the plan page by a person or worker; any step may take any status',
  ChangeStatus: 'a git file change letter, read from git',
  TaskStatus: 'the states of the Task lifecycle table',
  TaskState: 'the states of the Task lifecycle table, with what a task carries in each',
  CommentState: 'the states of the Review comment table',
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
        .join(', '),
    ]);
    sections.push(
      `## ${m.name}`,
      `The rule table is \`${m.source.constant}\` in \`${m.source.file}\`. States: ${m.states.map((s) => code(s)).join(', ')}.`,
      diagram,
      table([m.moves[0].toUpperCase() + m.moves.slice(1), 'Moves'], rows),
    );
  }
  sections.push(
    '## Not yet tables',
    'State types in `domain/` that no rule table drives, and why.',
    table(
      ['State type', 'Why'],
      Object.entries(NOT_YET_TABLES)
        .filter(([name]) => !['TaskStatus', 'TaskState', 'CommentState'].includes(name))
        .sort((a, b) => cmp(a[0], b[0]))
        .map(([name, why]) => [code(name), why]),
    ),
  );
  return sections.join('\n\n');
}

/** The exported string-literal union types under domain/ named `…State` or `…Status`, and the constants typed as rule tables. */
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
        const isState = ts.isTypeAliasDeclaration(stmt) ? /(State|Status)$/.test(name) : name === 'MergeRequestView';
        const exported = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isState && exported) states.push(name);
      }
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const text = typeText(checker, checker.getTypeAtLocation(d.name));
          // Record<K, Partial<Record<S, S>>>: event or action → current state → next state.
          if (/^Record<[^]*Partial<Record<[^]*>>>$/.test(text)) tables.push({ file: source.path, constant: d.name.text });
        }
      }
    }
  }
  return { states, tables };
}
