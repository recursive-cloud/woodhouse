Feature: Reviewer routing
  As the silver platter
  I want each pull request to have the right reviewer requested
  So that bot pull requests are not left waiting on humans unnecessarily

  @REC-43
  Scenario: Owner pull request routes Woodhouse as reviewer
    Given auto-approval lists "my-user" as an owner
    When "my-user" opens a pull request
    Then Woodhouse is requested as the reviewer

  @REC-43
  Scenario: Bot pull request with its own auto-merge routes Woodhouse as reviewer
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    When the bot opens a pull request
    Then Woodhouse is requested as the reviewer

  @REC-43
  Scenario: Bot pull request without auto-merge routes the owner as reviewer
    Given auto-approval lists the Renovate bot as a bot
    And auto-approval lists "my-user" as an owner
    And nobody has enabled auto-merge
    When the bot opens a pull request
    Then the owner "my-user" is requested as the reviewer

  @REC-43
  Scenario: Author outside both lists routes the owner as reviewer
    Given auto-approval lists the Renovate bot as a bot
    And auto-approval lists "my-user" as an owner
    When "dependabot[bot]" opens a pull request
    Then the owner "my-user" is requested as the reviewer

  @REC-43
  Scenario: Draft pull request gets no reviewer
    Given auto-approval lists "my-user" as an owner
    When "my-user" opens a draft pull request
    Then no reviewer is requested

  @REC-43
  Scenario: Draft becoming ready is routed
    Given auto-approval lists "my-user" as an owner
    And "my-user" opened a draft pull request
    When the pull request becomes ready for review
    Then Woodhouse is requested as the reviewer

  @REC-43
  Scenario: Late auto-merge toggle re-routes to Woodhouse
    Given auto-approval lists the Renovate bot as a bot
    And auto-approval lists "my-user" as an owner
    And nobody has enabled auto-merge
    When the bot opens a pull request and enables auto-merge shortly after
    Then the opened routing requests the owner "my-user"
    And a later push to the pull request re-routes it to Woodhouse

  @REC-43
  Scenario: Re-routing withdraws the previous reviewer
    Given auto-approval lists the Renovate bot as a bot
    And auto-approval lists "my-user" as an owner
    And the owner "my-user" is requested as the reviewer on the bot's pull request
    And the bot enabled auto-merge itself
    When a later push re-routes the pull request to Woodhouse
    Then Woodhouse is requested as the reviewer
    And the owner "my-user" is no longer requested as a reviewer

  @REC-45
  Scenario: Failing checks pull the owner in
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    And auto-approval lists "my-user" as an owner
    When the bot's pull request fails its checks
    Then the owner "my-user" is requested as the reviewer
    And Woodhouse is no longer requested as a reviewer

  @REC-45
  Scenario: A recovered pull request is handed back to Woodhouse
    Given the owner "my-user" was requested after the bot's checks failed
    When the checks are fixed and pass
    Then Woodhouse submits an approval review
    And the owner "my-user" is no longer requested as a reviewer

  @REC-45
  Scenario: An owner pull request failing its checks gets no extra action
    Given auto-approval lists "my-user" as an owner
    When "my-user" opens a pull request and its checks fail
    Then no additional review request is made

  @REC-45
  Scenario: Repeated failure does not duplicate the owner request
    Given the owner "my-user" is requested as the reviewer on the bot's pull request
    When another check fails on the same commit
    Then the owner "my-user" is requested as the reviewer exactly once

  @REC-45
  Scenario: A bot touching a protected path is handed to the owners
    Given auto-approval lists the Renovate bot as a bot
    And the bot enabled auto-merge itself
    And auto-approval lists "my-user" as an owner
    And the pull request modifies ".github/woodhouse.yml"
    When the checks pass
    Then the owner "my-user" is requested as the reviewer
    And Woodhouse is no longer requested as a reviewer
