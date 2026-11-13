# 0003. Pure Decision Core, Separate From the API Layer

Status: Accepted (in force before 1.0; predates this directory)

## Context

White-glove verdicts, settings plans and approval decisions are logic that must be cheap to test and easy to reason about. Coupling that logic to GitHub API calls makes tests slow and behaviour hard to see.

## Decision

Decision logic lives in pure functions over plain data and holds the bulk of the test suite: `src/gatekeeper/evaluate.ts`, `src/settings/plan.ts` and `src/approval/policy.ts`. The applier modules own the API calls and side effects. New decision logic goes into the pure core and is tested the same way: hermetic unit tests with plain fakes, no network, no environment and no Docker.

## Consequences

- Every decision path is testable without stubbing GitHub.
- Appliers stay thin: they translate a decided plan into API calls and make no decisions of their own.
