# Proposal

## Why

Woodhouse is heading into a run of PR-feedback features — owners/bots
auto-approval, settings-applied comments on merged pull requests, and
eventually the onboarding pull request — and the mechanics they all share are
exactly the ones implemented ad-hoc today. A marker-based comment manager
lives only inside config-validation; pull-request facts are fetched with two
different hand-rolled pagination idioms; DRY_RUN is enforced by 13 scattered
`if` gates in two opposite shapes, so every new write path is one forgotten
gate away from writing to GitHub in dry-run mode; and "is this a settings
file?" is answered three different ways, one of which (the push trigger)
matches any file that merely ends in `woodhouse.yml`.

Extracting those seams now, before the features land, keeps each upcoming
change small, gives the currently untested GitHub-API glue its first test
seams, and stops the duplication from compounding.

## What Changes

- **Shared commenter.** The marker-based comment sync (find own comment,
  create/update/delete) moves out of `src/settings/validate.ts` into a
  reusable module. Config-validation behavior is unchanged.
- **Shared pull facts.** One module owns "list changed files" (single
  pagination idiom) and "get pull request"; `silverPlatter.ts` and
  `validate.ts` adopt it, retiring the second hand-rolled pagination loop.
- **Structural DRY_RUN.** One write-guard helper replaces all 13 hand-rolled
  gates (10 in `src/settings/apply.ts`, one each in validate, gatekeeper
  handler and silver-platter). Skipping writes in dry-run mode becomes a
  property of the helper, not something each call site must remember.
  Dry-run logging is unified and gains per-write labels.
- **One settings-file predicate.** The exact path list that `config/resolver.ts`
  and `settings/validate.ts` already use becomes the only definition, shared
  with the push trigger in `app.ts`.
- **Deliberate micro-alignment (no GitHub-visible change):** the push trigger
  stops matching unrelated files that merely end in `woodhouse.yml` (e.g.
  `docs/woodhouse.yml`). Such pushes previously caused a cache invalidation
  and a sync that resolved unchanged config and wrote nothing.
- **First fake-octokit tests.** The commenter, pull facts, dry-run guard and
  settings-path predicate get unit tests against a fake octokit — the first
  tests for the API-glue layer, which is currently untested.

No config schema change; `schema/woodhouse.schema.json` is untouched.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- none

Pure refactor: no spec-level behavior changes, so this change sets
`skip_specs: true` in `.openspec.yaml`.

## Impact

- `src/settings/validate.ts`, `src/approval/silverPlatter.ts`,
  `src/settings/apply.ts`, `src/gatekeeper/handler.ts`, `src/app.ts` —
  mechanical adoption of the extracted seams.
- New modules (placement decided in design): shared commenter, pull facts,
  dry-run guard, settings-path predicate.
- New test files for the extracted modules; the existing suite keeps passing
  unchanged.
- Unblocks `add-owners-bots-auto-approval` and
  `comment-settings-applied-on-merge`, which build on these seams.
