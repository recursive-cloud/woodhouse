@REC-15
Feature: Pull-request configuration validation
  As the configuration gatekeeper
  I want settings files changed by a pull request validated against the schema
  So that an invalid configuration cannot merge silently

  @REC-15
  Scenario Outline: Pull request adds a local config
    Given a pull request that adds <path>
    When the configuration validation runs
    Then the file at the pull request head is validated

    Examples:
      | path                     |
      | ".github/woodhouse.yml"  |
      | ".github/woodhouse.yaml" |

  @REC-15
  Scenario Outline: Baseline config pull request
    Given a pull request on the baseline repository that changes <path>
    When the configuration validation runs
    Then the file at the pull request head is validated

    Examples:
      | path             |
      | "woodhouse.yml"  |
      | "woodhouse.yaml" |

  @REC-15
  Scenario Outline: Near-miss filename
    Given a pull request that changes only <path>
    When the configuration validation runs
    Then no settings file is treated as changed and no validation runs

    Examples:
      | path                     |
      | "docs/woodhouse.yml"     |
      | "src/woodhouse.yml"      |
      | "README.md"              |
      | ".github/dependabot.yml" |

  @REC-15
  Scenario: Deletion is not validated
    Given a pull request whose only settings change deletes ".github/woodhouse.yml"
    When the configuration validation runs
    Then no "woodhouse/config" check is posted for it

  @REC-15
  Scenario Outline: Non-regular file is not validated
    Given a pull request that replaces ".github/woodhouse.yml" with a <kind>
    When the configuration validation runs
    Then no "woodhouse/config" check is posted for it

    Examples:
      | kind      |
      | symlink   |
      | submodule |

  @REC-15
  Scenario Outline: Valid configuration
    Given a pull request changing a settings file <contents>
    When the configuration validation runs
    Then the "woodhouse/config" check reports success

    Examples:
      | contents                   |
      | that is a valid document   |
      | that is an empty file      |
      | that is a comment only     |

  @REC-15
  Scenario Outline: Invalid configuration
    Given a pull request changing a settings file <contents>
    When the configuration validation runs
    Then the "woodhouse/config" check reports failure with the issue paths and messages

    Examples:
      | contents                                   |
      | with an unknown top-level key              |
      | with a misspelled "autoApproval" key       |
      | with a wrong type under "gatekeeper"       |
      | with "repository.private" set              |
      | with "repository.archived" set             |
      | with an out-of-range grace period          |

  @REC-15
  Scenario: Comment explains and suggests
    Given a pull request changing a settings file with a wrong type under "gatekeeper"
    And no comment on the pull request yet
    When the configuration validation runs
    Then one comment lists the issues and suggests adding the schema modeline to the file

  @REC-15
  Scenario: Next push fixes the file
    Given a pull request carrying the marker comment from an earlier push
    And a later push that makes every settings file validate
    When the configuration validation runs
    Then the comment is deleted

  @REC-15
  Scenario: Re-delivery does not duplicate
    Given a pull request carrying the marker comment from an earlier push
    And the settings file still fails validation
    When the same pull request event re-delivers
    Then the existing comment is updated in place, never duplicated

  @REC-15
  Scenario: Valid from the start
    Given a pull request whose settings files all validate
    And no comment on the pull request yet
    When the configuration validation runs
    Then no comment is left and the "woodhouse/config" check passes

  @REC-15
  Scenario: Dry-run validation
    Given dry-run mode is on
    And a pull request changing a settings file with a wrong type under "gatekeeper"
    When the configuration validation runs
    Then GitHub receives no comment and no check run
    And each suppressed check and comment write is logged as a skipped write
