// Reading gh's JSON about issues into the domain's values, keeping only what is well formed.
import type { Issue, IssueBlocker, IssueCloseReason, IssueComment } from '#domain/work/issues/issue.ts';

export const ISSUE_FIELDS = 'number,url,title,body,state,stateReason,labels,blockedBy,parent';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function listOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v) && Array.isArray(v.nodes)) return v.nodes;
  return [];
}

function closeReason(state: string, reason: string): IssueCloseReason | null {
  if (state.toUpperCase() !== 'CLOSED') return null;
  return reason.toUpperCase() === 'NOT_PLANNED' ? 'not_planned' : 'completed';
}

function blockerOf(v: unknown): IssueBlocker | null {
  if (!isObject(v) || typeof v.number !== 'number') return null;
  return { number: v.number, open: str(v.state).toUpperCase() !== 'CLOSED' };
}

export function issueOf(v: unknown): Issue | null {
  if (!isObject(v) || typeof v.number !== 'number') return null;
  const state = str(v.state);
  const parent = isObject(v.parent) && typeof v.parent.number === 'number' ? v.parent : null;
  return {
    number: v.number,
    url: str(v.url),
    title: str(v.title),
    body: str(v.body),
    open: state.toUpperCase() !== 'CLOSED',
    closed_as: closeReason(state, str(v.stateReason)),
    labels: listOf(v.labels).flatMap((l) => (isObject(l) && typeof l.name === 'string' ? [l.name] : [])),
    blocked_by: listOf(v.blockedBy).flatMap((b) => blockerOf(b) ?? []),
    parent: parent ? { number: Number(parent.number), title: str(parent.title), body: str(parent.body) } : null,
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseIssues(text: string): Issue[] {
  const raw = parse(text);
  if (!Array.isArray(raw)) throw new Error('gh issue list did not answer with a list');
  return raw.flatMap((v) => issueOf(v) ?? []);
}

export const parseIssue = (text: string): Issue | null => issueOf(parse(text));

export function parseIssueComments(text: string): IssueComment[] {
  const v = parse(text);
  return listOf(isObject(v) ? v.comments : null).flatMap((c) =>
    isObject(c) ? [{ author: isObject(c.author) ? str(c.author.login) : '', body: str(c.body), created_at: str(c.createdAt) }] : [],
  );
}

export function labelledBy(text: string, label: string): string | null {
  const events = listOf(parse(text)).filter(
    (e): e is Json => isObject(e) && e.event === 'labeled' && isObject(e.label) && e.label.name === label,
  );
  const last = events.at(-1);
  return last && isObject(last.actor) ? str(last.actor.login) || null : null;
}
