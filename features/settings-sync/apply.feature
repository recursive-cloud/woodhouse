@REC-17
Feature: Settings sync application
  As Woodhouse
  I want to apply the cascaded woodhouse.yml settings to a repository
  So that the repository stays aligned with its configuration and the outcome is reported truthfully

  @REC-17
  Scenario: A settings change landing on the default branch is synced
    Given a default-branch push that modifies ".github/woodhouse.yml"
    When the push delivery is handled
    Then the repository is synced to its cascaded configuration
    And no outcome comment is left

  @REC-17
  Scenario: A push to another branch does not trigger a sync
    Given a push to another branch that modifies ".github/woodhouse.yml"
    When the push delivery is handled
    Then no settings sync runs for the repository

  @REC-17
  Scenario: A branch deletion does not trigger a sync
    Given a default-branch push that deletes ".github/woodhouse.yml"
    When the push delivery is handled
    Then no settings sync runs for the repository

  @REC-17
  Scenario: A push touching a file merely named like the settings file is only a re-check
    Given a default-branch push that touches only "docs/woodhouse.yml"
    When the push delivery is handled
    Then the routine re-check writes nothing when the repository already matches its configuration
    And no outcome comment is left

  @REC-17
  Scenario Outline: A resolution that fails the gate is never synced
    Given a resolved configuration <condition>
    When the settings sync runs
    Then no settings are written
    And the sync is skipped because "<reason>"

    Examples:
      | condition                         | reason            |
      | without a local settings file     | no-local-file     |
      | with settings management disabled | settings-disabled |
      | with validation issues            | invalid-config    |

  @REC-17
  Scenario: A local settings file opts the repository in
    Given a resolved configuration from a local settings file
    When the settings sync runs
    Then the appliers run in their declared order
    And the summary lists the applied changes

  @REC-17
  Scenario: Rulesets converge by re-declaration
    Given a repository whose rulesets already match the configured rulesets
    When the settings sync runs
    Then each configured ruleset is re-declared with an idempotent update
    And the summary reports a ruleset update for each configured ruleset

  @REC-17
  Scenario: Branch protection converges by re-declaration
    Given branch protection configured for branches whose protection already matches
    When the settings sync runs
    Then protection for each configured branch is re-declared
    And the summary reports a branch-protection update row per branch

  @REC-17
  Scenario: A removed branchProtection block stops the re-assertion
    Given a configuration that no longer lists a branchProtection block whose protection was previously applied
    When the settings sync runs
    Then nothing is re-asserted for that branch
    And the branch's existing protection is not removed

  @REC-17
  Scenario: A merge push and the merged event are serialised per repository
    Given a merge push delivery and the merged pull request delivery for the same repository nearly simultaneously
    When both syncs run
    Then the two syncs run in some order without interleaving
