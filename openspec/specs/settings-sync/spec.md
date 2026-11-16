# settings-sync Specification

## Purpose

Woodhouse keeps repositories aligned with their cascaded `woodhouse.yml`
settings and reports the outcome on the pull requests that changed them.
Covers what triggers a settings sync and the feedback left on merged
settings pull requests.

## Requirements

### Requirement: Default-branch pushes trigger a settings sync
A push to a repository's default branch SHALL trigger a settings sync for that repository, subject to the gate in the next requirement — a re-check that writes nothing when the repository already matches its configuration, except two areas that converge by unconditional re-declaration with an idempotent update and are reported as applied on every pass: rulesets (GitHub's ruleset reads are normalised and cannot be compared against the planned body) and branch protection (the GET representation differs structurally from the PUT payload, so diffing is more error-prone than an idempotent write). Pushes to other branches and branch deletions MUST NOT trigger a sync.

#### Scenario: Settings change lands on the default branch
- **WHEN** a push to the default branch modifies `.github/woodhouse.yml`
- **THEN** Woodhouse resolves the cascaded configuration and syncs the repository to it

#### Scenario: File merely named like a settings file
- **WHEN** a push to the default branch touches only `docs/woodhouse.yml`
- **THEN** the file is not treated as a settings change: the settings cache is not invalidated
- **AND** the routine re-check writes nothing when the repository already matches its configuration

#### Scenario: Rulesets converge by re-declaration
- **WHEN** a default-branch push triggers a re-check on a repository with rulesets configured
- **THEN** each configured ruleset is re-declared with an idempotent update, and no user-visible change results when the content already matches

#### Scenario: Branch protection converges by re-declaration
- **WHEN** a sync runs on a repository with `branchProtection` blocks configured, whether or not the protection already matches
- **THEN** protection for each configured branch is re-PUT and a `branch-protection update` row is reported per branch, even when the content already matches

### Requirement: A repository without its own settings file is never synced
A settings sync SHALL run only when the repository's resolution includes its
own local settings file — `.github/woodhouse.yml` or `.github/woodhouse.yaml`.
The existence of that file is the signal that the repository accepts settings
management; a repository without it is never synced and is offered onboarding
instead, the baseline repository included. A root `woodhouse.yml` in the
baseline repository is the owner-wide baseline, not a local file. `settings.enabled` remains as a kill switch with an
implicit default of true: an explicit `false` at any level of the cascade
silences sync for that repository, and a repository-level `true` overrides a
baseline `false`. A resolution that produced validation issues SHALL NOT sync.

#### Scenario: No local settings file
- **WHEN** a repository has no local settings file and the owner baseline resolves settings management on
- **THEN** no sync runs for it, and it is offered onboarding instead

#### Scenario: Baseline kill switch silences a local file
- **WHEN** the owner baseline sets `settings.enabled: false` and the repository's local file does not set `enabled`
- **THEN** no sync runs

#### Scenario: Repository true overrides a baseline false
- **WHEN** the owner baseline sets `settings.enabled: false` and the repository's local file sets `settings.enabled: true`
- **THEN** the repository syncs

#### Scenario: Invalid configuration fails closed
- **WHEN** the cascade resolution produces validation issues
- **THEN** no sync runs

### Requirement: Merged settings pull requests get an outcome comment
When a pull request that changes any settings file — added, modified, or
removed — merges into the default branch, Woodhouse SHALL sync the
repository's settings and SHALL comment on that pull request reporting the
apply outcome — but only when the merged resolution passes the file-presence
and kill-switch gate above. Pull requests merged into other branches, or closed
without merging, MUST NOT trigger a comment.

#### Scenario: Settings pull request merges
- **WHEN** a pull request changing `.github/woodhouse.yml` merges into the default branch
- **THEN** Woodhouse comments on that pull request listing what was applied

#### Scenario: Merged into a non-default branch
- **WHEN** a settings-changing pull request merges into a feature branch
- **THEN** no sync runs and no comment is left

#### Scenario: Closed without merging
- **WHEN** a settings-changing pull request is closed without merging
- **THEN** no comment is left

#### Scenario: Deleting the settings file ends management
- **WHEN** a merged pull request deletes the repository's `.github/woodhouse.yml`
- **THEN** the deletion is treated as a settings change, and because the local file is now absent the repository is no longer synced: no sync runs and no comment is left

#### Scenario: Re-delivery does not duplicate
- **WHEN** the merged event re-delivers for the same pull request
- **THEN** the outcome comment is updated in place, never duplicated

### Requirement: The comment reports the real outcome
The outcome comment SHALL report what was applied per settings area and any
failures collected during the sync. When nothing needed changing, the comment
SHALL say so rather than stay silent — and because rulesets and branch
protection are re-declared on every pass, that no-op wording applies only
when the merged configuration has no `branchProtection` blocks configured
(and no other re-declared area): with blocks configured, the comment lists
the re-declared branches every time. The wording reflects the write that
actually happened: it never claims a change that was not written, and
never writes a change without listing it.

#### Scenario: Failures are listed
- **WHEN** the sync cannot apply part of the settings, for example a ruleset write is forbidden on the plan the repository is on
- **THEN** the comment lists the failure and its reason

#### Scenario: Nothing further to change
- **WHEN** the settings were already fully applied — no re-declared areas are configured — for example by the merge push itself
- **THEN** the comment states the settings are in effect and nothing further needed changing

#### Scenario: No-op wording unreachable with branch protection configured
- **WHEN** a pure no-op sync runs on a repository whose configuration has a `branchProtection` block
- **THEN** the outcome comment does not use the no-op wording; it lists the re-declared `branch-protection update` row(s)

### Requirement: Silence when settings management is disabled
An outcome comment SHALL be left only when the merged resolution passes the
gate: the repository carries its own local settings file, the resolved
`settings.enabled` is not false, and the resolution produced no validation
issues. An explicit `false` at any level of the cascade silences the
repository. When the merged pull request itself disables settings management,
no sync and no comment SHALL follow.

#### Scenario: Pull request disables settings management
- **WHEN** a merged pull request sets `settings.enabled: false`
- **THEN** no settings sync runs and no comment is left

#### Scenario: Baseline kill switch silences a local file
- **WHEN** the owner baseline sets `settings.enabled: false` and the merged local file does not set `enabled`
- **THEN** no settings sync runs and no comment is left

### Requirement: The baseline file cascades to every repository, including its own

The baseline repository's root `woodhouse.yml`/`woodhouse.yaml` SHALL be fetched
as the baseline layer for every repository the owner has, the baseline
repository included. The baseline repository manages itself through its own
`.github/woodhouse.yml` like any other repository; a root file alone MUST NOT opt
it into settings management or cause a sync.

#### Scenario: Baseline repository resolution

- **WHEN** the baseline repository resolves its cascaded configuration
- **THEN** its root file contributes as the baseline layer, not as a local file
- **AND** its configuration resolves to defaults when it has neither a root file nor `.github/woodhouse.yml`

#### Scenario: Baseline repository merge without a local file

- **WHEN** a settings change merging on the baseline repository touches only its root baseline file, and `.github-private` carries no `.github/woodhouse.yml`
- **THEN** no sync runs and no outcome comment is left, because the file-presence gate reports no local file

#### Scenario: Baseline repository merge with a local file

- **WHEN** a settings change merges on `.github-private` while it carries its own `.github/woodhouse.yml`, and the merged resolution passes the gate
- **THEN** the baseline repository is synced and the outcome comment reports that the baseline was synced directly

### Requirement: Baseline changes are reported truthfully
When the merged settings pull request is on the baseline repository and that
repository carries its own `.github/woodhouse.yml`, the outcome comment SHALL
state that the baseline was synced and that other repositories adopt the change
at their next event. It MUST NOT claim every repository was re-synced. When the
baseline repository carries no local file, no sync and no comment follow.

#### Scenario: Baseline repository pull request merges

- **WHEN** a settings-changing pull request on the baseline repository merges and the repository carries its own `.github/woodhouse.yml`
- **THEN** the comment reports the baseline sync and adoption at each repository's next event

#### Scenario: Baseline repository pull request without a local file

- **WHEN** a settings-changing pull request on the baseline repository merges and the repository has no `.github/woodhouse.yml`
- **THEN** no sync and no comment follow, the same as any other repository

### Requirement: Syncs serialize per repository
Concurrent sync triggers for the same repository — a merge push and the
merged pull request's own event — SHALL execute one after the other, never
interleaved. A second pass MUST remain a safe, idempotent re-check.

#### Scenario: Merge push and merged event race
- **WHEN** the merge push delivery and the closed pull request delivery trigger a sync for the same repository nearly simultaneously
- **THEN** the two syncs run in some order without interleaving writes

### Requirement: Dry-run never comments
In dry-run mode the sync and the would-be comment SHALL be evaluated and
logged, and nothing SHALL be written to GitHub.

#### Scenario: Dry-run merge
- **WHEN** a settings pull request merges while dry-run mode is on
- **THEN** the decision and comment body are logged and GitHub receives no comment

### Requirement: Ruleset conditions are typed to the repository surface
A ruleset's `conditions` SHALL accept only `ref_name` with `include` and `exclude` name lists — the only condition repository rulesets support. Any other condition key SHALL be a validation error.

#### Scenario: ref_name conditions accepted
- **WHEN** a ruleset declares `conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }`
- **THEN** the configuration validates

#### Scenario: Organization-only condition rejected
- **WHEN** a ruleset declares a `repository_name` condition (organization rulesets only)
- **THEN** validation fails with a path pointing at the condition key

### Requirement: Ruleset names are unique in a configuration
A configuration SHALL be rejected when two rulesets share a name, compared case-insensitively — names are the match key for updates, deletes, and prune protection.

#### Scenario: Duplicate names rejected
- **WHEN** a configuration lists two rulesets named `main` and `MAIN`
- **THEN** validation fails naming the duplicate

### Requirement: Prune deletes every unconfigured ruleset only by explicit opt-in
With `settings.pruneRulesets` enabled, a sync SHALL delete every ruleset in the repository that is not named in the configuration — including rulesets created outside Woodhouse. With it disabled (the default), unconfigured rulesets SHALL be left untouched. The configuration surface SHALL describe this behavior truthfully, without claiming ownership tracking that does not exist.

#### Scenario: Prune removes a hand-made ruleset
- **WHEN** a sync runs with `pruneRulesets: true` on a repository whose hand-made `hotfix` ruleset is not in the configuration
- **THEN** the `hotfix` ruleset is deleted

#### Scenario: Default leaves unconfigured rulesets alone
- **WHEN** a sync runs with `pruneRulesets` unset
- **THEN** rulesets absent from the configuration are left untouched

### Requirement: Removing a branchProtection block does not remove protection
A removed `branchProtection` block stops the re-assertion and MUST NOT delete
the protection that already exists on the branch. Woodhouse deliberately ships
no delete path and no prune for branch protection, because silently deleting
protection it did not create is unacceptable. The configuration surface SHALL
state the choice truthfully and point at GitHub's branch-protection → rulesets
converter as the off-boarding path, which deletes the original
protection once the ruleset has landed.

#### Scenario: Block removed, protection stays
- **WHEN** a configuration stops listing a `branchProtection` block for a branch whose protection was previously applied
- **THEN** the following syncs re-assert nothing for that branch, and the
    branch's existing protection remains in place, no longer managed by Woodhouse

#### Scenario: Off-boarding is manual
- **WHEN** an operator wants to retire branch protection in favour of rulesets
- **THEN** the configuration surface directs them to GitHub's manual "Convert to ruleset" flow rather than shipping any delete path
