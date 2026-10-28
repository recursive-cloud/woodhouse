# Proposal

## Why

A settings change merging on the baseline repository (`.github-private`) clears the owner cache but then skips sync: the resolver probes only `.github/woodhouse.{yml,yaml}` as the baseline repository's local layer, both 404 there, so its merged config falls back to defaults with `settings.enabled: false`. The designed outcome comment for baseline merges (`buildSettingsAppliedComment`) is unreachable as deployed — found in the 2026-10-18 acceptance run (finding 5.20, issue #26).

## What Changes

- For the baseline repository, the config resolver resolves its own root baseline-shaped files (`woodhouse.yml`, `woodhouse.yaml`) as its local configuration layer, so `settings.enabled: true` at the root of `.github-private` enables settings management on the baseline repository itself.
- A settings merge on the baseline repository then syncs the baseline repository and posts the designed baseline-repo outcome comment.
- The baseline layer is still never merged into the baseline repository's own resolution (no self-merge); nothing else about the cascade changes.
- Fork decision (issue #26): **Narrow** — root `woodhouse.{yml,yaml}` become a valid local layer *only for the baseline repository*. The Broad alternative (valid local override in every repository) is rejected because it widens what counts as a settings file across config validation and sync gating everywhere.

## Capabilities

### Modified Capabilities

- `settings-sync` — adds the requirement that the baseline repository resolves its own root configuration, making the existing "Baseline changes are reported truthfully" behaviour reachable.

## Impact

- `src/config/resolver.ts` (`ConfigResolver.load`): local-layer path selection when the repo is the baseline repository; header and self-merge comments updated.
- `test/resolver.test.ts`, `test/merge-feedback-handler.test.ts`: new scenarios.
- No schema, no `paths.ts` sets, no cache-invalidation changes: `BASELINE_PATHS` are already in the `SETTINGS_PATHS` set, so push/PR triggers and PR-time validation already fire on baseline-repo changes — only resolution was broken.
- Onboarding asymmetry noted in the issue disappears: onboarding's `CONFIG_PATHS` already includes the root baseline-shaped paths, and after this change the resolver reads the same paths, so both subsystems agree.
