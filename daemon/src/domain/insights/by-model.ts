// The pilot measures per model (`agentdeck stats --by model`), read from the model each work run recorded.
import { countInterventions } from './interventions.ts';
import { num, table } from './report-text.ts';
import { type ScorecardEvent, type ScorecardTaskRow, resolveAutoMerge } from './scorecard.ts';
import { type Measures, type StatRun, fmtFirstRun, measure } from './stats.ts';

export const UNKNOWN_MODEL = 'unknown';

/** The first-run measures of the work runs of one model, and the interventions on the tasks while they ran on it. */
export interface ModelMeasures {
  model: string;
  measures: Measures;
  interventions: number;
}

export interface ByModelInput {
  /** Every work run, `since` or not: an intervention goes to the model of the run before it, which may be older. */
  runs: StatRun[];
  tasks: ScorecardTaskRow[];
  events: ScorecardEvent[];
  /** Only runs begun and interventions made at or after this stamp. */
  since?: string;
}

const modelOf = (r: StatRun): string => r.model ?? UNKNOWN_MODEL;

export function interventionModel(e: ScorecardEvent, runsOfTask: StatRun[]): string {
  const before = runsOfTask.filter((r) => r.started_at <= e.at);
  const run = before.length ? before[before.length - 1] : runsOfTask[0];
  return run ? modelOf(run) : UNKNOWN_MODEL;
}

export function measureByModel(input: ByModelInput): ModelMeasures[] {
  const since = input.since ?? null;
  const runs = input.runs.filter((r) => since === null || r.started_at >= since);
  const runsOf = new Map<number, StatRun[]>();
  for (const r of [...input.runs].sort((a, b) => a.started_at.localeCompare(b.started_at)))
    runsOf.set(r.task_id, [...(runsOf.get(r.task_id) ?? []), r]);
  const byTask = new Map(resolveAutoMerge(input.tasks, input.events).map((t) => [t.id, t]));

  const eventsOf = new Map<string, ScorecardEvent[]>();
  for (const e of input.events) {
    if (since !== null && e.at < since) continue;
    const model = interventionModel(e, runsOf.get(e.task_id) ?? []);
    eventsOf.set(model, [...(eventsOf.get(model) ?? []), e]);
  }
  const runsByModel = new Map<string, StatRun[]>();
  for (const r of runs) runsByModel.set(modelOf(r), [...(runsByModel.get(modelOf(r)) ?? []), r]);

  const rows = [...new Set([...runsByModel.keys(), ...eventsOf.keys()])].map((model) => ({
    model,
    measures: measure(runsByModel.get(model) ?? []),
    interventions: countInterventions(eventsOf.get(model) ?? [], byTask).total,
  }));
  return rows
    .filter((r) => r.measures.runs > 0 || r.interventions > 0)
    .sort((a, b) => (a.model === UNKNOWN_MODEL ? 1 : b.model === UNKNOWN_MODEL ? -1 : a.model.localeCompare(b.model)));
}

export function modelsTable(rows: ModelMeasures[]): string {
  const head = ['model', 'tasks', 'runs', 'first run done', 'cost/done task', 'min/done task', 'interventions'];
  return table(
    head,
    rows.map(({ model, measures: m, interventions }) => [
      model,
      String(m.tasks),
      String(m.runs),
      fmtFirstRun(m),
      num(m.cost_per_done_task, 2, '$'),
      num(m.minutes_per_done_task, 1),
      String(interventions),
    ]),
  );
}
