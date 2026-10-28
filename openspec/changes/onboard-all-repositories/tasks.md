# Tasks — onboard-all-repositories

## 1. Decision layer and offer wording (pure, hermetic)

- [x] 1.1 Extend the decision layer in `src/onboarding/decide.ts`: add an optional `managed?: boolean` field to `OnboardingProbe` (undefined treated as not managed, so existing call sites compile and behave unchanged) and a new skip reason `baseline-managed` that short-circuits to skip when the field is true; keep every existing reason and the fail-closed `pull-request-state-unprobed` behavior unchanged. Update the `shouldOnboard` truth table in `test/onboarding.test.ts` with managed cases (true → skipped, false/undefined → unchanged behavior). Verify: `npx vitest run test/onboarding.test.ts`
- [x] 1.2 Reword the "may already inherit baseline settings" paragraph in `ONBOARDING_PR_BODY` (`src/onboarding/wording.ts:82`) to state that Woodhouse resolved the repository as not yet managed by the owner-level configuration and that a local file is how the repository records its own consent; keep tone and length comparable and leave `ONBOARDING_TEMPLATE` untouched. Update the body assertions in `test/onboarding.test.ts` and `test/wording.test.ts` where they reference the old paragraph. Verify: `npx vitest run test/onboarding.test.ts test/wording.test.ts`
- [x] 1.3 Run the group's full verification: `npx vitest run test/onboarding.test.ts test/wording.test.ts`

## 2. Handler: management check and resolver injection

- [x] 2.1 Thread the management check into `walkRepository` (`src/onboarding/handler.ts`): after `configPresent` and before the open-PR probe, resolve via an injected `resolveConfig(owner, repo)` function on `OnboardingDeps` — the wrapper maps both a rejection and a resolution with non-empty `issues` to unresolvable (it must never hand the decision layer fallback defaults, resolver.ts:225-231); a resolved `settings.enabled: true` sets the probe's `managed: true` and skips the repository as `baseline-managed` without the PR probe; an unresolvable candidate is logged as that repository's error and the walk continues (fail closed — no offer). Extend `test/onboarding-handler.test.ts` with: baseline-managed skip, unmanaged-repository still offered, unresolvable-configuration fail-closed (rejection AND validation-issues cases), baseline layer parses but fails validation → no offer under the baseline-managed check, and no PR search issued for a managed repository. Verify: `npx vitest run test/onboarding-handler.test.ts`
- [x] 2.2 Wire the injection in `src/app.ts` so both onboarding listeners pass a `resolveConfig` backed by the existing `ConfigResolver` (defaults → owner baseline → local, read-only, cache reused); no `ConfigResolver` API changes beyond what already exists. Verify: `npm run typecheck`
- [x] 2.3 Run the group's full verification: `npx vitest run test/onboarding-handler.test.ts && npm run typecheck`

## 3. Handler: enumerate empty acted-on deliveries

- [x] 3.1 (high-risk) In `handleOnboarding` (`src/onboarding/handler.ts`), when an acted-on action yields an empty name batch, enumerate via `GET /installation/repositories` (octokit `apps.listReposAccessibleToInstallation`) with `octokit.paginate` (`per_page: 100`), filter to non-empty `name`s, and walk the result like any other batch; keep the current event semantics (`created` → `installation.repositories`, `added` → `repositories_added`) untouched. Enumeration runs outside the per-repository try/catch: catch its errors, log a dedicated operator-facing error line (replacing the "carried no repository list" info line in that case), and open no offers. Extend `test/onboarding-handler.test.ts` with: fresh all-repositories install walks the enumerated batch, batch spanning more than one page is fully walked, enumeration failure logs one error and writes nothing, dry-run enumerates (read-only) and writes nothing. Verify: `npx vitest run test/onboarding-handler.test.ts test/dry-run.test.ts`
- [x] 3.2 Rewrite the stale comment at `src/onboarding/handler.ts:319-324` so it describes the enumeration fallback instead of "an all-repositories install does not enumerate pre-existing repositories". Verify: `npx vitest run test/onboarding-handler.test.ts`
- [x] 3.3 Run the group's full verification: `npx vitest run test/onboarding-handler.test.ts test/dry-run.test.ts`

## 4. Documentation

- [x] 4.1 Update the README all-repositories section (`README.md:198-202`, "Woodhouse does not call around it"): fresh All installs enumerate and walk; already-managed repositories (local file or resolved baseline `settings.enabled: true`) are skipped; document the ~10s redelivery window and that a redelivered walk is absorbed by the idempotency probes. Verify: `git grep -n "does not call around it" -- README.md` returns nothing
- [x] 4.2 Update the `docs/test-plan.md` row 0.9 (`docs/test-plan.md:175`) so the all-repositories caveat describes the new behavior. Verify: `git grep -n "0.9" -- docs/test-plan.md` shows the reworded row
- [x] 4.3 Run the group's full verification: `git grep -n "does not call around it" -- README.md; git grep -n "0.9" -- docs/test-plan.md`

## 5. Whole-change integration

- [x] 5.1 Full hermetic suite: `npm test`
- [x] 5.2 Lint and typecheck: `npm run typecheck && mise run lint`
- [x] 5.3 Validate the change: `openspec validate onboard-all-repositories`

## Workflow follow-up

- Whole-change verification pass against the change artifacts (spec deltas + tasks), per the round workflow.
- Squash to `change/onboard-all-repositories` with a signed commit (`git commit -S`), then hand back for the user to push and open the PR.
- Archive after merge per the round convention.
