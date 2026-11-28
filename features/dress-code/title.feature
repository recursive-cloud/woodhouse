Feature: Dress-code PR title check
  As a repository owner relying on conventional-commit releases
  I want pull request titles validated against the conventional-commit pattern
  So that squash merges always carry a title release-please can use

  @REC-50
  Scenario: A conventional title passes
    Given dress-code is enabled
    And a pull request titled "feat(settings): add the environments section"
    When the dress-code check runs for its head commit
    Then the "woodhouse/dress-code" check reports success

  @REC-50
  Scenario Outline: A non-conventional title fails with guidance
    Given dress-code is enabled
    And a pull request titled <title>
    When the dress-code check runs for its head commit
    Then the "woodhouse/dress-code" check reports failure
    And the check output names the expected pattern and the offending title

    Examples:
      | title                            |
      | "updated the readme"             |
      | "WIP"                            |
      | "FIX: urgent"                    |
      | "feat: "                         |

  @REC-50
  Scenario: An edited title flips a passing check to failure
    Given dress-code is enabled
    And a pull request titled "feat: add an environments section" whose check reported success
    When the title is edited to "quick fix"
    Then the "woodhouse/dress-code" check reports failure for the same head commit

  @REC-50
  Scenario: An edited title flips a failing check back to success
    Given dress-code is enabled
    And a pull request titled "quick fix" whose check reported failure
    When the title is edited to "fix: handle the empty payload"
    Then the "woodhouse/dress-code" check reports success for the same head commit

  @REC-50
  Scenario: A push re-checks the new head commit
    Given dress-code is enabled
    And a pull request titled "feat: add an environments section"
    When a new commit pushes to its head branch
    Then the "woodhouse/dress-code" check reports success for the new head commit
    And no duplicate check run exists on that head commit

  @REC-50
  Scenario: A re-requested check completes instead of staying queued
    Given dress-code is enabled
    And a pull request titled "feat: add an environments section"
    When the "woodhouse/dress-code" check is re-requested from the Checks tab
    Then the check reports success for the head commit

  @REC-50
  Scenario: A disabled check posts nothing
    Given dress-code is disabled
    And a pull request titled "quick fix"
    When the pull request opens
    Then no "woodhouse/dress-code" check run exists on its head commit
