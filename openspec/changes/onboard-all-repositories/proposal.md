# Proposal: onboard-all-repositories

## Why

GitHub's payloads differ between the two paths an operator takes to say "manage all my repositories", and Woodhouse follows the payloads instead of the intent (GitHub issue #24, found in the 2026-10-18 acceptance run). A *fresh* install on All repositories delivers `installation.created` with no repository list, so `repositoryNames()` yields an empty batch and Woodhouse offers nothing. Switching an *existing* installation to All delivers `installation_repositories.added` enumerating the newly-accessible repositories, so Woodhouse walks them all — in the 0.9 acceptance run that opened five live onboarding pull requests under `DRY_RUN=false`, four of them on repositories already managed by the owner baseline. The same operator intent produced opposite outcomes depending only on which event GitHub happened to send.

## What Changes

- **Enumerate on empty acted-on deliveries.** When an acted-on onboarding event (`installation.created` or `installation_repositories.added`) carries no repository list, Woodhouse enumerates the repositories accessible to the installation (`GET /installation/repositories`, paginated) and walks them like any other batch. A fresh All-repositories install therefore actually onboards.
- **Skip already-managed repositories.** Before offering, the walk resolves the repository's configuration (defaults and owner baseline — the local file is absent by construction at that point, because the existing settings-file probe has already passed) and skips any repository whose resolved `settings.enabled` is `true` with a new skip reason `baseline-managed`. In a baseline-managed org the 0.9 access-switch incident would have produced zero offers.
- **Fail closed on the new check.** If the resolved configuration cannot be determined — resolution rejects or reports validation issues — no offer is made for that repository and the failure is logged; the walk continues with the remaining repositories.
- **Reword the offer body.** The "you may already inherit baseline settings" paragraph in `ONBOARDING_PR_BODY` becomes wrong under the skip: any repository that still receives an offer is one Woodhouse has just resolved as *not* managed. The paragraph is reworded accordingly.
- **Accept the redelivery window.** Walking N repositories on the webhook response path can outlive GitHub's ~10s redelivery window. The change keeps the walk on the response path and relies on the existing idempotency keys (settings-file probe, open-onboarding-PR probe, branch existence) to absorb a redelivery; this is recorded as a design decision and documented, not re-architected.
- **Documentation.** The README's "Woodhouse does not call around it" all-repositories caveat and the `docs/test-plan.md` 0.9 row are updated to the new behavior.

No schema change: no new configuration keys, so the published JSON Schema is untouched.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `onboarding`: the "Installation offers onboarding" requirement gains the all-repositories enumeration behavior (fresh install and selection-switch scenarios); the "Already-configured repositories are skipped" requirement gains the baseline-managed skip and its unresolvable-configuration fail-closed behavior; the "Onboarding is idempotent" requirement covers repeated enumeration on re-delivery.

## Impact

- **Code:** `src/onboarding/handler.ts` (empty-list fallback, threaded management check, stale comment at 249-252), `src/onboarding/decide.ts` (new skip reason and decision input), `src/app.ts` (pass the resolver into the onboarding deps), `src/onboarding/wording.ts` (paragraph rework), `src/config/resolver.ts` or a narrow injection (nothing new needed — `ConfigResolver.resolve` already computes defaults + baseline + local, and the local layer is a harmless 404 probe for un-managed candidates).
- **Tests:** hermetic unit tests follow the existing `fakeOctokit` deps-injection pattern in `test/onboarding-handler.test.ts` / `test/onboarding.test.ts`; enumeration and baseline-managed scenarios need new fake routes.
- **APIs:** one new read-only enumeration call per empty acted-on delivery (`GET /installation/repositories` via the installation-scoped `context.octokit`), plus per-repository config-resolution reads already used elsewhere by settings sync (a local-layer 404 probe and a baseline fetch per candidate, sequential — the resolver's cache dedupes only re-deliveries of the same repository within TTL).
- **Docs:** `README.md` (all-repositories section), `docs/test-plan.md` (0.9 row).
- **Ops:** in a baseline-managed org, switching an installation to All now opens no pull requests; in an un-managed org it opens one per un-managed repository, possibly several at once — same write volume as the 0.9 `added` walk, already exercised.
