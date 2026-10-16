# Design

## Context

The machinery story (verified during exploration): `GuardedApp.on` accepts any event name, and `resolveOwner` already falls back to `installation.account.login` with a comment naming the installation events — so allowlist enforcement works for install events today. Zero git-write code exists (no `createRef`/`createOrUpdateFileContents`/`createPullRequest` anywhere); the generic `performWrite` dry-run wrapper used by all writers is reusable for every new call. The modeline text already exists in `src/config/json-schema.ts`. The feedback-seams refactor was done "for eventually the onboarding pull request". Settled product decision (2026-10-12): the onboarding PR gates *management* only — white-glove and config validation stay live pre-configuration, so the onboarding PR demonstrates the product by being validated by it.

## Goals / Non-Goals

**Goals:**

- A self-explanatory installation: PR opened, PR validated by the live checks, merge flips management on, outcome comment confirms.
- Idempotency without state: skip decisions derive entirely from GitHub's current state (files present? open onboarding PR?), never from local memory.

**Non-Goals:**

- No `installation.deleted` handling — an uninstalled repository simply goes quiet (allowlist unchanged, no events arrive); there is nothing to clean up.
- No onboarding for repositories that already have any settings file, even if disabled — an existing file is a deliberate state.
- No customization of the PR body per repository (template + config pointers only); no watching for the onboarding PR's merge beyond the existing merged-settings sync, which already reports it.
- No re-triggering on arbitrary events (push, schedule) — installation events only; a closed-unmerged offer can be re-triggered by re-adding the repository or re-installing.

## Decisions

### D1: events and guard registration

Two registrations through the guard (the only path that enforces the allowlist): `installation` (action `created`) and `installation_repositories` (action `added`), handler name `onboarding`. The repository list comes from the payload (`installation.repositories` / `repositories_added`). Owner resolution rides the existing `installation.account.login` fallback; a non-allowlisted account's install events are rejected like any other delivery.

### D2: skip logic, cheap-first, stateless

For each repository in the payload, in order: (1) do any of the four settings paths exist in this repository — the two local `.github/` paths plus the two root-level baseline-shaped paths, so the baseline repository (which always carries a root `woodhouse.yml`) is skipped like any already-configured repo? One contents probe per candidate path; 404 is the common answer. If any exists → skip silently. (2) Does an open pull request with the onboarding label exist (search by label + head branch)? If yes → skip. Only then act. Deliberately *not* consulted: the resolved cascade — a baseline-managed repository with no local file still gets the offer, because onboarding is repo-local consent and the local file is how consent is recorded; the PR body says the repository may already inherit baseline settings. Alternative — skip when the resolved config has `settings.enabled` — rejected: it would suppress the offer exactly when the baseline opts out, leaving the operator with no visible path to opt a repo in.

### D3: branch, commit, and pull-request shape

Branch `woodhouse/onboarding` from the default branch; one commit adding `.github/woodhouse.yml` from the template constant (modeline + `settings.enabled: true` + comments pointing at the schema and `woodhouse.example.yml`); pull request titled `chore: onboard to Woodhouse` with the label `woodhouse: onboarding` (the idempotency marker D2 searches for) and a body explaining what Woodhouse does, what merging enables, and how to edit. If the branch exists but no open PR does (closed-unmerged case), open a new PR from the existing branch rather than rewriting it — the template drift edge case is documented, not solved. All three writes (ref, contents, PR) behind `performWrite`, so dry-run is structural: the handler has no separate gate to remember. The writes assume the installation grants `contents: write` and `pull_requests: write`; a 403 during the walk means the operator restricted the installation, and the test-plan step says so in one line.

### D4: pure decision logic, hermetic tests

`shouldOnboard(payload, repoState)` is a pure function over the payload and the probed state (config-present, open-PR-present), tested without octokit like the other decision modules; the handler is thin glue. Template and PR body are constants with exact-string tests, in the established butler register.

### D5: no new required checks

The onboarding PR is validated by what already runs: `woodhouse/config` passes (the template is valid by construction — a test asserts the template parses), white-glove goes green (no other checks, grace period aside). Repositories wanting white-glove required can require it via their own ruleset/branch-protection config; the starter config does not force any of this on the repository.

## Risks / Trade-offs

- [An org installation adds many repositories at once] → sequential, paced writes per repository (the settings applier's deliberate pacing is the precedent); at homelab scale this is single digits.
- [Template drift when reusing an existing branch] → documented edge; the operator can delete the branch to regenerate, and the next install event will.
- [The PR is one more thing Woodhouse writes to a user's repository] → gated on the installation event itself (the operator just chose to install), label-marked, dry-run safe, and closing it is a complete no.

## Migration Plan

Deploy; install the App on a scratch repository; walk `docs/test-plan.md`: PR opens, checks validate it, merge flips management on, outcome comment confirms. Dry-run first if preferred — the whole flow logs without writing.

## Open Questions

- None that change the approach. Exact template and PR-body wording is apply-time polish within the D4 constants.
