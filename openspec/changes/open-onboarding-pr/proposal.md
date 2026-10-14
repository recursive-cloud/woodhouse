# Proposal

## Why

Installing the App today leaves a repository untouched: settings management is opt-in via `settings.enabled` (default false) but nothing tells the operator that — the config file that unlocks Woodhouse has to be authored from scratch, and the merge that switches management on has no story. A Renovate-style onboarding pull request makes installation self-explanatory: Woodhouse opens a PR adding `.github/woodhouse.yml`, that PR is validated by the config check like any other change (the product demonstrates itself in its own onboarding PR), and merging it is what switches management on.

## What Changes

- New guarded handlers for `installation` (created) and `installation_repositories` (added): for each newly installed repository, Woodhouse opens an onboarding pull request from a `woodhouse/onboarding` branch adding `.github/woodhouse.yml` — a valid starter configuration with the schema modeline, `settings.enabled: true`, and pointers to the schema and example config.
- The gate is management-only (settled decision): white-glove and config validation stay live for un-onboarded repositories — the onboarding PR itself gets a passing `woodhouse/config` check and a green white-glove; nothing else activates without the merged configuration.
- Idempotent by construction: repositories that already have any settings file are skipped silently; repositories with an existing open onboarding PR are skipped, so re-deliveries never duplicate; all git writes (branch, commit, pull request) go through the dry-run write wrapper, so `DRY_RUN=true` logs the would-be pull request and writes nothing.
- The pull request body explains what Woodhouse does, what merging enables, and how to edit the configuration; the title is conventional (`chore: onboard to Woodhouse`) so the repository's own history stays conventional-friendly.

## Capabilities

### New Capabilities

- `onboarding`: the path from App installation to an actively managed repository — offering an onboarding pull request for newly installed repositories, its idempotency rules, what merging it enables, and what stays live before it merges.

### Modified Capabilities

- none — `config-validation`'s existing triggers already validate the onboarding PR (it touches `.github/woodhouse.yml`); its requirements are unchanged. The interplay is recorded in the new capability's scenarios.

## Impact

- `src/app.ts` (two new guarded registrations), a new `src/onboarding/` module (pure decision logic + handler), a net-new git-write octokit surface (branch ref, file commit, pull request creation — all behind the dry-run write wrapper), a template constant reusing the modeline text from `src/config/json-schema.ts`.
- `README.md` and `docs/test-plan.md` document the installation walk.
- The feedback-seams refactor anticipated this handler; the deferred normalization of `app.ts` wiring stays deferred unless trivial.
