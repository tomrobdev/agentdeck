# Pilot scorecard: targets

Written on 2026-10-18, before any trial wave ran. These targets are fixed for the pilot; change them only in a separate, dated commit that says why.

The goal: a repo onboarded with one command, and tasks that become green draft PRs with nobody stepping in.

| Measure                            | Source                           | Target                                                                                                            |
| ---------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Permission refusals per wave       | `permission_denials` in run logs | 0                                                                                                                 |
| Tasks done on the first run        | `runs` table                     | ≥ 80%, reported with a Wilson 95% interval                                                                        |
| Interventions per wave             | [incidents.md](incidents.md)     | 0 by wave 2                                                                                                       |
| PRs green on CI when opened        | GitHub checks API                | 100%                                                                                                              |
| `repo doctor` on a new repo        | exit code and reason             | passes AgentDeck, demo and the Rust or Python test repo; fails the deliberately broken repo with the right reason |
| Onboarding time for an unseen repo | `repo add` to first green PR     | < 5 minutes plus one task's run time                                                                              |
| Quota spent during the pilot       | `usage_windows` deltas           | ≤ 15% of the 7-day window                                                                                         |
| Cost and minutes per merged PR     | `runs` + GitHub                  | recorded, no target yet                                                                                           |

Baseline before the integration work: 7 interventions, 6 of 6 tasks blocked on the first run, and 0 PRs opened automatically.
