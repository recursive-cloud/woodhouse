# 0012. Deployment Branch Policies Under a Configured Environment Are Converged

Status: Accepted (2026-11-26, operator decision on the REC-35 spec)

## Context

An environment in custom branch-policy mode carries an allowlist of branch patterns. GitHub holds that allowlist on the environment, outside the cascading config that governs the rest of the repository. Without converging it, the declared allowlist drifts from the repository's actual one, and deployments stop matching what the baseline declares.

The REST API models the mode as a mutually exclusive object: `deployment_branch_policy` is either `{ protected_branches: true }` or `{ custom_branch_policies: true }`. The config therefore cannot mirror the payload the way the other environment fields do.

Full convergence includes deleting patterns the config no longer names. ADR 0011's never-deleted posture avoided that deletion: the posture exists so nobody loses an environment, and its deployment history, to an off-boarding decision Woodhouse made alone. A pattern under a configured environment has no such history to lose. The operator approved full convergence, including deletion, for this work (2026-11-25).

## Decision

A configured environment's deployment branch policies converge fully. Patterns are created when missing from the environment and deleted when absent from the configured list. A mode switch re-declares the patterns after the flip. The configured list is the environment's whole deployment allowlist.

The config carries a plain mode string, `"protected"` or `"custom"`. The applier maps it to the REST API's mutually exclusive `deployment_branch_policy` object. The config schema documents that deviation from REST mirroring. Pattern names that collide, differing only in case, are rejected at authoring time, mirroring the ruleset-name precedent.

## Consequences

- Pattern deletion is intended behaviour. This amends ADR 0011's never-deleted posture for branch policies only; environments themselves are still never deleted.
- Deployment allowlist changes route through config. A hand-made pattern edit under a configured environment is reverted on the next sync.
- Authoring-time rejection keeps a config internally consistent: no pattern list without custom mode, no case-variant collisions. A sync never guesses.
- The API's 303 already-exists response on create is tolerated as already-present. The pattern listing cannot distinguish branch from tag policies, so a tag policy under a configured environment is also removed when the config does not name it. Woodhouse itself only ever creates branch policies.
