@REC-17
Feature: Settings sync merge feedback
  As Woodhouse
  I want merged settings pull requests to receive the real apply outcome
  So that the author sees what was applied and what failed

  @REC-17
  Scenario: A merged settings pull request gets an outcome comment
    Given a pull request that changes ".github/woodhouse.yml" merged into the default branch
    When the merged delivery is handled
    Then the repository is synced
    And the pull request receives one outcome comment listing what was applied

  @REC-17
  Scenario: A merge into a non-default branch is silent
    Given a settings-changing pull request merged into a feature branch
    When the merged delivery is handled
    Then no sync runs
    And no comment is left

  @REC-17
  Scenario: A pull request closed without merging is silent
    Given a settings-changing pull request closed without merging
    When the merged delivery is handled
    Then no sync runs
    And no comment is left

  @REC-17
  Scenario: Deleting the settings file ends management
    Given a merged pull request that deletes ".github/woodhouse.yml"
    When the merged delivery is handled
    Then the deletion is treated as a settings change
    And no sync runs because the local settings file is now absent
    And no comment is left

  @REC-17
  Scenario: A re-delivery updates the outcome comment in place
    Given a merged settings pull request that already has an outcome comment
    When the merged delivery is handled again
    Then the existing comment is updated in place
    And no second comment is created

  @REC-17
  Scenario: A merged pull request that disables settings management is silent
    Given a merged pull request whose resolved configuration disables settings management
    When the merged delivery is handled
    Then the cache is still checked and the configuration still resolved
    And no sync runs and no comment is left

  @REC-17
  Scenario: A repository-level true overrides a baseline false
    Given an owner baseline that disables settings management and a local settings file that enables it
    When the merged delivery is handled
    Then the repository is synced
    And the pull request receives an outcome comment

  @REC-17
  Scenario: A baseline merge without a local settings file is silent
    Given a merged settings change on the baseline repository that touches only the root baseline file
    When the merged delivery is handled
    Then no sync runs because the file-presence gate reports no local file
    And no comment is left

  @REC-17
  Scenario: A baseline merge with a local settings file reports the baseline synced
    Given a merged settings change on the baseline repository that carries its own settings file
    When the merged delivery is handled
    Then the baseline repository is synced
    And the comment states the baseline was synced and other repositories adopt the change at their next event
    And the comment does not claim every repository was re-synced

  @REC-17
  Scenario: Failures are listed
    Given a settings sync where a write is forbidden
    When the sync runs and the outcome comment is built
    Then the comment lists the failure and its reason

  @REC-17
  Scenario: Nothing further to change
    Given a merged settings pull request whose settings were already fully applied
    When the merged delivery is handled
    Then the comment states the settings are in effect and nothing further needed changing

  @REC-17
  Scenario: The no-op wording is not used when branch protection was re-declared
    Given a pure no-op configuration with a branchProtection block
    When the merged delivery is handled
    Then the comment lists the re-declared branch-protection update rows
    And the comment does not state that nothing further needed changing

  @REC-17
  Scenario: A dry run logs the outcome and writes nothing
    Given a merged settings pull request while dry-run mode is on
    When the merged delivery is handled
    Then the decision and comment body are logged
    And GitHub receives no comment
