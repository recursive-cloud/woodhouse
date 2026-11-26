# 0011. Repository Environments Are Never Deleted; They Converge by Full Re-Declaration

Status: Accepted (2026-11-25, operator decision on the REC-34 review)

## Context

Deployment environment protection rules are configured by hand today: wait timers, required reviewers and the rest live in the GitHub UI, outside the cascading config that already governs repository options, labels, branch protection and rulesets. The baseline should declare them once, and every managed repository should converge on the next sync.

The environment PUT cannot distinguish a create from an update. There is no read that round-trips cleanly enough to diff against, so a sync cannot know whether a write is needed. The desired state has to be re-declared.

## Decision

Every configured environment is PUT wholesale on every sync with its complete desired state: the fields that are set, and the API defaults for those that are not. Convergence is by re-declaration, extending to deployment environments the posture ADR 0006 set for rulesets and branch protection.

Environments are never deleted. Removing an entry from config only stops the re-assertion; matching is by exact declared name, so a case-variant environment already on the repository is left untouched. Off-boarding an environment is the operator's job, by hand.

## Consequences

- Syncs stay idempotent and simple, at the cost of writes that are sometimes unnecessary.
- Nobody loses an environment, and its deployment history, to an off-boarding decision Woodhouse made alone.
- Amended by ADR 0012: branch policies under a configured environment converge fully, including deletion. Environments themselves are still never deleted.
