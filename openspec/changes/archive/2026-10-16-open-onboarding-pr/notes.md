# Notes

## Whole-change verification (2026-10-15)

Whole-change verification pass (reviewer-pro, openspec-verify-change):
**PASS** — no critical issues, no warnings. Gates re-run independently:
`npm test` (33 files, 415 tests), `npm run typecheck`, `mise run ci`,
`npm run schema:check` ("up to date"), `openspec validate
open-onboarding-pr` — all green; the whole-change diff was audited
directly (not from the author's summary). 8/8 tasks complete with
evidence; all six ADDED requirements traced requirement-by-requirement
to code and tests (9/9 delta scenarios covered); design D1–D5 followed;
all four non-goals honored; the diff touched exactly the eleven files
the proposal names. Two suggestions, recorded as follow-up material and
deliberately not implemented in this change:

1. **Label-write failure edge** (`src/onboarding/handler.ts:146`): if
   `issues.addLabels` fails after the pull request is created (an
   installation granted `pull_requests: write` but not `issues: write`),
   the open pull request is unlabeled, so the open-offer check misses it
   and every later re-delivery re-attempts `pulls.create`, hitting
   GitHub's 422 and logging an error indefinitely until an operator
   intervenes. The spec's idempotency scenario still holds — GitHub
   refuses the duplicate — but the "search by label + head branch" key
   degrades to retry noise on this edge. Follow-up: also accept an open
   pull request from the head branch without the label as "onboarding
   pull request open", or diagnose the 422 into a distinct skip, so a
   label-write failure still yields idempotent silence.
2. **Concurrent-delivery race** (`src/onboarding/handler.ts:198-222`):
   two concurrent qualifying deliveries (e.g. `created` redelivered
   while the first is mid-walk) can both pass the probe before the pull
   request exists; the loser fails closed with a caught 422. Accepted
   at homelab scale and consistent with the idempotency-without-state
   goal. Follow-up: document the race in the README's "Two things worth
   knowing", next to the all-repositories caveat.

## Follow-through (post-merge, 2026-10-16)

- PR #20 squash-merged as `f9846fd` ("feat(onboarding): offer an
  onboarding pull request on install (#20)"); workspace main
  fast-forwarded clean.
- No live installation has exercised the flow yet — acceptance testing
  on a real repository (test-plan Phase 0) is where this capability
  gets demonstrated.
