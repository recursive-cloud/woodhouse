Feature: Dress-code configuration validation
  As a config author
  I want dress-code enabled only when the resolved merge settings support PR-title validation
  So that the check verdict always matches what GitHub actually merges

  @REC-50
  Scenario Outline: Enabling dress-code without coupled merge settings fails validation
    Given a pull request changing a settings file <contents>
    When the configuration validation runs
    Then the "woodhouse/config" check reports failure with the issue paths and messages

    Examples:
      | contents                                                          |
      | with dressCode enabled and rebase merges allowed                  |
      | with dressCode enabled and merge commits allowed                  |
      | with dressCode enabled and no merge settings declared             |
      | with dressCode enabled and squash merges carrying the commit message |

  @REC-50
  Scenario: A repository file cannot undo the baseline's coupling
    Given the baseline config enables dress-code with coupled merge settings
    And a pull request changing the repository settings file to allow rebase merges
    When the configuration validation runs
    Then the "woodhouse/config" check reports failure with the issue paths and messages

  @REC-50
  Scenario: Explicitly coupled merge settings validate
    Given a pull request changing a settings file with dressCode enabled, squash merges carrying the PR title, and rebase and merge-commit merges disallowed
    When the configuration validation runs
    Then the "woodhouse/config" check reports success
