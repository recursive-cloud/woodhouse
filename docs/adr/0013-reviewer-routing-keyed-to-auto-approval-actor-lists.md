# 0013. Reviewer Routing Is Keyed to the Auto-Approval Actor Lists

Status: Accepted (2026-11-27, REC-43)

## Context

Renovate's own reviewer config routes some pull requests to the owner and leaves others unreviewed, so bot pull requests sometimes wait on humans unnecessarily. Woodhouse already classifies pull-request authors against `autoApproval.allowedActors` (owners and bots) and reads the auto-merge fact from the live pull request; the same trust model can decide who should be asked to review.

## Decision

On `pull_request` opened, reopened, ready_for_review and synchronize, Woodhouse requests one routed reviewer set, derived from the auto-approval actor lists: an owner-listed author is routed to Woodhouse itself; a bot-listed author that enabled auto-merge itself is routed to Woodhouse; every other author — a bot without its own auto-merge or an unlisted author — is routed to every listed owner. When `autoApproval.enabled` is false Woodhouse never requests itself: bot and neither-list pull requests still route to the owners, and an owner's own pull request gets no request. Draft pull requests are routed only once they become ready for review.

Routing is a replacement: each pass diffs the desired set against the set the previous pass requested and withdraws the difference, so a pull request carries one routed set at a time. Only sets Woodhouse routed are tracked, in memory, per App process; requests made by others are never withdrawn. A restart forgets the tracked set; the next pass re-requests it, which is idempotent on GitHub.

The executable spec is `features/review-routing/routing.feature`. The decision logic is pure (`src/approval/routing.ts`, function `route`), beside the auto-approval policy it mirrors.

## Consequences

- No new configuration: routing reads `autoApproval.enabled` and `autoApproval.allowedActors` only, so the generated JSON Schema does not change.
- Woodhouse appears as a requested reviewer on owner and self-auto-merged bot pull requests, which reaches the operator through GitHub's review-request notifications, the same signal the maintainer-agent workflow relies on.
- The tracked set lives in memory; the "Accepted tradeoffs" section of TODO.md records that it is never evicted on close or merge and that a restart costs a redundant, idempotent re-request.
- Approval timing is a separate concern (Linear REC-44) and stays independent of routing: a routed reviewer set does not imply an approval.
