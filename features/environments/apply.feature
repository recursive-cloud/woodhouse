Feature: Environments application
  As Woodhouse
  I want to apply the cascaded environments settings to a repository
  So that deployment environments stay aligned with configuration

  @REC-34
  Scenario: Environments declared in config are written to the repository
    Given a repository configuration with the environment "production" carrying a wait timer and reviewers
    When the settings sync runs
    Then the environment "production" is declared with its full protection state
    And the summary reports an environments update for "production"

  @REC-34
  Scenario: Environments converge by re-declaration
    Given a repository whose environments already match the configured environments
    When the settings sync runs
    Then each configured environment is re-declared with an idempotent update
    And the summary reports an environments update for each configured environment

  @REC-34
  Scenario: A removed environments entry stops the re-assertion
    Given a configuration that no longer lists an environment that was previously applied
    When the settings sync runs
    Then nothing is re-asserted for that environment
    And the existing environment is not deleted

  @REC-34
  Scenario: A local file removes an inherited environment entry with an explicit null
    Given a baseline declaring the environment "staging" and a local file nulling it
    When the settings sync runs
    Then nothing is written for "staging"

  @REC-34
  Scenario: An unset environments section performs no environment writes
    Given a configuration with no environments section
    When the settings sync runs
    Then no environment is declared
    And the existing environments are left untouched

  @REC-34
  Scenario: A local file overrides one environment's wait timer without restating the baseline's reviewers
    Given a baseline declaring the environment "production" with reviewers and a local file overriding only its wait timer
    When the settings sync runs
    Then the environment "production" is declared with the overridden wait timer and the inherited reviewers

  @REC-34
  Scenario: Environment names colliding only in case are rejected at authoring time
    Given a configuration declaring the environments "Prod" and "prod"
    When the settings sync runs
    Then no settings are written
    And the sync is skipped because "invalid-config"

  @REC-34
  Scenario: A slash in an environment name is passed verbatim as one name
    Given a repository configuration with the environment "release/production"
    When the settings sync runs
    Then the environment "release/production" is declared with its full protection state

  @REC-34
  Scenario: A plan-restricted environment write is reported as a collected failure
    Given an environment write the repository's plan does not support
    When the settings sync runs
    Then the summary reports the environments failure naming the plan limit
    And the remaining configured environments are still applied

  @REC-34
  Scenario: A forbidden environment write is reported with the forbidden detail
    Given an environment write the installation is not permitted to perform
    When the settings sync runs
    Then the summary reports the environments failure with the forbidden detail
    And the remaining configured environments are still applied

  @REC-34
  Scenario: Dry run declares environments without writing
    Given dry run mode
    When the settings sync runs
    Then no environment write is performed
    And the summary reports the environments changes as would-apply
