@REC-21
Feature: White-glove check reconciliation
  As the white-glove gatekeeper
  I want the consolidated check kept in step with the latest same-name run and the fresh verdict
  So that a required check never shows a stale conclusion

  @REC-21
  Scenario Outline: The write follows the latest white-glove run and the fresh verdict
    Given the head commit carries <white-glove runs>
    And the commit carries <child checks>
    When the white-glove check is reconciled
    Then <decision>

    Examples:
      | white-glove runs                                                              | child checks             | decision                                             |
      | no white-glove run                                                            | a running build check    | a new white-glove run is created on the head commit  |
      | no white-glove run                                                            | a passing build check    | a new white-glove run is created on the head commit  |
      | no white-glove run                                                            | a failing build check    | a new white-glove run is created on the head commit  |
      | a white-glove run in progress                                                 | a running build check    | the white-glove run with id 301 is updated in place  |
      | a white-glove run queued                                                      | a running build check    | the white-glove run with id 500 is updated in place  |
      | a white-glove run in status "preparing"                                       | a running build check    | the white-glove run with id 600 is updated in place  |
      | a white-glove run in status "requested"                                       | a running build check    | the white-glove run with id 700 is updated in place  |
      | a white-glove run completed and failing                                       | a passing build check    | the white-glove run with id 302 is updated in place  |
      | a white-glove run completed and failing                                       | a failing build check    | the white-glove run with id 302 is updated in place  |
      | a white-glove run completed and failing                                       | a running build check    | a new white-glove run is created on the head commit  |
      | a completed white-glove run and a newer in progress white-glove run           | a running build check    | the white-glove run with id 401 is updated in place  |
      | a foreign-named run and a white-glove run in progress                         | a running build check    | the white-glove run with id 401 is updated in place  |
      | a white-glove run without a start time and an older completed white-glove run | a running build check    | a new white-glove run is created on the head commit  |

  @REC-21
  Scenario: A pull request event seeds the check on the head commit
    Given the head commit has no white-glove run and no child checks
    When the white-glove check is seeded for a pull request event
    Then a new white-glove run is created on the head commit as pending

  @REC-21
  Scenario: A completed check run triggers a fresh reconciliation
    Given the head commit carries a white-glove run completed and failing
    And the commit carries a failing build check
    When the white-glove check is reconciled for a completed check run event
    Then the fresh verdict is re-derived from every check on the head commit
    And the white-glove run with id 302 is updated in place as failed

  @REC-21
  Scenario: A completed check suite triggers a fresh reconciliation
    Given the head commit carries a white-glove run completed and failing
    And the commit carries a failing build check
    When the white-glove check is reconciled for a completed check suite event
    Then the fresh verdict is re-derived from every check on the head commit
    And the white-glove run with id 302 is updated in place as failed

  @REC-21
  Scenario: A re-request re-derives the verdict fresh
    Given the head commit carries a white-glove run completed and failing
    And the commit carries a failing build check
    When the white-glove check is re-requested
    Then the white-glove run with id 302 is updated in place as failed

  @REC-21
  Scenario: The gatekeeper is disabled
    Given gatekeeper.enabled is false
    And the head commit has no white-glove run and no child checks
    When the white-glove check is reconciled
    Then no white-glove run is created or updated
