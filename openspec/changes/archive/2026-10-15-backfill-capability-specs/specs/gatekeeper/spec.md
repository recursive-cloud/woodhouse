# Spec Delta

## Purpose

The white-glove consolidated check: one verdict over every other check run on a pull request's head commit, so a repository can require a single check that means "everything passed".

## ADDED Requirements

### Requirement: A consolidated check is maintained per pull request
Woodhouse SHALL maintain a check run named `woodhouse/white-glove` on the head commit of every pull request in a repository it serves, creating it when absent and updating the existing run in place — never duplicating. The verdict SHALL be re-derived fresh from the head commit's check runs whenever a pull request event, a completed check run, a completed check suite, or a re-request arrives.

#### Scenario: Pull request opens
- **WHEN** a pull request opens, reopens, or synchronizes
- **THEN** the `woodhouse/white-glove` check exists on the new head commit

#### Scenario: Another check completes
- **WHEN** a check run on the head commit completes
- **THEN** the consolidated verdict is re-derived and the check updated

#### Scenario: Re-requested
- **WHEN** the consolidated check is re-requested from the pull request UI
- **THEN** the verdict is re-derived fresh and the check updated in place

### Requirement: The verdict aggregates other checks and fails closed
The verdict SHALL consider every check run on the head commit except the consolidated check itself. Any failed check SHALL fail the verdict, and a check conclusion Woodhouse does not recognize SHALL count as failure, never as success.

#### Scenario: A child check fails
- **WHEN** any check on the head commit other than `woodhouse/white-glove` reports a failing conclusion
- **THEN** the consolidated check reports failure

#### Scenario: Unrecognized conclusion
- **WHEN** a check on the head commit reports a conclusion Woodhouse does not recognize
- **THEN** the consolidated check reports failure rather than passing silently

#### Scenario: Non-strict skipped or neutral check passes
- **WHEN** a check not listed in `strictChecks` reports `skipped` or `neutral`
- **THEN** the verdict is unaffected

#### Scenario: Running check holds pending
- **WHEN** a check on the head commit is still in progress
- **THEN** the consolidated check stays pending

### Requirement: Strict checks must pass explicitly
Checks named in `gatekeeper.strictChecks` SHALL NOT be satisfied by `skipped` or `neutral` conclusions — those fail the verdict — and their absence SHALL hold the verdict at pending rather than let it pass. Strictness takes precedence over `ignoredChecks`.

#### Scenario: Absent strict check holds pending
- **WHEN** a check listed in `strictChecks` has no check run on the head commit
- **THEN** the consolidated check stays pending

#### Scenario: Skipped strict check fails
- **WHEN** a check listed in `strictChecks` reports `skipped` or `neutral`
- **THEN** the consolidated check reports failure

#### Scenario: Strict beats ignored
- **WHEN** a check is listed in both `strictChecks` and `ignoredChecks`
- **THEN** the strict treatment applies

### Requirement: Ignored checks are excluded
Checks named in `gatekeeper.ignoredChecks` SHALL be excluded from the verdict entirely, by exact name.

#### Scenario: Advisory check ignored
- **WHEN** an advisory-only check named in `ignoredChecks` fails
- **THEN** the consolidated verdict is unaffected

### Requirement: Commits without checks get a grace period, then pass
When a pull request opens and no check run exists on the head commit yet, the verdict SHALL be held pending for `gatekeeper.gracePeriodSeconds`. If the grace period expires with still no check runs, the commit SHALL pass — repositories without CI must not be deadlocked by a required check nothing can satisfy.

#### Scenario: Inside the grace window
- **WHEN** a pull request opens and GitHub has not created any check runs yet
- **THEN** the consolidated check is pending, and a re-check is scheduled after the grace period

#### Scenario: No CI at all
- **WHEN** the grace period expires with no check runs on the head commit
- **THEN** the consolidated check passes

### Requirement: Silence when the gatekeeper is disabled
When `gatekeeper.enabled` is false, no consolidated check SHALL be created or updated.

#### Scenario: Gatekeeper disabled
- **WHEN** a pull request opens in a repository whose configuration sets `gatekeeper.enabled: false`
- **THEN** no `woodhouse/white-glove` check is created
