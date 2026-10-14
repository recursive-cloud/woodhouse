# Spec Delta

## Purpose

Pull-request-time validation of settings files: pull requests that change a `woodhouse.yml` anywhere in the cascade get a validation verdict and, when the file is invalid, a single managed comment that teaches the author how to fix it.

## ADDED Requirements

### Requirement: Pull requests touching settings files are validated
When a pull request that adds or modifies a settings file is opened, reopened, or synchronized, Woodhouse SHALL read each such settings file at the pull request head and validate it against the configuration schema. A removed settings file is not read — there is nothing at the head to validate — so a pull request whose only settings change is a deletion posts no validation check. A file that is merely named like a settings file is not a settings file.

#### Scenario: Pull request adds a local config
- **WHEN** a pull request adds or modifies `.github/woodhouse.yml`
- **THEN** the file at the pull request head is validated

#### Scenario: Baseline config pull request
- **WHEN** a pull request on the baseline repository changes `woodhouse.yml` at the repository root
- **THEN** that file is validated

#### Scenario: Near-miss filename
- **WHEN** a pull request changes only `docs/woodhouse.yml`
- **THEN** no settings file is treated as changed and no validation runs

#### Scenario: Deletion is not validated
- **WHEN** a pull request's only settings change is deleting `.github/woodhouse.yml`
- **THEN** no `woodhouse/config` check is posted for it

### Requirement: The validation verdict is a check run
Validation SHALL be reported as a check run named `woodhouse/config` on the pull request head: success when every changed settings file validates, failure listing the validation issues when any does not. A failed validation is an ordinary failed check on the commit, and the consolidated white-glove verdict reports it as such.

#### Scenario: Valid configuration
- **WHEN** every changed settings file at the pull request head parses and validates
- **THEN** the `woodhouse/config` check reports success

#### Scenario: Invalid configuration
- **WHEN** a changed settings file fails schema validation
- **THEN** the `woodhouse/config` check reports failure with the issue paths and messages

### Requirement: Invalid configuration gets one managed comment
When validation fails, Woodhouse SHALL leave a single marker comment on the pull request explaining the issues, including the `yaml-language-server` modeline suggestion for the schema. The comment SHALL be edited in place on each subsequent push, and SHALL be deleted once the configuration validates.

#### Scenario: Comment explains and suggests
- **WHEN** a pull request's settings file fails validation
- **THEN** one comment lists the issues and suggests adding the schema modeline to the file

#### Scenario: Next push fixes the file
- **WHEN** a later push makes every settings file validate
- **THEN** the comment is deleted

#### Scenario: Re-delivery does not duplicate
- **WHEN** the same pull request event re-delivers
- **THEN** the existing comment is updated in place, never duplicated

### Requirement: Valid configuration is silent
When every changed settings file validates, no explanatory comment SHALL be present on the pull request.

#### Scenario: Valid from the start
- **WHEN** a pull request opens with settings files that all validate
- **THEN** no comment is left and the `woodhouse/config` check passes

### Requirement: Dry-run never writes
In dry-run mode the validation verdict and the would-be comment SHALL be evaluated and logged, and nothing SHALL be written to GitHub.

#### Scenario: Dry-run validation
- **WHEN** a pull request with an invalid settings file is validated while dry-run mode is on
- **THEN** the issues and the would-be comment body are logged and GitHub receives no comment and no check run
