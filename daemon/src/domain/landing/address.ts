// How a run addresses a review: the comments as the worker is shown them, and the answers it gives back. Pure: no I/O.
import { STATUS_TAIL, cut, plural } from '../shared/text.ts';
import { type CommentSide, type ReviewComment, type ReviewWithComments, commentLocation, submittedRequests } from './review.ts';

/** The most the review may take of a prompt, in characters. Past it, hunks are dropped and long comments cut, and the prompt says so. */
export const REVIEW_PROMPT_BUDGET = 16000;
/** Diff lines kept either side of the commented line. */
export const HUNK_RADIUS = 3;
const MAX_LINE_CHARS = 200;
const MAX_COMMENT_CHARS = 2000;
const SHORT_COMMENT_CHARS = 300;

/** The short id a comment goes by in the prompt: its position (from 0) in the list the worker is given. */
export const commentLabel = (index: number): string => `c${index + 1}`;

/** The overall note of the latest submitted Request changes review ('' when there is none). */
export function latestRequestNote(reviews: ReviewWithComments[]): string {
  return submittedRequests(reviews).at(-1)?.body.trim() ?? '';
}

/**
 * The lines of a unified diff within `radius` of line `line` on `side`, with the header of the hunk they are in.
 * Null when the line is not in the diff (a comment on a line the patch doesn't show).
 */
export function hunkAround(patch: string, side: CommentSide, line: number, radius: number = HUNK_RADIUS): string | null {
  interface Row {
    text: string;
    old: number | null;
    new: number | null;
    header: number;
  }
  const headers: string[] = [];
  const rows: Row[] = [];
  let oldN = 0;
  let newN = 0;
  for (const text of patch.split('\n')) {
    const h = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) {
      headers.push(text);
      oldN = Number(h[1]);
      newN = Number(h[2]);
    } else if (headers.length && text[0] === '+') {
      rows.push({ text, old: null, new: newN++, header: headers.length - 1 });
    } else if (headers.length && text[0] === '-') {
      rows.push({ text, old: oldN++, new: null, header: headers.length - 1 });
    } else if (headers.length && (text[0] === ' ' || text === '')) {
      rows.push({ text, old: oldN++, new: newN++, header: headers.length - 1 });
    }
  }
  const at = rows.findIndex((r) => r[side] === line);
  if (at < 0) return null;
  const header = rows[at].header;
  let from = at;
  while (from > 0 && at - from < radius && rows[from - 1].header === header) from--;
  let to = at;
  while (to < rows.length - 1 && to - at < radius && rows[to + 1].header === header) to++;
  return [headers[header], ...rows.slice(from, to + 1).map((r) => r.text)].map((l) => cut(l, MAX_LINE_CHARS)).join('\n');
}

/** A comment and the diff around it at the commit it was made on (null when that can't be shown). */
export interface CommentInView {
  comment: Pick<ReviewComment, 'path' | 'line' | 'side' | 'body'>;
  hunk: string | null;
}

/** What the worker is shown of the review it addresses. */
export interface ReviewPrompt {
  comments: CommentInView[];
  /** The review's overall note. */
  note: string;
}

export const REVIEW_PROMPT_INTRO =
  'Changes requested in review. Address every comment below, then end your final message with one line per comment, before the STATUS line:\nANSWER c1: <what you did, or why not>';

/**
 * The review as the prompt carries it: each comment with its id (c1, c2…), `path:line`, the diff around it and its text,
 * then the overall note. It stays within REVIEW_PROMPT_BUDGET: later comments lose their hunk first, then get cut short,
 * and a closing line says what was left out.
 */
export function reviewPromptBlock(review: ReviewPrompt): string {
  let used = REVIEW_PROMPT_INTRO.length + review.note.length;
  let droppedHunks = 0;
  let cutComments = 0;
  const entries = review.comments.map(({ comment, hunk }, i) => {
    const head = `${commentLabel(i)} — ${commentLocation(comment)}`;
    const render = (withHunk: string | null, body: string) =>
      [head, ...(withHunk ? ['````diff', withHunk, '````'] : []), `Comment: ${body}`].join('\n');
    const full = cut(comment.body, MAX_COMMENT_CHARS);
    let body = full;
    let entry = render(hunk, body);
    if (used + entry.length > REVIEW_PROMPT_BUDGET) {
      if (hunk) droppedHunks++;
      entry = render(null, body);
    }
    if (used + entry.length > REVIEW_PROMPT_BUDGET) {
      body = cut(comment.body, SHORT_COMMENT_CHARS);
      entry = render(null, body);
    }
    if (body.length < comment.body.length) cutComments++;
    used += entry.length;
    return entry;
  });
  const left = [
    droppedHunks ? `the diff of ${plural(droppedHunks, 'comment')}` : '',
    cutComments ? `the text of ${plural(cutComments, 'comment')} (cut short)` : '',
  ].filter(Boolean);
  return [
    REVIEW_PROMPT_INTRO,
    '',
    ...entries.flatMap((e) => [e, '']),
    ...(left.length
      ? [`(This review was too long for the prompt, so it leaves out ${left.join(' and ')}. Read the files for the rest.)`, '']
      : []),
    ...(review.note ? ['Overall note:', review.note, ''] : []),
  ]
    .join('\n')
    .trimEnd();
}

/** The `ANSWER cN: …` lines of a final message, by comment id (lowercase). A repeated id keeps its last answer. */
export function parseAnswers(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(/^\s*ANSWER\s+(c\d+)\s*:\s*(.*?)\s*$/i);
    if (m && m[2]) out.set(m[1].toLowerCase(), m[2]);
  }
  return out;
}

/** The comments a run was given, split by whether its final message answered them. `index` is the comment's place in the list. */
export function matchAnswers<C>(
  comments: C[],
  text: string | null | undefined,
): { answered: { comment: C; index: number; answer: string }[]; unanswered: { comment: C; index: number }[] } {
  const answers = parseAnswers(text);
  const answered: { comment: C; index: number; answer: string }[] = [];
  const unanswered: { comment: C; index: number }[] = [];
  comments.forEach((comment, index) => {
    const answer = answers.get(commentLabel(index));
    if (answer) answered.push({ comment, index, answer });
    else unanswered.push({ comment, index });
  });
  return { answered, unanswered };
}

/** The line for a run's summary naming the comments that got no answer. */
export function unansweredNote(unanswered: { comment: Pick<ReviewComment, 'path' | 'line' | 'side'>; index: number }[]): string {
  return `Review comments left open, with no answer: ${unanswered.map((u) => `${commentLabel(u.index)} (${commentLocation(u.comment)})`).join(', ')}.`;
}

/** A final message with `note` added before its closing STATUS line (after it, if it has none), so the STATUS line stays last. */
export function withNote(text: string, note: string): string {
  const m = text.match(STATUS_TAIL);
  if (!m || m.index === undefined) return `${text.trimEnd()}\n\n${note}`;
  return `${text.slice(0, m.index).trimEnd()}\n\n${note}\n${m[0].trim()}`;
}
