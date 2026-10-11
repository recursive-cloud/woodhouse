# Design

## Context

The agreed design lives in `docs/owners-bots-auto-approval.md`; this file
captures it as the design of record for this change. Current state:
`decide()` in `src/approval/policy.ts` compares the author against one flat
case-insensitive list; `serve()` in `src/approval/silverPlatter.ts` runs a
cheap preliminary `decide()` with empty files, then fetches changed files and
the existing approval, then decides again and submits the review; the review
body is one static string for everyone; `protectedPaths` is the inviolable
veto. There is no dedicated auto-merge webhook, and the `auto_merge` field in
the `pull_request` payload is a stale snapshot — Renovate toggles auto-merge a
moment *after* opening.

## Goals / Non-Goals

**Goals:**

- The owners/bots split exactly as specified in
  `docs/owners-bots-auto-approval.md`: owners approved unconditionally,
  bots only when they enabled auto-merge themselves.
- The new decision logic stays pure in `policy.ts` and carries the bulk of
  the new tests, per the project convention.

**Non-Goals:**

- No migration or union with the legacy flat array — pre-release, configs
  migrate by hand.
- No per-actor custom wording (post-1.0 stretch goal).
- No new webhook subscriptions; no change to `protectedPaths` semantics.

## Decisions

### D1: config shape

`autoApproval.allowedActors` becomes `z.object({ owners, bots })` — both
string arrays `.default([])`, `.describe()` on both sub-lists, the section
keeping its existing `.prefault({})`. No union, no transform: the legacy
flat array is rejected (fails closed). `schema/woodhouse.schema.json` is
regenerated and committed (CI drift check + `json-schema.test.ts`).

### D2: classification by membership, not account type

`decide()` classifies the author by list membership, never `pr.user.type`:
any login may appear in `bots`; the rule is "enabled auto-merge," not "is
literally a `[bot]`-suffixed account."

### D3: `ApprovalRequest.autoMergeEnabledBy?: string | null`

- `undefined` — the fact has not been gathered yet (preliminary pass). The
  bot gate is **inert**: `decide()` never vetoes a bot for a missing fact,
  so the cheap preliminary pass still classifies the author and an
  eligible bot proceeds to fact gathering. Nothing is ever *submitted* on
  a pass with an ungathered fact — submission happens only after the full
  pass below, where the fact is always gathered.
- `null` — gathered, nobody has enabled auto-merge.
- a string — gathered, this login enabled it.

`decide()`: owners -> approve (subject to the existing checks); bots ->
additionally require `autoMergeEnabledBy === author`, evaluated only once
the fact is gathered (`null` refuses; a string must equal the author;
`undefined` neither vetoes nor approves). Neither list -> refuse, as
today. `protectedPaths` remains the hard veto against privilege
escalation; the auto-merge gate *adds* a condition, never replaces it.

### D4: fact gathering — the two passes spelled out

`serve()` keeps its two-pass structure:

1. Preliminary `decide()` with empty files and `autoMergeEnabledBy:
   undefined` — the bot gate is inert here, so an eligible bot is *not*
   declined for the missing fact; hopeless cases (author in neither list,
   draft, closed) decline as today, with no fetching.
2. For a bots author: on `opened`, `await` the short constant grace (the
   payload snapshot is stale — Renovate toggles auto-merge a moment after
   opening), then GET the pull request and read
   `auto_merge?.enabled_by?.login ?? null`; on the other three events, GET
   without the delay. The GET goes through the shared `getPullRequest`.
   A failed GET fails the pass — the full pass never sees `undefined`;
   there is no silent path from a fetch error to an approval.
3. Full `decide()` with the gathered files, the existing-approval fact and
   the auto-merge fact (always `null` or a string here) — the gate is
   live. Approve -> submit the review (pinned to the head SHA); refuse ->
   decline.

Owners skip the GET entirely — their approval never depends on
auto-merge. The inline `await` of a named constant keeps the follow-up GET
in the same pass; the gatekeeper Scheduler pattern was considered and
rejected (it would re-run the whole flow and complicate idempotency).
`PullRequestFacts` gains `action`; `app.ts` passes
`context.payload.action` into `serve()`.

### D5: review bodies

Butler register, per class, both ending with the existing
`_Woodhouse, at your service._` sign-off:

- Owner: "Very good, sir. Approving on your behalf — this pull request
  touches no protected paths."
- Bot: "Sir, just letting you know I am letting the handyman in to fix a
  few things — {author} asked to be merged and this pull request touches
  no protected paths."

The wording construction is a small pure builder fed the class and author,
unit-tested on its exact strings — decision logic stays out of the
API-calling module.

### D6: fail-safe

A bot that toggles auto-merge after opening is declined on the `opened`
pass and caught on the next `synchronize` / `ready_for_review` /
`reopened`. The gate never wrongly approves; the worst case is a delayed
approval.

## Risks / Trade-offs

- [Auto-merge still unset when the grace delay elapses] -> fail-safe
  decline; caught on the next event. The constant is tunable later without
  redesign.
- [BREAKING config change] -> pre-release, hand migration documented in
  README and the example config; validation rejects the old shape loudly.
- [Inline delay slows one delivery's processing by ~2s] -> only for
  bots-listed authors on `opened`; acceptable for a homelab App.

## Migration Plan

Migrate `woodhouse.example.yml` and operator configs by hand; deploy; watch
one Renovate pull request end-to-end per `docs/test-plan.md`.
