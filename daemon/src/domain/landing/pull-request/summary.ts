// The summary a done run ends with: it becomes the pull request's body and the Overview's pull request card.

const DIAGRAM_RULE = `Add one mermaid diagram only when the change does one of these:
  - changes the architecture: adds, removes or moves a component, layer or boundary (flowchart);
  - changes how models or systems interact: a call, relation, event or integration between them (sequenceDiagram, or erDiagram for models);
  - adds or changes a state machine, a process or a flow of events: a status, step or transition (stateDiagram-v2 or flowchart).
  Draw how it works after the change, in at most 15 nodes, and mark what changed. Never for anything else: a fix inside one function, copy, styling, tests, config or a rename.`;

export const PR_SUMMARY_FORMAT = `A short summary for the reviewer, written as bullets in these sections, in this order:
  ## Overview
  ## Frontend
  ## Backend
  ## Diagram
  Rules: bullets only, one line each, at most 5 per section, except Diagram, which is one \`\`\`mermaid block. Put file names in backticks. Never write "I". Leave out a section with nothing in it.
  Overview says what changed and why, and how it was checked (name any test the sandbox broke).
  Frontend is what the user sees or the dashboard code; Backend is the daemon, data and everything else.
  Diagram: ${DIAGRAM_RULE}`;
