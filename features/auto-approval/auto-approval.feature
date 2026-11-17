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

  @REC-18
  Scenario: Owner pull request
    Given auto-approval lists "my-user" as an owner
    When "my-user" opens a pull request touching no protected path
    Then Woodhouse submits an approval review

  @REC-18
  Scenario: Bot with its own auto-merge
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    When the pull request is evaluated
    Then Woodhouse submits an approval review

  @REC-18
  Scenario: Bot without auto-merge
    Given auto-approval lists the Renovate bot as a bot
    And nobody has enabled auto-merge
    When the pull request is evaluated
    Then no review is submitted

  @REC-18
  Scenario: Auto-merge enabled by someone else
    Given auto-approval lists the Renovate bot as a bot
    And "my-user" enabled auto-merge on the bot's pull request
    When the pull request is evaluated
    Then no review is submitted

  @REC-18
  Scenario: Late toggle is fail-safe
    Given auto-approval lists the Renovate bot as a bot
    When the bot opens a pull request and enables auto-merge shortly after
    Then the opened evaluation submits no review
    And a later event re-evaluates the pull request with auto-merge enabled
    And that evaluation submits an approval review

  @REC-18
  Scenario: Bot widens the actor lists
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    When the pull request modifies ".github/woodhouse.yml"
    Then no review is submitted

  @REC-18
  Scenario: Draft becomes ready
    Given auto-approval lists "my-user" as an owner
    When the draft pull request becomes ready for review
    Then Woodhouse submits an approval review

  @REC-18
  Scenario: Synchronize re-approval
    Given auto-approval lists "my-user" as an owner
    And Woodhouse approved an earlier commit of the pull request
    When the author force-pushes a new head commit
    Then Woodhouse submits an approval review pinned to the new commit

  @REC-18
  Scenario: No duplicate at the same commit
    Given auto-approval lists "my-user" as an owner
    And Woodhouse already approved the head commit
    When the event re-delivers for the same commit
    Then no review is submitted

  @REC-18
  Scenario: Bot approval names its author
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    When the pull request is approved
    Then the review body names the bot as having asked to be merged
    And the review body ends with the service sign-off

  @REC-18
  Scenario: Dry-run approval
    Given auto-approval lists "my-user" as an owner
    And dry-run mode is on
    When the owner's pull request is evaluated
    Then the approval decision is logged
    And GitHub receives no review
