// The dashboard's layout (app/src/): its layers, the context folders they share, and which areas may import which.
// `daemon/test/architecture/dashboard-layout.test.ts` checks the imports against it, and `pnpm docs:gen` writes the Dashboard
// section of docs/architecture.md from it.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The daemon's bounded contexts, as folders in each layer that is split by context. */
export const DASHBOARD_CONTEXTS = ['work', 'runs', 'landing', 'repos', 'operations', 'insights'];

/** The layers split by context, bottom up, each with the folder of what every context shares. */
export const CONTEXT_LAYERS: { layer: string; shared: string; holds: string }[] = [
  { layer: 'lib', shared: 'lib/shared', holds: 'pure helpers' },
  { layer: 'composables', shared: 'composables/shared', holds: '`useX` functions' },
  { layer: 'components', shared: 'components/ui', holds: 'Vue components' },
];

/** The contexts a context may import besides itself and the shared folder, and why. No other context imports another. */
export const ALSO_IMPORTS: Record<string, { contexts: string[]; why: string }> = {
  work: {
    contexts: ['runs', 'landing'],
    why: "the queue and the task overview show a run's summary, a pull request and the merge buttons",
  },
};

/** The area a path of app/src belongs to: `<layer>/<context>`, `components/ui`, `components/layout`, another top folder, or the file itself. */
export function areaOf(path: string): string {
  if (path.startsWith('..')) return path.includes('daemon/src/') ? 'daemon' : 'repo';
  const parts = path.split('/');
  if (CONTEXT_LAYERS.some((l) => l.layer === parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0] : path.replace(/\.ts$/, '');
}

export interface AreaRule {
  areas: string[];
  why: string;
}

const BELOW: Record<string, string[]> = {
  lib: ['api'],
  composables: ['api', 'platform', 'router'],
  components: ['api', 'platform', 'router'],
};

/** Every area of a layer split by context: its shared folder first, then one per context. */
const areasOf = (layer: string) => {
  const l = CONTEXT_LAYERS.find((c) => c.layer === layer)!;
  return [l.shared, ...DASHBOARD_CONTEXTS.map((c) => `${layer}/${c}`)];
};

function contextRules(): Record<string, AreaRule> {
  const out: Record<string, AreaRule> = {};
  CONTEXT_LAYERS.forEach(({ layer, shared }, i) => {
    const lower = CONTEXT_LAYERS.slice(0, i).flatMap((l) => areasOf(l.layer));
    out[shared] = {
      areas: [shared, ...lower, ...BELOW[layer]],
      why: `${shared}/ is shared by every context, so it imports none of them in its layer`,
    };
    for (const c of DASHBOARD_CONTEXTS) {
      const also = ALSO_IMPORTS[c];
      out[`${layer}/${c}`] = {
        areas: [`${layer}/${c}`, shared, ...(also?.contexts ?? []).map((a) => `${layer}/${a}`), ...lower, ...BELOW[layer]],
        why: also ? `${layer}/${c}/ may import ${also.contexts.join(' and ')}: ${also.why}` : `a context imports no other context`,
      };
    }
  });
  return out;
}

const ALL_COMPONENTS = areasOf('components');
const ALL_BELOW_PAGES = [...CONTEXT_LAYERS.flatMap((l) => areasOf(l.layer)), 'api', 'platform', 'router'];

/** Which areas each area may import, and why. Imports point down the layers, and across contexts only as `ALSO_IMPORTS` says. */
export const MAY_IMPORT: Record<string, AreaRule> = {
  api: { areas: ['api'], why: 'api/ is the base: types, calls and wording' },
  platform: { areas: ['platform', 'lib/shared'], why: 'platform/ is the Tauri shell, build commit and theme' },
  router: { areas: ['api', 'lib/shared'], why: 'the router is below the composables and components' },
  ...contextRules(),
  'components/layout': { areas: ['components/layout', ...ALL_BELOW_PAGES], why: "layout/ is the app's frame, so it combines contexts" },
  pages: { areas: ['pages', 'components/layout', ...ALL_COMPONENTS, ...ALL_BELOW_PAGES], why: 'pages/ combine the contexts per route' },
};

const APP_SRC = join(import.meta.dirname, '../../../app/src');

/** The number of files in an area, its subfolders included. */
function fileCount(area: string): number {
  const path = join(APP_SRC, area === 'router' ? 'router.ts' : area);
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return 1;
  return readdirSync(path, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(path, f)).isFile()).length;
}

/** `areas` in a few words: a whole layer as `lib/`, the rest by name, the area itself left out. */
function importsLabel(area: string, areas: string[]): string {
  const rest = areas.filter((a) => a !== area);
  const whole = CONTEXT_LAYERS.filter((l) => areasOf(l.layer).every((a) => rest.includes(a))).map((l) => l.layer);
  const named = rest.filter((a) => !whole.some((l) => areasOf(l).includes(a)));
  const label = [...whole.map((l) => `\`${l}/\``), ...named.map((a) => (a === 'router' ? '`router.ts`' : `\`${a}/\``))];
  return label.length ? label.join(', ') : 'nothing';
}

const code = (area: string) => `\`${area === 'router' ? 'router.ts' : `${area}/`}\``;

/**
 * The Dashboard section of docs/architecture.md, in one paragraph: the layers and their context folders with their file
 * counts, and the import rule. `dashboardReference` has each area's rule.
 */
export function dashboardBody(): string {
  const counted = (areas: string[]) =>
    areas
      .filter((a) => fileCount(a) > 0)
      .map((a) => `${a.split('/')[1]} ${fileCount(a)}`)
      .join(', ');
  const layers = CONTEXT_LAYERS.map((l) => `\`${l.layer}/\` (${l.holds}: ${counted(areasOf(l.layer))})`).join(', ');
  const whole = ['api', 'platform', 'components/layout', 'pages'].map((a) => `${code(a)} ${fileCount(a)}`).join(', ');
  const also = Object.entries(ALSO_IMPORTS)
    .map(([c, { contexts, why }]) => `\`${c}/\` may also import ${contexts.map((a) => `\`${a}/\``).join(' and ')}, because ${why}`)
    .join('; ');
  return [
    `Grouped by the daemon's contexts. The layers ${layers} each have a folder per context, the shared one first, with its number of files; beside them ${whole}.`,
    `Imports point down \`pages/\` → \`components/\` → \`composables/\` → \`lib/\` → \`api/\`. Within a layer a context imports only itself and the shared folder, which imports no context; ${also}. \`pages/\` and \`components/layout/\` combine the contexts.`,
    `Each area's rule and why: [dashboard](reference/dashboard.md), from \`MAY_IMPORT\` in \`daemon/scripts/lib/dashboard-layout.ts\`, which \`daemon/test/architecture/dashboard-layout.test.ts\` enforces.`,
  ].join(' ');
}

/** docs/reference/dashboard.md: each area of app/src, what it may import and why, and its file count. */
export function dashboardReference(): string {
  // A context folder with no files yet is left out: its rule is the same as its neighbours'.
  const shown = Object.entries(MAY_IMPORT).filter(([area]) => fileCount(area) > 0);
  const rows = shown.map(([area, rule]) => [code(area), importsLabel(area, rule.areas), rule.why, String(fileCount(area))]);
  const head = ['Area', 'May import', 'Why', 'Files'];
  const cells = [head, ...rows].map((r) => r.map((c) => c.replace(/\|/g, '\\|')));
  const widths = head.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  const table = [line(cells[0]), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
  const contexts = DASHBOARD_CONTEXTS.map((c) => `\`${c}/\``).join(', ');
  const layers = CONTEXT_LAYERS.map((l) => `\`${l.layer}/\` (${l.holds}, shared ones in \`${l.shared}/\`)`).join(', ');
  return [
    `The layers ${layers} each have a folder per context: ${contexts}. A context may have a sub-folder where it has the same one in every layer that needs it (\`work/queue/\`, \`work/files/\`).`,
    table,
  ].join('\n\n');
}
