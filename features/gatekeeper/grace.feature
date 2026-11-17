@REC-21
Feature: White-glove grace period
  As the white-glove gatekeeper
  I want a commit without checks held pending for a grace period and then passed
  So that a repository without CI is not deadlocked by a required check nothing can satisfy

  @REC-21
  Scenario Outline: Inside the grace window the check holds pending and schedules a re-check
    Given a pull request opened on a head commit with <runs>
    When the first pass runs
    Then the white-glove check is pending
    And a re-check is scheduled after the grace period

    Examples:
      | runs                              |
      | no checks at all                  |
      | only the white-glove check itself |

  @REC-21
  Scenario: No CI at all
    Given a pull request opened on a head commit with no checks at all
    When the grace period elapses with still no check runs
    Then the white-glove check passes
