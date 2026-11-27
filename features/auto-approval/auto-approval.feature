@REC-18
Feature: Auto-approval of pull requests
  As the silver platter
  I want to approve pull requests from trusted actors on their behalf
  So that trusted authors are not left waiting on a human review

  @REC-18
  Scenario Outline: Owner-listed author
    Given auto-approval lists "My-User" as an owner
    When a pull request is opened by "<author>"
    Then the author is classified as an owner
    And the decision approves it

    Examples:
      | author  |
      | My-User |
      | MY-USER |

  @REC-18
  Scenario Outline: Author in neither list
    Given auto-approval lists "My-User" as an owner
    And the Renovate bot as a bot
    When a pull request is opened by "<author>"
    Then the author is classified as neither
    And the decision declines it

    Examples:
      | author          |
      | stranger        |
      | dependabot[bot] |

  @REC-44
  Scenario: Approval waits for the checks to pass
    Given auto-approval lists "my-user" as an owner
    When "my-user" opens a pull request while its checks fail
    Then no review is submitted
    And when the checks pass Woodhouse submits an approval review pinned to the head commit

  @REC-44
  Scenario: Bot approval also waits for the checks to pass
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    When the bot opens a pull request while its checks fail
    Then no review is submitted
    And when the checks pass Woodhouse submits an approval review pinned to the head commit

  @REC-44
  Scenario: A repository with no checks approves after the grace period
    Given auto-approval lists "my-user" as an owner
    And the repository has no checks
    When "my-user" opens a pull request
    And the grace period elapses
    Then Woodhouse submits an approval review

  @REC-44
  Scenario Outline: A refused pull request stays refused after the checks pass
    Given auto-approval lists the Renovate bot as a bot
    And <refusal>
    When the checks pass on the bot's pull request
    Then no review is submitted

    Examples:
      | refusal                                                |
      | nobody has enabled auto-merge                          |
      | "my-user" enabled auto-merge on the bot's pull request |
      | the pull request modifies ".github/woodhouse.yml"      |

  @REC-44
  Scenario: Synchronize re-approval waits for the new commit's checks
    Given auto-approval lists "my-user" as an owner
    And Woodhouse approved an earlier commit of the pull request
    When the author force-pushes a new head commit
    And the checks pass on the new commit
    Then Woodhouse submits an approval review pinned to the new commit

  @REC-44
  Scenario: A draft becoming ready is approved once its checks have passed
    Given auto-approval lists "my-user" as an owner
    And the checks have passed on the draft's head commit
    When the draft pull request becomes ready for review
    Then Woodhouse submits an approval review

  @REC-44
  Scenario: No duplicate at the same commit
    Given auto-approval lists "my-user" as an owner
    And Woodhouse already approved the head commit
    When the checks pass and the event re-delivers for the same commit
    Then no review is submitted

  @REC-18
  Scenario: Late toggle is fail-safe
    Given auto-approval lists the Renovate bot as a bot
    When the bot opens a pull request and enables auto-merge shortly after
    Then no review is submitted
    And when the checks pass Woodhouse submits an approval review pinned to the head commit

  @REC-18
  Scenario: Bot approval names its author
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    When the checks pass on the bot's pull request
    Then the review body names the bot as having asked to be merged
    And the review body ends with the service sign-off

  @REC-44
  Scenario: Dry-run approval
    Given auto-approval lists "my-user" as an owner
    And dry-run mode is on
    When the checks pass on the owner's pull request
    Then the approval decision is logged
    And GitHub receives no review
