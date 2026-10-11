# Proposal

## Why

When a pull request changes `woodhouse.yml` and merges, Woodhouse applies
the new settings silently — the outcome (what changed, what failed) never
leaves the log, and the settings author gets no confirmation on the PR they
merged. Compounding it, nothing today links a default-branch push back to its
originating pull request, so "comment back on the original PR" needs its own
linkage: the `pull_request.closed` (merged) event carries the pull request
number directly and works for every merge strategy, which the alternatives
do not (parsing `(#N)` from merge-commit messages breaks on rebase merges and
custom messages; searching issues by SHA fights search-index lag).

## What Changes

- New `pull_request.closed` listener for **merged** pull requests: when the
  merged PR touched a settings file (added, modified *or removed* — deleting
  the local layer is a settings change too) and merged into the default
  branch, Woodhouse runs the settings sync for that repository and comments
  on the PR reporting the outcome.
- The comment reports the real apply outcome — what was applied per area and
  any failures collected — not just "done"; when nothing needed changing it
  says so honestly.
- The comment is managed by the shared marker-based commenter
  (`<!-- woodhouse:settings-applied -->`), so re-deliveries update in place
  instead of duplicating.
- The push trigger stays authoritative for direct pushes (no PR, no comment)
  and both triggers now run the sync under a per-repository mutex, so the
  closed delivery and the merge push cannot interleave a double-apply (a
  second pass is a safe, idempotent retry of whatever the first left behind).
- The closed handler invalidates the repo's config cache before resolving —
  delivery order between `pull_request.closed` and `push` is not guaranteed.
- Baseline-repository merged PRs get a truthful variant: the baseline itself
  was synced, and other repositories adopt the change at their next event
  (the cascade does not fan out today).
- Settings-disabled repositories stay silent (including a PR that just
  disabled settings); dry-run logs the would-be comment and writes nothing.

## Capabilities

### New Capabilities

- `settings-sync`: keeping repositories aligned with their cascaded
  `woodhouse.yml` settings — what triggers a sync (default-branch push,
  merged settings pull request), the outcome comment reported on the
  originating pull request, honest failure reporting, baseline behavior, and
  per-repository serialization.

### Modified Capabilities

- none — the project has no specs yet; the existing default-branch push
  behavior is captured as part of the new `settings-sync` capability's
  requirements.

## Impact

- `src/app.ts` (new `pull_request.closed` listener; push handler adopts the
  mutex and shared cache-invalidation helper), new
  `src/settings/mergeFeedback.ts` (handler logic + pure comment builder),
  `src/lib/mutex.ts` (adopted by settings sync, repo-scoped key).
- Rides on `refactor-feedback-seams` (marker commenter, `listChangedFiles`,
  `isSettingsPath`) and `refactor-apply-pipeline` (`ApplySummary`).
- `README.md` and `docs/test-plan.md` document the new feedback.
