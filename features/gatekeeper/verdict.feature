@REC-21
Feature: White-glove verdict
  As the white-glove gatekeeper
  I want one consolidated verdict over every check on a pull request's head commit
  So that a repository can require a single check that means "everything passed"

  @REC-21
  Scenario Outline: A check's conclusion decides the consolidated verdict
    Given the head commit carries the checks <checks>
    When the white-glove verdict is evaluated
    Then the consolidated verdict <outcome>

    Examples:
      | checks                                           | outcome         |
      | only "build" passing                             | passes          |
      | only "build" failing                             | reports failure |
      | only "build" reporting "timed_out"               | reports failure |
      | only "build" reporting "cancelled"               | reports failure |
      | only "build" reporting "action_required"         | reports failure |
      | only "build" reporting "stale"                   | reports failure |
      | only "build" reporting "startup_failure"         | reports failure |
      | only "build" reporting "quantum_superposition"   | reports failure |
      | only "build" still running                       | stays pending   |
      | "build" passing and "test" still running         | stays pending   |
      | "build" skipped and "test" passing               | passes          |
      | "build" neutral and "test" passing               | passes          |
      | only "build" completed without a conclusion      | stays pending   |
      | only "woodhouse/white-glove" failing             | passes          |

  @REC-21
  Scenario Outline: A strict check must report success explicitly
    Given gatekeeper.strictChecks lists <strict>
    And the head commit carries the checks <checks>
    When the white-glove verdict is evaluated
    Then the consolidated verdict <outcome>

    Examples:
      | strict          | checks                        | outcome         |
      | "build"         | only "test" passing           | stays pending   |
      | "build"         | only "build" skipped          | reports failure |
      | "build"         | only "build" neutral          | reports failure |
      | "build"         | only "build" passing          | passes          |
      | "security-scan" | only "Security-Scan" passing  | stays pending   |
      | "Security-Scan" | only "Security-Scan" passing  | passes          |

  @REC-21
  Scenario Outline: Strictness beats the ignore list
    Given gatekeeper.strictChecks lists "build"
    And gatekeeper.ignoredChecks lists "build"
    And the head commit carries the checks <checks>
    When the white-glove verdict is evaluated
    Then the consolidated verdict <outcome>

    Examples:
      | checks                | outcome         |
      | only "build" failing  | reports failure |
      | only "build" skipped  | reports failure |
      | only "build" passing  | passes          |

  @REC-21
  Scenario Outline: An ignored check is excluded from the verdict
    Given gatekeeper.ignoredChecks lists "coverage"
    And the head commit carries the checks <checks>
    When the white-glove verdict is evaluated
    Then the consolidated verdict <outcome>

    Examples:
      | checks                                  | outcome |
      | only "coverage" failing                 | passes  |
      | only "coverage" still running           | passes  |
      | "coverage" failing and "build" passing  | passes  |

  @REC-21
  Scenario Outline: Same-named runs collapse to their latest attempt
    Given the head commit carries the checks <checks>
    When the white-glove verdict is evaluated
    Then the consolidated verdict <outcome>

    Examples:
      | checks                                                                                             | outcome         |
      | "ci/unit" failing started "2024-01-01T00:00:00Z" id 100 and "ci/unit" passing started "2024-06-01T00:00:00Z" id 200        | passes          |
      | "ci/unit" failing started "2024-01-01T00:00:00Z" id 100 and "ci/unit" still running started "2024-06-01T00:00:00Z" id 200 | stays pending   |
      | "shared" passing started "2024-01-01T00:00:00Z" id 10 and "shared" failing started "2024-01-01T00:00:00Z" id 20           | reports failure |
      | "shared" passing started "2024-01-01T00:00:00Z" id 10 and "shared" failing started "2025-01-01T00:00:00Z" id 20           | reports failure |

  @REC-50
  Scenario Outline: A strict dress-code check composes by the normal verdict rules
    Given gatekeeper.strictChecks lists "woodhouse/dress-code"
    And the head commit carries the checks <checks>
    When the white-glove verdict is evaluated
    Then the consolidated verdict <outcome>

    Examples:
      | checks                                                          | outcome         |
      | only "build" passing                                            | stays pending   |
      | "woodhouse/dress-code" failing and "build" passing              | reports failure |
      | "woodhouse/dress-code" passing and "build" passing              | passes          |

  @REC-50
  Scenario: A dress-code check not listed as strict does not hold the verdict when absent
    Given the head commit carries the checks only "build" passing
    When the white-glove verdict is evaluated
    Then the consolidated verdict passes

  @REC-50
  Scenario: A failing dress-code check fails the verdict without being strict
    Given the head commit carries the checks "woodhouse/dress-code" failing and "build" passing
    When the white-glove verdict is evaluated
    Then the consolidated verdict reports failure
