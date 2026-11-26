Feature: Environment branch policies
  As Woodhouse
  I want an environment's custom branch policy patterns to converge to configuration
  So that the deployment allowlist stays exactly what the baseline declares

  @REC-35
  Scenario: Custom branch patterns are created
    Given the environment "production" in custom branch policy mode declaring the patterns "main" and "release/*"
    When the settings sync runs
    Then both patterns are declared on the environment
    And the summary names the environment and pattern for each branch-policy change

  @REC-35
  Scenario: A pattern removed from config is deleted from the environment
    Given the environment "production" with a configured pattern that was previously applied and a pattern now removed from its list
    When the settings sync runs
    Then the removed pattern is deleted from the environment
    And the remaining configured patterns are kept

  @REC-35
  Scenario: Declaring a pattern the environment already has is not an error
    Given the environment "production" in custom mode whose patterns already match the configuration
    When the settings sync runs
    Then each configured pattern is present on the environment
    And no error is reported

  @REC-35
  Scenario: Switching an environment to custom mode re-declares its patterns
    Given the environment "production" switching from protected-branch mode to custom branch policies with declared patterns
    When the settings sync runs
    Then the environment's deployment branch policy is set to custom mode
    And the declared patterns are present on the environment

  @REC-35
  Scenario: Patterns declared without custom mode are rejected at authoring time
    Given the environment "production" declaring patterns without selecting custom branch policies
    When the settings sync runs
    Then no settings are written
    And the sync is skipped because "invalid-config"

  @REC-35
  Scenario: Custom mode with no patterns converges to an empty allowlist
    Given the environment "production" in custom branch policy mode declaring no patterns
    When the settings sync runs
    Then no pattern is created
    And patterns present on the environment but absent from config are removed

  @REC-35
  Scenario: Pattern lists colliding only in case are rejected at authoring time
    Given the environment "production" declaring the patterns "Main" and "main"
    When the settings sync runs
    Then no settings are written
    And the sync is skipped because "invalid-config"
