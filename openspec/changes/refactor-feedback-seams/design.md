# Design

## Context

See proposal.md (Why) for the motivation. Today the four handlers share
mechanics that live ad-hoc: the marker-based comment manager exists only in
`src/settings/validate.ts` (`syncComment` + `COMMENT_MARKER`), `pulls.listFiles`
pagination is hand-rolled twice (`validate.ts` via `octokit.paginate`,
`silverPlatter.ts` as a manual loop), DRY_RUN is enforced by 13 `if` gates in
two opposite shapes, and the settings-file predicate is defined three times
(`app.ts` `endsWith`, `config/resolver.ts` `LOCAL_PATHS`/`BASELINE_PATHS`,
`validate.ts` `isConfigPath`). All ~175 existing tests cover the pure decision
modules; the GitHub-API glue layer these seams live in has none.

## Goals / Non-Goals

**Goals:**

- One home each for marker-comment management, pull-fact fetching, dry-run
  write guarding, and settings-path classification.
- Every extracted seam gets unit tests against a fake octokit — the first
  coverage of the glue layer.
- Observable behavior preserved (the single accepted alignment — exact-path
  trigger instead of `endsWith` — is documented in the proposal).

**Non-Goals:**

- No restructuring of the `app.ts` wiring (deferred until the onboarding pull
  request forces it; this change only swaps the predicate it uses).
- No decomposition of `settings/apply.ts` (owned by
  `refactor-apply-pipeline`; here it only adopts the dry-run guard).
- No features, no schema changes, no comment-wording changes.

## Decisions

### D1: module placement — a new `src/github/` for shared GitHub-API mechanics

- `src/github/comments.ts` — marker-based comment manager.
- `src/github/pulls.ts` — pull-request facts (changed files, pull request).
- `src/lib/dry-run.ts` — the write guard (process-level policy, no GitHub
  knowledge, so it lives in `lib/` with the other process utilities).
- `src/config/paths.ts` — settings-path predicate + the path constants
  (config-domain knowledge, so it lives in `config/`).

Rationale: `lib/` stays GitHub-free; feature directories stay consumers, not
providers, of shared code. Alternatives considered: commenter in `lib/`
(rejected — it speaks octokit); pull facts in `src/approval/` (rejected — two
consumers today, a third is coming, so shared code must not live inside one
consumer's home).

### D2: commenter API — one sync function, the decision stays at the call site

`syncMarkerComment(deps, { owner, repo, issueNumber, marker, body })` where
`body === undefined` means "ensure absent" (delete if found) and a defined
body means "ensure present" (create, or update in place). Config-validation
keeps deciding *which* outcome it wants from its pure validation result; the
module owns only mechanics: list comments, find by marker substring,
create/update/delete. Identity stays marker-based (an HTML comment chosen by
the caller), not author-based, preserving the existing rationale: it
survives an App rename and cannot collide with a human quoting the bot. The
manager guards its own writes through the D4 write guard, so every future
caller gets dry-run safety structurally instead of remembering a gate.

Alternative: a class per feedback channel — rejected; a function over plain
deps matches the project's plain-functions-over-plain-data convention.

### D3: pull facts — one pagination idiom, truncation preserved

`listChangedFiles(octokit, owner, repo, pullNumber, { maxPages })` returns
`{ files: { filename, status }[], truncated: boolean }`;
`getPullRequest(octokit, owner, repo, pullNumber)` returns the pull request.
Without `maxPages` the listing walks every page through `octokit.paginate`
(the idiom `validate.ts` already uses); with `maxPages` it stops after the
cap and reports `truncated: true` when more pages remain — a bounded loop,
so silverPlatter's deliberate safety cap survives the extraction: it
passes its current page cap, `truncated` still reaches the approval
decision, and a pull request whose file list cannot be fully read is still
refused rather than decided on partial facts. `validate.ts` keeps its
today-unbounded behavior. Future facts (the auto-merge read for
owners/bots, merge linkage) land here.

### D4: dry-run guard — one helper, two uses

`src/lib/dry-run.ts` exports a write guard — call it `performWrite(ctx, label,
run)`: when `ctx.dryRun` it logs `DRY_RUN: would <label>` and returns without
running; otherwise it runs and returns the result. Composite sites
(config-validation, gatekeeper handler, silver-platter) wrap their whole write
phase in one call, preserving today's early-return semantics; per-write sites
in `apply.ts` wrap each API call, replacing the ten inverted
`if (!ctx.dryRun)` gates. Both current idioms collapse into one. With the
D2 self-guarding commenter, config-validation's composite call wraps its
check creation while the comment write is guarded inside the manager — its
dry-run log becomes two precise lines instead of one.

Trade-off accepted: dry-run logs become per-write in `apply.ts` (today it
skips silently per write and logs one summary line) — strictly more
observability, which is the point of DRY_RUN mode.

Alternative: an octokit proxy that intercepts mutating methods — rejected as
magic; the explicit helper keeps call sites greppable and types simple.

### D5: one settings-path predicate

`src/config/paths.ts` owns `LOCAL_PATHS` + `BASELINE_PATHS` (moved from
`config/resolver.ts`) and exports `isSettingsPath(path)`: an exact match
against the four settings-file paths. `app.ts`'s touched-config check adopts it
(retiring the `endsWith` match); `resolver.ts` imports the constants;
`validate.ts`'s `isConfigPath` delegates to it.

Alternative: keep `endsWith` as the trigger semantics — rejected; it already
diverges from every other definition and would leak into the merge-feedback
detection planned in `comment-settings-applied-on-merge`.

## Risks / Trade-offs

- [Behavior drift during mechanical adoption] → every task group runs the
  full existing suite plus its new unit tests; no group mixes adoption with
  anything else.
- [Fake-octokit tests codify call shapes that drift from the real API] →
  fakes assert only what the code depends on (method, owner/repo/number
  arguments, marker handling), not full payloads; they are seams, not clones.
- [More modules and indirection] → each is small, single-purpose, and owns a
  name the roadmap was going to need anyway.

## Migration Plan

Pure refactor; deploy as-is, rollback is a revert.
