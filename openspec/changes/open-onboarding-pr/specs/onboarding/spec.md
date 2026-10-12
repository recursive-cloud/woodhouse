# Spec Delta

## Purpose

The path from App installation to an actively managed repository: Woodhouse offers an onboarding pull request that adds the configuration file, and merging that pull request is what switches management on.

## ADDED Requirements

### Requirement: Installation offers onboarding
When the App is installed on a repository, or a repository is added to an existing installation, and that repository has no settings file and no open onboarding pull request, Woodhouse SHALL open a pull request from a dedicated onboarding branch that adds `.github/woodhouse.yml` containing a valid starter configuration — the schema modeline, `settings.enabled: true`, and pointers to the schema and example.

#### Scenario: Fresh install
- **WHEN** the App is installed on a repository with no `.github/woodhouse.yml`
- **THEN** Woodhouse opens an onboarding pull request adding the starter configuration

#### Scenario: Repository added to an existing installation
- **WHEN** a repository is added to an installation that already existed
- **THEN** the same onboarding offer is made for that repository

### Requirement: Already-configured repositories are skipped
A repository in which any settings file already exists SHALL NOT receive an onboarding pull request — it manages itself.

#### Scenario: Local config already present
- **WHEN** the App is installed on a repository that already has `.github/woodhouse.yaml`
- **THEN** no onboarding pull request is opened

#### Scenario: The baseline repository is skipped
- **WHEN** the App is installed on the baseline repository, which carries a root `woodhouse.yml`
- **THEN** no onboarding pull request is opened

### Requirement: Onboarding is idempotent
While an onboarding pull request is open for a repository, no further onboarding action SHALL be taken for it — re-delivered installation events and later events must not duplicate the branch, the commit, or the pull request. A pull request closed without merging leaves the repository un-onboarded; a later installation event offers again.

#### Scenario: Re-delivery
- **WHEN** the installation event re-delivers while the onboarding pull request is open
- **THEN** no second branch, commit, or pull request is created

#### Scenario: Closed without merging
- **WHEN** the onboarding pull request is closed without merging and no installation event follows
- **THEN** the repository remains un-onboarded and untouched

### Requirement: Merging enables management
Merging the onboarding pull request SHALL switch settings management on for the repository — the starter configuration sets `settings.enabled: true`, and the merged-settings sync runs and reports the outcome on the pull request.

#### Scenario: The onboarding pull request merges
- **WHEN** the onboarding pull request merges into the default branch
- **THEN** the settings sync runs for the repository and the outcome comment is left on the pull request

### Requirement: Un-onboarded repositories are otherwise untouched
Before any configuration merges, Woodhouse SHALL perform no settings writes for the repository. The white-glove check and config validation remain live — they are what validate the onboarding pull request itself.

#### Scenario: Pull request on an un-onboarded repository
- **WHEN** any pull request opens in a repository with no settings file
- **THEN** the white-glove check is posted and no settings are written

### Requirement: Dry-run never writes
In dry-run mode the onboarding decision SHALL be evaluated and logged — the branch, the file, and the would-be pull request — and nothing SHALL be written to GitHub.

#### Scenario: Dry-run installation
- **WHEN** the App is installed on a repository while dry-run mode is on
- **THEN** the would-be onboarding pull request is logged and no branch, commit, or pull request is created
