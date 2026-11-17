// Strict types and a deterministic domain, checked with the TypeScript compiler: no any, no non-null !, exhaustive switches, no clock or randomness in domain/.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { vueScript } from '#scripts/lib/sources.ts';

const ROOT = join(import.meta.dirname, '../../..');

export type StrictnessKind = 'any' | 'non-null' | 'switch' | 'clock' | 'random' | 'crypto' | 'process';

export interface StrictFile {
  path: string;
  text: string;
}

export interface Offence {
  file: string;
  line: number;
  kind: StrictnessKind;
  rule: 'strict-types' | 'domain-deterministic';
  text: string;
}

const WHY: Record<StrictnessKind, string> = {
  any: 'uses an explicit any: give it a real type, or unknown and narrow it',
  'non-null': 'uses a non-null assertion !: narrow the value, or say what happens when it is missing',
  switch:
    'switches on a union of literals without covering every member: add the missing cases, or end in a default that assigns the value to never',
  clock: 'reads the clock: take the time as an argument',
  random: 'reads randomness: take the random value as an argument',
  crypto: 'uses crypto: take the random value or the hash as an argument',
  process: 'reads process: take what it needs as an argument',
};

const RULE: Record<StrictnessKind, Offence['rule']> = {
  any: 'strict-types',
  'non-null': 'strict-types',
  switch: 'strict-types',
  clock: 'domain-deterministic',
  random: 'domain-deterministic',
  crypto: 'domain-deterministic',
  process: 'domain-deterministic',
};

export const PROJECTS = [
  { project: 'daemon', src: 'daemon/src', vue: false },
  { project: 'app', src: 'app/src', vue: true },
];

export function readStrictFiles(src: string, vue: boolean): StrictFile[] {
  return readdirSync(join(ROOT, src), { recursive: true, encoding: 'utf8' })
    .filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts')) || (vue && f.endsWith('.vue')))
    .sort()
    .map((f) => ({ path: `${src}/${f}`, text: readFileSync(join(ROOT, src, f), 'utf8') }));
}

export function projectOptions(project: string): ts.CompilerOptions {
  const file = join(ROOT, project, 'tsconfig.json');
  const config = ts.readConfigFile(file, (f) => ts.sys.readFile(f));
  return ts.parseJsonConfigFileContent(config.config, ts.sys, join(ROOT, project), undefined, file).options;
}

const programName = (path: string) => join(ROOT, path) + (path.endsWith('.vue') ? '.ts' : '');

export function strictnessOffences(files: StrictFile[], options: ts.CompilerOptions): Offence[] {
  const memory = new Map(files.map((f) => [programName(f.path), f.path.endsWith('.vue') ? vueScript(f.text) : f.text]));
  const host = ts.createCompilerHost(options, true);
  const base = { fileExists: host.fileExists, readFile: host.readFile, getSourceFile: host.getSourceFile };
  host.fileExists = (f) => memory.has(f) || base.fileExists(f);
  host.readFile = (f) => memory.get(f) ?? base.readFile(f);
  host.getSourceFile = (f, lang, ...rest) => {
    const text = memory.get(f);
    return text === undefined ? base.getSourceFile(f, lang, ...rest) : ts.createSourceFile(f, text, lang, true);
  };
  const program = ts.createProgram([...memory.keys()], { ...options, noEmit: true }, host);
  const checker = program.getTypeChecker();
  return files.flatMap((f) => {
    const ast = program.getSourceFile(programName(f.path));
    return ast ? offencesIn(f.path, ast, program, checker) : [];
  });
}

function offencesIn(path: string, ast: ts.SourceFile, program: ts.Program, checker: ts.TypeChecker): Offence[] {
  const domain = path.startsWith('daemon/src/domain/');
  const out: Offence[] = [];
  const add = (node: ts.Node, kind: StrictnessKind) =>
    out.push({
      file: path,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      kind,
      rule: RULE[kind],
      text: node.getText(ast).split('\n')[0].slice(0, 80),
    });
  const isGlobal = (node: ts.Node, name: string) => {
    if (!ts.isIdentifier(node) || node.text !== name) return false;
    const decl = checker.getSymbolAtLocation(node)?.declarations?.[0];
    if (!decl) return false;
    const file = decl.getSourceFile();
    return (
      program.isSourceFileDefaultLibrary(file) || program.isSourceFileFromExternalLibrary(file) || file.fileName.includes('/node_modules/')
    );
  };
  const isCallOf = (node: ts.Node, object: string, method: string) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === method &&
    isGlobal(node.expression.expression, object);
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) add(node, 'any');
    else if (ts.isNonNullExpression(node)) add(node, 'non-null');
    else if (ts.isSwitchStatement(node) && !exhaustive(node, checker)) add(node, 'switch');
    if (domain) {
      if (isCallOf(node, 'Date', 'now')) add(node, 'clock');
      else if (ts.isNewExpression(node) && isGlobal(node.expression, 'Date') && !node.arguments?.length) add(node, 'clock');
      else if (ts.isCallExpression(node) && isGlobal(node.expression, 'Date')) add(node, 'clock');
      else if (isCallOf(node, 'Math', 'random')) add(node, 'random');
      else if (isGlobal(node, 'crypto')) add(node, 'crypto');
      else if (isGlobal(node, 'process')) add(node, 'process');
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

function literalKey(t: ts.Type, checker: ts.TypeChecker): string | null {
  if (t.isStringLiteral()) return JSON.stringify(t.value);
  if (t.isNumberLiteral()) return String(t.value);
  if (t.flags & (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return checker.typeToString(t);
  return null;
}

const squash = (node: ts.Node) => node.getText().replace(/\s+/g, '');

function assignsNever(clause: ts.DefaultClause, value: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.type?.kind === ts.SyntaxKind.NeverKeyword &&
      node.initializer &&
      squash(node.initializer) === squash(value)
    )
      found = true;
    if (ts.isSatisfiesExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword && squash(node.expression) === squash(value))
      found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(clause);
  return found;
}

function exhaustive(node: ts.SwitchStatement, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node.expression);
  if (!type.isUnion()) return true;
  const members = type.types.map((t) => literalKey(t, checker));
  if (members.some((m) => m === null)) return true;
  const covered = new Set<string | null>();
  let fallback: ts.DefaultClause | undefined;
  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      fallback = clause;
      continue;
    }
    const t = checker.getTypeAtLocation(clause.expression);
    for (const m of t.isUnion() ? t.types : [t]) covered.add(literalKey(m, checker));
  }
  if (members.every((m) => covered.has(m))) return true;
  return !!fallback && assignsNever(fallback, node.expression);
}

export const exceptionKey = (o: Pick<Offence, 'file' | 'kind'>) => `${o.file}: ${o.kind}`;

export function checkStrictness(offences: Offence[], allowed: string[]): { found: string[]; stale: string[] } {
  const keys = new Set(offences.map(exceptionKey));
  return {
    found: offences
      .filter((o) => !allowed.includes(exceptionKey(o)))
      .map((o) => `${o.file}:${o.line} ${WHY[o.kind]} (rule:${o.rule}): ${o.text}`),
    stale: allowed
      .filter((entry) => !keys.has(entry))
      .map((entry) => `"${entry}" is on STRICTNESS_EXCEPTIONS but no longer applies: remove the entry`),
  };
}

export function readStrictnessOffences(): Offence[] {
  return PROJECTS.flatMap((p) => strictnessOffences(readStrictFiles(p.src, p.vue), projectOptions(p.project)));
}
