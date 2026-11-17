# 0010. Check-Name Matching Is Case-Sensitive

Status: Accepted (2026-11-16, operator decision on the REC-21 review)

## Context

`gatekeeper.strictChecks` and `gatekeeper.ignoredChecks` select check runs by name. The evaluator lowercased both sides of the comparison, so an entry `build` matched a run named `Build`, and a skipped `Security-Scan` silently failed to fail a `security-scan` requirement in the direction the operator did not intend. The config schema documents ignoredChecks as excluded "by exact name"; the code did not honour that.

## Decision

Check names in `strictChecks` and `ignoredChecks` match exactly, character for character, after trimming. The executable spec (`features/gatekeeper/verdict.feature`, "A strict check must report success explicitly") pins the behaviour in both directions: different case does not satisfy a strict requirement, identical case does.

## Consequences

- An operator whose workflow produces `Lint` but lists `lint` gets a pending white-glove check naming the missing check, which is loud and fixable, instead of a silently waived requirement.
- The schema's "by exact name" wording for ignoredChecks is now true for both lists.
- Duplicate-run collapsing across suites (`dedupeLatest`) keeps its own name grouping; this decision governs config-list matching only. A collapsed mixed-case same-name group matches the config lists only through its surviving run's exact name, so a case difference there fails closed as a missing strict check.
