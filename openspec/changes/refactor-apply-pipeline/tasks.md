# Tasks

## 1. Summary types + pure formatter

- [x] 1.1 Create `src/settings/appliers/types.ts` with `ApplierContext`,
      `ChangeRecord`, `Failure`, `ApplierResult` per design D1 (plain records:
      area, action, target; failure message carries the final detail text).
- [x] 1.2 Create `src/settings/summary.ts` with the `ApplySummary` type and
      pure `formatApplySummary(summary)` producing the live and dry-run
      summary lines (same information as today's log). Verify with
      `test/summary.test.ts`: empty summary, mixed changes and failures,
      dry-run variant.
- [x] 1.3 Run `npm test && npm run typecheck`.

## 2. Repository applier (high-risk — privileged writes)

- [x] 2.1 Move `applyRepository` (with its topics flow) to
      `src/settings/appliers/repository.ts` onto the D1 applier shape,
      preserving the archived-repository skip and today's error handling
      (failure messages per design D1); no other behavior change. Verify with a characterization test file
      (fake octokit): repository PATCH fires per the plan, topics flow per
      `topicsDiffer`, no call when the plan is empty, dry-run performs zero
      calls.
- [x] 2.2 Run `npm test && npm run typecheck`.

## 3. Labels applier (high-risk — privileged writes)

- [x] 3.1 Move `applyLabels` to `src/settings/appliers/labels.ts` onto the
      applier shape. Verify with characterization tests: create/rename/update
      /delete fire per `planLabels`, nothing fires on an empty plan, errors
      are thrown to the orchestrator where they are collected, dry-run
      performs zero calls.
- [x] 3.2 Run `npm test && npm run typecheck`.

## 4. Forbidden + branch-protection applier (high-risk — privileged writes)

- [x] 4.1 Move `describeForbidden` unchanged to `src/settings/forbidden.ts`
      and re-point `test/plan.test.ts`'s import (mechanical); verify the file
      passes unmodified otherwise.
- [x] 4.2 Move `applyBranchProtection` to
      `src/settings/appliers/branch-protection.ts` onto the applier shape.
      Verify with characterization tests: PUT per planned protection entry,
      403 collects a failure whose message carries the `describeForbidden`
      detail (deliberate, per design D1 — pinned exactly by the test),
      today's 404/other-error handling is preserved, dry-run performs zero
      calls.
- [x] 4.3 Run `npm test && npm run typecheck`.

## 5. Rulesets applier (high-risk — privileged writes)

- [x] 5.1 Move `applyRulesets` to `src/settings/appliers/rulesets.ts` onto
      the applier shape, preserving the always-PUT semantics (rulesets are
      never diffed; see `settings/plan.ts`). Verify with characterization
      tests: PUT per ruleset, 403 collects a `describeForbidden` failure
      (message content pinned) and sync continues, dry-run performs zero
      calls.
- [x] 5.2 Run `npm test && npm run typecheck`.

## 6. Orchestrator (high-risk — privileged writes)

- [x] 6.1 Create `src/settings/appliers/index.ts` re-exporting the appliers
      and owning the ordered `APPLIERS` array with its rulesets-last rationale
      comment (order declared exactly once); make `syncSettings` in
      `src/settings/apply.ts` the thin orchestrator per design D2 — enabled
      short-circuit, sequential loop, failure aggregation, summary logging
      through `formatApplySummary`, and a returned `ApplySummary`.
- [x] 6.2 Add orchestrator characterization tests: applier order is
      observable in the recorded call sequence, changes and failures
      aggregate correctly, `settings.enabled === false` performs zero calls,
      dry-run performs zero calls and logs through the formatter.
- [x] 6.3 Run `mise run ci` (oxlint, oxfmt, typecheck, tests, build, schema
      drift check) and confirm `git diff --stat -- schema/` is empty.
