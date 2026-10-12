# settings-sync Specification

## Purpose

Woodhouse keeps repositories aligned with their cascaded `woodhouse.yml`
settings and reports the outcome on the pull requests that changed them.
Covers what triggers a settings sync and the feedback left on merged
settings pull requests.

## Requirements

### Requirement: Default-branch pushes trigger a settings sync
A push to a repository's default branch SHALL trigger a settings sync for
that repository — a diff-based re-check that writes nothing when the
repository already matches its configuration. Pushes to other branches and
branch deletions MUST NOT.

#### Scenario: Settings change lands on the default branch
- **WHEN** a push to the default branch modifies `.github/woodhouse.yml`
- **THEN** Woodhouse resolves the cascaded configuration and syncs the repository to it

#### Scenario: File merely named like a settings file
- **WHEN** a push to the default branch touches only `docs/woodhouse.yml`
- **THEN** the file is not treated as a settings change: the settings cache is not invalidated
- **AND** the routine re-check writes nothing when the repository already matches its configuration

### Requirement: Merged settings pull requests get an outcome comment
When a pull request that changes any settings file — added, modified, or
removed — merges into the default branch, Woodhouse SHALL sync the
repository's settings and SHALL comment on that pull request reporting the
apply outcome. Pull requests merged into other branches, or closed without
merging, MUST NOT trigger a comment.

#### Scenario: Settings pull request merges
- **WHEN** a pull request changing `.github/woodhouse.yml` merges into the default branch
- **THEN** Woodhouse comments on that pull request listing what was applied

#### Scenario: Merged into a non-default branch
- **WHEN** a settings-changing pull request merges into a feature branch
- **THEN** no sync runs and no comment is left

#### Scenario: Closed without merging
- **WHEN** a settings-changing pull request is closed without merging
- **THEN** no comment is left

#### Scenario: Deleting the settings file counts
- **WHEN** a merged pull request deletes the repository's `.github/woodhouse.yml`
- **THEN** the deletion is treated as a settings change and the outcome comment reports the resulting fallback

#### Scenario: Re-delivery does not duplicate
- **WHEN** the merged event re-delivers for the same pull request
- **THEN** the outcome comment is updated in place, never duplicated

### Requirement: The comment reports the real outcome
The outcome comment SHALL report what was applied per settings area and any
failures collected during the sync. When nothing needed changing, the
comment SHALL say so rather than stay silent.

#### Scenario: Failures are listed
- **WHEN** the sync cannot apply part of the settings, for example a ruleset write is forbidden on the plan the repository is on
- **THEN** the comment lists the failure and its reason

#### Scenario: Nothing further to change
- **WHEN** the settings were already fully applied, for example by the merge push itself
- **THEN** the comment states the settings are in effect and nothing further needed changing

### Requirement: Silence when settings management is disabled
An outcome comment SHALL be left only when settings management is enabled
for the repository in the merged configuration. When the merged pull request
itself disables settings management, no sync and no comment SHALL follow.

#### Scenario: Pull request disables settings management
- **WHEN** a merged pull request sets `settings.enabled: false`
- **THEN** no settings sync runs and no comment is left

### Requirement: Baseline changes are reported truthfully
When the merged settings pull request is on the baseline repository, the
outcome comment SHALL state that the baseline was synced and that other
repositories adopt the change at their next event. It MUST NOT claim every
repository was re-synced.

#### Scenario: Baseline repository pull request merges
- **WHEN** a settings-changing pull request on the baseline repository merges
- **THEN** the comment reports the baseline sync and adoption at each repository's next event

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
