# Design

## Context

See proposal.md (Why) for the motivation. `src/settings/apply.ts` today:
`syncSettings` (the orchestrator) runs the four appliers sequentially in a
fixed order — repository, labels, branch-protection, rulesets-last (rulesets
last because they can restrict what the App itself is permitted to do) —
collecting failures instead of throwing; each applier (54-73 lines) maps its
plan from `settings/plan.ts` to API calls inline; `describeForbidden` (pure,
tested via `test/plan.test.ts`) classifies 403s; the archived-repository skip
and the `settings.enabled` short-circuit guard entry; the only output is the
summary log line. Sequential `await`s in the loop are deliberate (pacing
writes against rate limits; `no-await-in-loop` stays off). After
`refactor-feedback-seams`, per-write dry-run gating goes through the
`performWrite` helper.

## Goals / Non-Goals

**Goals:**

- One module per settings area under `src/settings/appliers/`, with a common
  applier shape; `syncSettings` a thin orchestrator.
- A typed `ApplySummary` (change records + failures) returned to callers and
  produced by a pure formatter for the summary log.
- Characterization tests with a fake octokit for every applier and the
  orchestrator — first coverage of the settings-sync write path.
- Behavior preserved — applier order, failure collection, skip rules,
  dry-run semantics, log-line intent — with one deliberate wording
  improvement: failure messages carry the classified-403 explanation (D1).

**Non-Goals:**

- No mutex/concurrency changes (that lands with
  `comment-settings-applied-on-merge`, where the second trigger appears).
- No changes to `settings/plan.ts` (pure and tested; appliers keep consuming
  its plans).
- No new GitHub calls, no schema changes, no CI/deploy changes.

## Decisions

### D1: applier shape — plain function, plain result

`type Applier = (ctx: ApplierContext, config: WoodhouseConfig) => Promise<ApplierResult>`
with `ApplierResult = { changes: ChangeRecord[]; failures: Failure[] }`.
`ChangeRecord` is a small plain record (area, action, target) — enough to
render logs now and the merged-PR comment later without re-fetching anything.
`Failure` is `{ area, message }` — and the message deliberately carries the
human explanation when a 403 is classified: today the collected record keeps
the raw GitHub message while `describeForbidden` output only reaches the
log. Folding it in is a deliberate wording improvement, pinned by the
characterization tests, which `comment-settings-applied-on-merge` later
surfaces in its outcome comment.

Rationale: matches the project's plain-functions-over-plain-data convention.
Alternatives: throwing per applier (rejected — collect-and-continue semantics
must be preserved); a class per applier (rejected — no state to hold).

### D2: module layout

- `src/settings/appliers/repository.ts`, `labels.ts`, `branch-protection.ts`,
  `rulesets.ts` — one applier each, importing its plan functions from
  `settings/plan.ts`.
- `src/settings/appliers/types.ts` — the shared applier/result types.
- `src/settings/appliers/index.ts` — re-exports the appliers and owns the
  ordered `APPLIERS` array with its rationale comment, so the order is
  declared exactly once.
- `src/settings/forbidden.ts` — `describeForbidden`, moved unchanged from
  `apply.ts` (pure; used by branch-protection and rulesets).
  `test/plan.test.ts` re-points its import (mechanical).
- `src/settings/summary.ts` — the `ApplySummary` type plus the pure
  `formatApplySummary(summary)` formatter, unit-tested.

`syncSettings` stays in `src/settings/apply.ts` (same import surface for
`app.ts`) as the thin orchestrator: enabled short-circuit, archived skip
(wherever it lives today), sequential loop, aggregation, summary logging, and
now `return` of the `ApplySummary`.

### D3: the summary log goes through the formatter

The live line (`applied N change(s)`) and the dry-run line
(`DRY_RUN: would apply N change(s)`) are produced by `formatApplySummary`.
Same information as today; exact wording may shift, and that is accepted —
the formatter is unit-tested so future wording is deliberate. Change-records
and failures carry enough detail that a failure in one area is visible in the
log without a second fetch.

### D4: characterization tests are seams, not clones

A fake octokit (plain object recording calls) drives each applier; tests
assert the API method, the owner/repo arguments and the plan-to-call mapping
(e.g. which label actions fire, rulesets always PUT), the failure-collection
path for 403s (including the `describeForbidden` detail), and that dry-run
performs zero calls. Orchestrator tests assert call order, aggregation,
the enabled/archived short-circuits and the returned summary. Payload-level
assertions stay limited to what correctness depends on.

## Risks / Trade-offs

- [Moving 400 lines by hand risks silent behavior drift] → every applier
  group lands characterization tests *before* the orchestrator group wires
  them; each group runs the full suite; no group mixes a move with a redesign.
- [Characterization tests pin today's payload shapes] → they pin the
  plan-to-API mapping, which is the point; anything beyond it stays
  unasserted.
- [One more directory level] → justified by four cohesive siblings sharing
  one declared order.

## Migration Plan

Pure refactor; deploy as-is, rollback is a revert.
