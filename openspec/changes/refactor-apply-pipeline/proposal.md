# Proposal

## Why

`src/settings/apply.ts` is the project's largest module (435 lines) and its
least tested — only the pure `describeForbidden` has any coverage. The four
appliers (`applyRepository`, `applyLabels`, `applyBranchProtection`,
`applyRulesets`, 54-73 lines each) hold payload mapping, API calls, dry-run
gating and failure collection inline, and the result of a sync never leaves
the log. The next change on the roadmap (`comment-settings-applied-on-merge`)
needs that result as *data* — an apply summary to comment back on the merged
pull request — and would otherwise grow the monolith further.

## What Changes

- The four appliers move to one module each under `src/settings/appliers/`
  (repository, labels, branch-protection, rulesets) with a common applier
  shape; `syncSettings` becomes a thin ordered orchestrator
  (repository -> labels -> branch-protection -> rulesets-last — order and
  its rationale comment unchanged).
- New typed **`ApplySummary`**: per-applier change records and failures,
  aggregated by `syncSettings` and returned to callers — today the result
  only reaches the log.
- A pure formatter turns an `ApplySummary` into the summary-log text; the
  live and dry-run log lines go through it.
- `describeForbidden` moves to its own pure module next to its users.
- **Deliberate wording improvement (internal):** a collected failure's
  message carries the human explanation when a 403 is classified — today
  the detail only reaches the log and the record keeps the raw GitHub
  message. This surfaces to users only in
  `comment-settings-applied-on-merge`'s outcome comment.
- **Characterization tests** with a fake octokit for every applier and the
  orchestrator — the first tests for the settings-sync write path, covering
  the plan-to-API mapping, failure collection, and dry-run writing nothing.

No observable GitHub behavior changes; no config schema change; the
`schema/woodhouse.schema.json` artifact is untouched.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- none

Pure refactor: no spec-level behavior changes, so this change sets
`skip_specs: true` in `.openspec.yaml`.

## Impact

- `src/settings/apply.ts` (decomposed); new `src/settings/appliers/*`,
  `src/settings/forbidden.ts`, `src/settings/summary.ts` (names indicative,
  decided in design).
- `test/plan.test.ts` (`describeForbidden` import re-pointed); new
  characterization test files under `test/`.
- Soft dependency: apply after `refactor-feedback-seams`, so the per-write
  dry-run gates move as already-guarded code. If the order is reversed, the
  gates move with the code and change 1 rewrites them afterward.
- Unblocks `comment-settings-applied-on-merge`, which consumes the
  `ApplySummary` as data.
