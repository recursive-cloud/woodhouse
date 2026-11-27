# 0013. Approval Is Gated on the White-Glove Evaluation

Status: Accepted (2026-11-27, REC-44)
Date: 2026-11-27
Issue: REC-44

## Context

Auto-approval used to fire on `pull_request` events: opened, reopened, synchronize and ready_for_review. Its binding approval could therefore land on a commit whose checks were red or had not started. An approval carries the same signal as the white-glove check.

The check evaluation is a shared funnel. Check-run completion, check-suite completion, pull-request events, rerequested events and the scheduled grace recheck all reach `reconcile()`. Repositories with no checks resolve as success only after the grace period, the posture already recorded in the gatekeeper grace scenarios.

The policy guards stay where they are: drafts, protected paths, non-actors, already-approved-at-commit, commit pinning and dry run. They live in the pure policy in `policy.ts`, and this decision does not change them.

## Decision

We will approve a pull request only after the white-glove evaluation of its head commit concludes success.

The hook is an optional `onSuccess` callback on `ReconcileDeps`. `reconcile()` invokes it after the check write, still inside the per-commit mutex, and only for a success verdict.

The approval pass is commit-level. It resolves the open pull requests headed by the commit, re-fetches each one, skips any whose head SHA moved or that is no longer open, and evaluates each independently against live state.

`pull_request.ready_for_review` now seeds the evaluation. This is a gatekeeper behavior change: gatekeeper evaluates, and can write its check, on that action too.

With `gatekeeper.enabled` false there is no evaluation, so checks-gated approval is off.

## Options Considered

- Per-event handler wiring in `app.ts`: rejected. It needs four wiring points, the scheduled grace recheck would need its own, and the copies drift.
- Keep the opened-event two-second auto-merge grace sleep: rejected. The pass always re-fetches the live pull request, so there is no stale webhook snapshot to wait out, and no `pull_request` action exists at commit level.
- A wrapper around `reconcile()` in `app.ts`: rejected. The callback keeps one hook point and stays inside the mutex.

## Consequences

- Easier: approval timing and check verdicts can no longer disagree. The grace-recheck path approves no-CI repositories without extra wiring.
- Accepted tradeoff: a hook rejection is logged, not thrown. The check write already happened, the next event for the commit re-runs the pass, and already-approved-at-commit keeps it idempotent.
- Accepted tradeoff: the bot auto-merge residual race. If the commit's last check completes before the bot's auto-merge toggle lands, the pass reads nobody-enabled and refuses. Recovery needs a later event on the same commit. This is fail-safe: no wrong approval, the same posture as the old late-toggle behavior.
- Accepted tradeoff: the approval pass's API calls run inside the per-commit mutex, so a slow call holds that commit's queue. This was already true of the check write, and it is bounded per commit.
