# 0006. Converge by Re-Declaration; Never Delete Protection Woodhouse Did Not Create

Status: Accepted (in force before 1.0; predates this directory)

## Context

The GitHub API cannot answer "how does this ruleset or branch protection differ from what I want?" in a form that round-trips. Normalised reads and PUTs do not compare cleanly. Rulesets carry no ownership marker, so Woodhouse cannot tell its own rulesets from hand-made ones.

## Decision

Convergence is by unconditional re-declaration: rulesets are PUT wholesale on every sync, and branch protection likewise. Woodhouse never deletes branch protection it did not create. Removing the block from config leaves the protection in place; off-boarding is the operator's job, through GitHub's "Convert to ruleset" flow.

## Consequences

- Syncs are idempotent and simple, at the cost of API calls that are sometimes unnecessary.
- `pruneRulesets` is converge-everything and will also re-declare hand-made rulesets. Operators should let Woodhouse own the rulesets it manages.
- Nobody is silently locked out of a repo by an off-boarding decision Woodhouse made alone.
