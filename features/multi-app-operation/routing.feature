@REC-22
Feature: Multi-App webhook routing
  As the webhook receiver of a container serving several GitHub Apps
  I want deliveries routed by GitHub's App target header before the signature is verified
  So that each App's own secret still binds the delivery and bad ones are rejected

  @REC-22
  Scenario: Unknown App
    Given an instance serving App 111 only
    When a delivery arrives for App 99999
    Then the delivery is rejected with 404 and "unknown App"
    And a warning is logged naming the delivery "delivery-1" and the App 99999

  @REC-22
  Scenario: Repository-level webhook
    When a delivery arrives with target type "repository"
    Then the delivery is rejected with 400 and "unsupported webhook target type"

  @REC-22
  Scenario: Forged header, no matching signature
    Given an instance serving App 111 with webhook secret "alpha"
    When a delivery for App 111 arrives signed with the secret "beta"
    Then the delivery is rejected with 400 and "invalid signature"

  @REC-22
  Scenario: Handler failure is surfaced
    Given an instance serving App 111
    When a delivery arrives whose handler throws
    Then the delivery is rejected with 500 so GitHub marks it failed and can redeliver it

  @REC-22
  Scenario: Event with no registered handler
    Given the App registered for "pull_request.opened" only
    When a "pull_request" delivery with action "edited" arrives
    Then the delivery is accepted with 200
    And a warning is logged naming the delivery "delivery-1", the event "pull_request", the action "edited" and the App 111
    And the delivery is verified and received with its exact payload

  @REC-22
  Scenario: Handled event keeps the normal path
    Given the App registered for "push"
    When a "push" delivery arrives
    Then the delivery is accepted without a warning

  @REC-22
  Scenario Outline: Payload action unknown
    Given the served App has no listener for "pull_request"
    When a "pull_request" delivery arrives whose action is unreadable because <cause>
    Then the delivery is still accepted with 200
    And a warning is logged with the action omitted naming the delivery "delivery-1", the event "pull_request" and the App 111

    Examples:
      | cause                      |
      | the body is not JSON       |
      | the action is not a string |

  @REC-22
  Scenario Outline: Missing headers rejected and logged
    Given a serving instance for App 111
    When a delivery arrives without <header>
    Then the delivery is rejected with 400 and "missing required GitHub webhook headers"
    And a warning records the delivery ID as <delivery> and the event as <event>
    And the delivery is not verified

    Examples:
      | header           | delivery     | event   |
      | the delivery ID  | absent       | "push"  |
      | the event        | "delivery-1" | absent  |
      | the signature    | "delivery-1" | "push"  |
