# 0015. Conventional-Commit Pull Request Titles Are Enforced by the Dress-Code Check (Title-Only)

Status: Accepted (2026-11-28, REC-50)
Date: 2026-11-28
Issue: REC-50

## Context

Squash-merged pull request titles are the changelog source for release-please (ADR 0008). A title that is not a Conventional Commit produces a wrong or missing version bump, and nothing reports it: the mistake surfaces later, in the changelog.

A ruleset `commit_message_pattern` rule is not a pull request title gate. It evaluates the head-branch commits at merge time, blocks a squash merge on intermediate commits the squash would discard, and rulesets do not exist on private Free repositories. The gate therefore has to be a woodhouse-native named check, like `woodhouse/white-glove`.

## Decision

1. **Title-only first pass.** The check validates the pull request title as it stands before merge. GitHub appends `(#N)` to the squash commit subject at merge time; that suffix never reaches the check, because the check runs pre-merge and reads the title alone. Accepted.

2. **One parser owns the pattern.** `src/conventional/parse.ts` holds the single conventional-commit regex and the fixed type set: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`, lowercase. A scope is optional and accepts word characters, `-` and `.`; then an optional `!`, `: ` and a non-empty subject. There is no body — a title is one line. The parser never trims its input: surrounding whitespace is a pattern violation, not something to repair, so that input fails closed.

3. **Config section.** `dressCode.enabled` defaults to false (`src/config/schema-dress-code.ts`). Enabling is per repository through the normal cascade.

4. **One check run per head commit, updated in place.** The `woodhouse/dress-code` run is created on the pull request head commit and written through the same mechanics as the white-glove check: `findLatestRun` resolves the latest run for the commit and `resolveCheckWrite` decides create versus update. It runs on `pull_request.opened`, `pull_request.reopened`, `pull_request.synchronize`, `pull_request.edited` when the title changed, `check_run.rerequested` and `check_suite.rerequested`. Both re-request events complete the run rather than leaving it queued: `check_run.rerequested` handles only our own check, while `check_suite.rerequested` names no single check and is handled unconditionally, because GitHub sends it alone for "Re-run all checks" and re-queues our run in the suite. That path only completes a run that exists: a commit with no dress-code run gets no write, so a whole-suite re-run cannot create a check the operator never enabled. The title comes from the commit's paginated associated pull requests (`head.sha` match, open preferred, lowest number), and a disabled `dressCode` completes the re-requested run neutral. `pull_request.reopened` (re-)posts the check for parity with the other pull-request listeners. When `dressCode` is disabled, pull-request events post nothing. `dressCode.enabled` is resolved without a ref, so the check reads the repository's default branch: flipping the setting on posts no check on already-open pull requests until each receives its next event (`synchronize`, a title edit, or a re-request), and there is no backfill. The coupling validation, by contrast, resolves at the pull request head (decision 5), so the check and its validation deliberately read different refs.

5. **Enabling is coupled to the merge settings.** Validation runs at pull-request time against the configuration resolved from the pull request head (`src/settings/coupling.ts`), so a repository file cannot re-enable a merge setting the baseline's `dressCode` forbids. Enabling requires `allow_squash_merge: true`, `squash_merge_commit_title: PR_TITLE`, `allow_rebase_merge: false` and `allow_merge_commit: false`. Absent values are violations: the coupling has to be declared, because leaving `repository` fields out lets GitHub keep whatever the repository already had. Issues report through the `woodhouse/config` check.

6. **The verdict composes normally.** The check is an ordinary check run to the white-glove verdict: `gatekeeper.strictChecks` may list `woodhouse/dress-code`, and a failing dress-code check fails the verdict without being strict.

7. **No merged mega-check.** Dress-code stays a separate named check. Folding it into `woodhouse/white-glove` would tie two independent failure modes to one name and one re-run button.

## Accepted Limitations

- Pull requests in the baseline repository never see their own PR-time `dressCode` flip: the resolver pins the baseline layer to the default branch. Same posture as ADR 0009's baseline handling. Recorded at the resolution call in `src/settings/validate.ts`.
- Deleting a configuration file skips configuration validation entirely, by the existing "Deletion is not validated" rule, so coupling is not re-checked on deletion. Recorded at the touched-files filter in `src/settings/validate.ts`.
- An unparseable cascade skips coupling because resolution falls back to defaults (`dressCode` off). Schema errors still report through the per-document verdicts. Recorded at the coupling call in `src/settings/validate.ts`.

## Consequences

- Easier: a non-conventional title fails a named check before merge, with output naming the expected pattern and the offending title, instead of surfacing later as a wrong version bump.
- Rebase shops cannot enable dress-code: the coupling forbids rebase and merge-commit merges until a v2 all-commits mode validates every commit rather than the title.
- Out of scope: version derivation (release-please owns it), per-configuration check names or pattern customisation, and hiding a stale dress-code run from the verdict after `dressCode.enabled` is flipped off — the verdict reads check runs, not intent.
- Executable spec: `features/dress-code/title.feature`, `features/dress-code/config.feature`, and the dress-code composition rows in `features/gatekeeper/verdict.feature`.
