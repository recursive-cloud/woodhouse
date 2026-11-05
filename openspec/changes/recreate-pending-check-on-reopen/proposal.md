# Proposal

## Why

On a reopened pull request, the `woodhouse/white-glove` check re-enters pending, but the check run it PATCHes is the completed red run from the previous close — GitHub accepts the completed→in_progress regression with a 200 yet silently ignores it (behavior corroborated by several independent projects; not officially documented). The result is a split state shown in issue #27: the PR title bar says "Waiting on 1 check" while the check itself displays a stale red failure, indefinitely.

## What Changes

- `upsertCheck` (`src/gatekeeper/handler.ts`) gains a create-vs-update decision, extracted into a new pure helper in `src/gatekeeper/` so handler.ts stays thin:
  - no existing run → create a new check run (unchanged)
  - existing run not completed (`in_progress`/`queued`/non-terminal) → update the existing run (unchanged, never a regression)
  - existing run completed and the new evaluation is also terminal → update the existing run (unchanged)
  - existing run completed and the new evaluation is pending (`in_progress`) → **create a NEW check run** with the same name and head SHA instead of PATCHing the completed one. GitHub attaches it to the App's existing check suite for that SHA, and the newest same-name run supersedes the old one for required checks and the merge box.
- Rider: stop sending `head_sha` in `octokit.checks.update` bodies (it is not an update parameter and is currently spread into both calls).
- First handler-level tests for `src/gatekeeper/handler.ts` (currently untested; only the pure evaluator has coverage), with a mocked octokit mirroring `test/appliers/branch-protection.test.ts` style, plus a new hermetic pure-helper test.

## Capabilities

### New Capabilities

(None)

### Modified Capabilities

- `gatekeeper`: the "A consolidated check is maintained per pull request" requirement changes from always updating the existing run in place to re-creating a new run (same name, head SHA) when a fresh pending evaluation would otherwise hit a completed run of the same name on the same commit — the case GitHub silently refuses to regress.

## Impact

- `src/gatekeeper/handler.ts` (`upsertCheck`, `findExisting`) — patched paths and the new helper wiring.
- New pure helper file in `src/gatekeeper/`.
- New tests: `test/gatekeeper/` handler tests + a helper test; no change to existing files' behavior except the fixed stale-red case.
- Out of scope: the config-validation check's unconditional POST accumulation in `src/settings/validate.ts` — flagged here for a future change only (also noted in the PR body); nothing is touched.
