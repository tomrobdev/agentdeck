// The summary a done run ends with: it becomes the pull request's body and the Overview's pull request card. Pure.

/** The format and its rules, as the worker's system prompt gives them. The only place this text is written. */
export const PR_SUMMARY_FORMAT = `A short summary for the reviewer, written as bullets in these sections, in this order:
  ## Overview
  ## Frontend
  ## Backend
  Rules: bullets only, one line each, at most 5 per section. Put file names in backticks. Never write "I". Leave out a section with nothing in it.
  Overview says what changed and why, and how it was checked (name any test the sandbox broke).
  Frontend is what the user sees or the dashboard code; Backend is the daemon, data and everything else.`;
