// A parent issue labelled agentdeck:plan as a plan: its body as the plan's page, and what the issue is told as its plan branch moves.
import type { TaskId } from '#domain/shared/index.ts';
import { planSlug } from '#domain/work/plans/plan.ts';
import type { PlanBranch } from '#domain/work/plans/plan-branch.ts';
import { ISSUE_LABELS, type Issue, type IssueReport, type PlanIssueReport } from '#domain/work/issues/issue.ts';
import { isAllowed, labelRefusal } from '#domain/work/issues/sync.ts';

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

function markdownBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (!para.length) return;
    out.push(
      para.every((l) => LIST_ITEM.test(l))
        ? `<ul>${para.map((l) => `<li>${escape(l.replace(LIST_ITEM, ''))}</li>`).join('')}</ul>`
        : `<p>${para.map(escape).join('<br />')}</p>`,
    );
    para = [];
  };
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        flush();
        code = [];
      }
    } else if (code) code.push(line);
    else if (!line.trim()) flush();
    else para.push(line.trimEnd());
  }
  if (code) out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  flush();
  return out;
}

function markdownSections(body: string): { intro: string[]; steps: { title: string; lines: string[] }[] } {
  const intro: string[] = [];
  const steps: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) steps.push({ title: heading[1] ?? '', lines: [] });
    else (steps.at(-1)?.lines ?? intro).push(line);
  }
  return { intro, steps };
}

function issuePlanHtml(issue: Pick<Issue, 'number' | 'url' | 'title' | 'body'>): string {
  const title = issue.title.trim() || `Issue #${issue.number}`;
  const { intro, steps } = markdownSections(issue.body);
  const [first, ...rest] = markdownBlocks(intro);
  const summary = first?.startsWith('<p>')
    ? first.replace(/^<p>/, '<p data-plan-summary>')
    : `<p data-plan-summary>The plan of issue #${issue.number}: its sub-issues are its tasks.</p>${first ? `\n${first}` : ''}`;
  const used = new Set<string>();
  const sections = (steps.length ? steps : [{ title, lines: [] }]).map((s, i) => {
    const slug = planSlug(s.title);
    const id = used.has(slug) ? `${slug}-${i + 1}` : slug;
    used.add(id);
    const blocks = markdownBlocks(s.lines).join('\n');
    return `<section data-plan-step id="${id}" data-status="todo">\n<h2>${escape(s.title || `Step ${i + 1}`)}</h2>\n${blocks}\n</section>`;
  });
  return [
    '<!doctype html>',
    '<html lang="en" data-agentdeck-plan="1">',
    `<head><meta charset="utf-8" /><title>${escape(title)}</title><link rel="stylesheet" href="plan.css" /></head>`,
    '<body>',
    `<h1>${escape(title)}</h1>`,
    summary,
    ...rest,
    `<p>From <a href="${escape(issue.url)}">issue #${issue.number}</a>.</p>`,
    ...sections,
    '</body>',
    '</html>',
  ].join('\n');
}

/** What to do with a parent issue labelled agentdeck:plan that has no task yet. */
type PlanIntake = { kind: 'add'; title: string; prompt: string; html: string } | { kind: 'refuse'; comment: string };

export function planIntake(issue: Issue, ctx: { labelledBy: string | null; allowed: readonly string[] }): PlanIntake {
  if (!isAllowed(ctx.allowed, ctx.labelledBy))
    return { kind: 'refuse', comment: labelRefusal(ctx.allowed, ctx.labelledBy, ISSUE_LABELS.plan) };
  const title = issue.title.trim() || `Issue #${issue.number}`;
  return { kind: 'add', title, prompt: issue.body.trim() || title, html: issuePlanHtml(issue) };
}

export const planOwnerParkReason = (issue: number): string =>
  `owns the plan of issue #${issue}: its sub-issues labelled ${ISSUE_LABELS.ready} are its tasks`;

/** What to write on a parent issue now, and whether its plan branch is to be abandoned first. */
export interface PlanIssueWrite {
  to: PlanIssueReport;
  comment: string;
  close: boolean;
  abandon: boolean;
}

const PLAN_REPORT_RANK: Record<PlanIssueReport, number> = { plan_open: 0, plan_pr_open: 1, plan_merged: 2, plan_abandoned: 2 };

const isPlanReport = (r: IssueReport | null): r is PlanIssueReport => r !== null && r in PLAN_REPORT_RANK;

function planIssueWrite(
  owner: TaskId,
  issue: Pick<Issue, 'open' | 'labels'>,
  branch: Pick<PlanBranch, 'name' | 'base' | 'status' | 'pr_url'>,
): PlanIssueWrite | null {
  const { name, base, status, pr_url } = branch;
  if (status === 'landed')
    return {
      to: 'plan_merged',
      comment: pr_url ? `Merged in ${pr_url}.` : `${name} landed on ${base}.`,
      close: issue.open,
      abandon: false,
    };
  if (status === 'abandoned') return { to: 'plan_abandoned', comment: `${name} was abandoned.`, close: false, abandon: false };
  if (!issue.open || !issue.labels.includes(ISSUE_LABELS.plan)) {
    if (status !== 'open') return null;
    const why = issue.open ? `lost the ${ISSUE_LABELS.plan} label` : 'was closed';
    return {
      to: 'plan_abandoned',
      comment: `This issue ${why} before any of its tasks started, so ${name} was abandoned and its tasks went back to ${base}.`,
      close: false,
      abandon: true,
    };
  }
  if (pr_url && (status === 'landing' || status === 'partly_landed'))
    return { to: 'plan_pr_open', comment: `${name} opened its plan PR into ${base}: ${pr_url}`, close: false, abandon: false };
  return {
    to: 'plan_open',
    comment: `Opened as AgentDeck plan #${owner}. Its sub-issues labelled ${ISSUE_LABELS.ready} go on the plan branch ${name}, which lands on ${base} as one pull request.`,
    close: false,
    abandon: false,
  };
}

export function duePlanIssueWrite(
  owner: TaskId,
  issue: Pick<Issue, 'open' | 'labels'>,
  branch: Pick<PlanBranch, 'name' | 'base' | 'status' | 'pr_url'>,
  reported: IssueReport | null,
): PlanIssueWrite | null {
  const write = planIssueWrite(owner, issue, branch);
  if (!write) return null;
  const was = isPlanReport(reported) ? PLAN_REPORT_RANK[reported] : -1;
  return PLAN_REPORT_RANK[write.to] > was ? write : null;
}
