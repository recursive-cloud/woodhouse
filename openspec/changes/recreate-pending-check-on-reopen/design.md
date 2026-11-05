# Design

## Context

`upsertCheck` (`src/gatekeeper/handler.ts:83`) builds one body (`base` spread) and PATCHes via `octokit.checks.update` whenever `findExisting` returns a run — regardless of that run's status or the new outcome. On a reopened PR the fresh verdict is pending, `findExisting` returns the completed red run from the previous close, and the PATCH is a completed→`in_progress` regression that GitHub accepts (200) but silently ignores. Officially the Checks API documents a one-directional lifecycle; the ignore behavior is community-corroborated (kodus-ai, antifailure, understandproof), not documented.

Model for the pending state is unchanged: `pending` maps to `in_progress` (there is no "pending" Checks API status). `listCheckRuns`, including its cross-suite dedupe of same-named runs, is already correct and stays untouched.

## Goals / Non-Goals

**Goals:**
- Make a post-completion pending verdict take visible effect: create a new run (same name, same head SHA) rather than PATCH the completed node.
- Keep the decision logic a pure, hermetically tested function; handler stays thin wiring.
- Scrub `head_sha` from the update call (not an update parameter).

**Non-Goals:**
- Changing the evaluator (`evaluate.ts`), `listCheckRuns` scheduling, or the seed-and-schedule path.
- The config-validation check's unconditional POST accumulation (`src/settings/validate.ts`) — out of scope, flagged here for a future change only (also noted in the PR body).

## Decisions

**D1 — Create-vs-update decided in a pure helper (`src/gatekeeper/`).**
New pure function `resolveCheckWrite(existing: { status: string } | undefined, outcome: "pending" | "success" | "failure"): "create" | "update"` in a small module in `src/gatekeeper/`, plain data in/out. Matrix: no existing run → create; existing `status !== "completed"` (`in_progress`, `queued`, any non-terminal defensive status) → update — PATCHing anything non-completed can never be a regression; existing completed + terminal outcome → update; existing completed + pending outcome → create. Rationale: all other decision logic lives in pure functions (`evaluate.ts`, `plan.ts`, `policy.ts`) and carries the test suite; testing the matrix needs no octokit; framing the second branch as "not completed" avoids a silent fallback for status values outside the three known ones. Alternative considered: decide inline in `upsertCheck` — rejected, untestable without mocks and contrary to the architecture rule.

**D2 — `findExisting` widens deterministically; selection is the load-bearing part.**
`findExisting` currently fetches only the run `id`. It is widened to return `{ id, status }` and, when several same-name runs exist for the SHA (two suites legitimately carry two same-name runs after the first re-create), it SHALL select the newest run deterministically — the latest attempt, by `started_at` falling back to `id` asc, mirroring `evaluate.ts`'s latest-attempt dedupe. No extra request is needed: the single `listForRef(check_name, filter: "latest")` call can fetch `per_page: 100` and pick. This is what prevents a create-after-create loop: after re-creating a pending run, the next reconcile must see that `in_progress` run (not the old completed one) and PATCH. If GitHub instead attaches the new run to a sibling suite (the same-suite attachment of D3 is community-report hedged), the newest-attempt selection keeps the behavior correct regardless of suite layout or API ordering.

**D3 — On "completed existing + pending new", POST a new run; else PATCH.**
`octokit.checks.create` with the same name and `head_sha` is reported (by the corroborating projects) to attach a new run to the App's existing check suite for that SHA, with the newest same-name run superseding the old for required checks and the merge box; our contract does not depend on same-suite attachment — D2's newest-run selection gives the merge box a pending check run to wait on either way. For the update path the body is the current one minus `head_sha` (rider): build the update body without `head_sha`; `head_sha` only on create.

**D4 — Handler-level tests with a mocked octokit.**
New `test/gatekeeper/handler.test.ts` (mirroring `test/appliers/`), covering: pending-after-completed → `checks.create` called with a body asserting `objectContaining({ name: WHITE_GLOVE_CHECK_NAME, head_sha: sha, status: "in_progress" })` and no `checks.update` call; pending-after-pending → update without `head_sha` in the body; terminal-after-completed → update without `head_sha`; no existing run → create; dry-run → no octokit writes (performWrite path); and a two-same-name-runs fixture (old completed + new `in_progress`) pinning that the newest run is selected. Mock style mirrors `test/appliers/branch-protection.test.ts` (`build()` helper, `vi.fn()` octokit). Helper tests stay hermetic like `test/evaluate.test.ts`.

## Risks / Trade-offs

- [Silently-ignored PATCH is community-corroborated, not officially documented] → Our contract is our own decision matrix; tests pin what WE send, and the GitHub-observed behavior is noted as undocumented in spec/PR wording, anchored on our contract.
- [A SHA whose PR repeatedly re-enters pending could accumulate same-name runs] → Bounded by the PR lifecycle (reopen and re-request events only) and GitHub's newest-same-name supersede rule; comparable growth to re-running a workflow.
- [`findExisting` signature change ripples] → Single internal caller (`upsertCheck`); covered by impact check before edit.

## Open Questions

(None — behavior, approach and task split are settled.)
