@REC-18
Feature: Installation lockdown boundary
  As the webhook guard
  I want to check every delivery against the allowlist and refuse a boundary I cannot enforce
  So that only allowlisted owners can act and no half-configured App ever serves

  @REC-18
  Scenario: Installation event without a repository
    Given an allowlist containing "homelab-org"
    And a webhook payload with installation account "homelab-org" and no repository
    When the payload is checked against the allowlist
    Then the owner is resolved from "installation.account.login"
    And the decision is allowed for "homelab-org"

  @REC-18
  Scenario: Allowlisted sender, non-allowlisted repository
    Given an allowlist containing "my-user"
    And a webhook payload with repository owner "stranger-org" and sender "my-user"
    When the payload is checked against the allowlist
    Then the decision is denied for "stranger-org" because "not-allowlisted"

  @REC-18
  Scenario: No allowlist anywhere
    Given an App definition with no allowedInstallationTargets and no global default
    When the App definitions are resolved
    Then startup fails with a refusal to start without a boundary

  @REC-18
  Scenario: Map key disagrees with the App ID
    Given an App definition with appId 456 under the configuration key "123"
    When the App definitions are resolved
    Then startup fails rather than silently misrouting the App's events

  @REC-18
  Scenario Outline: A wildcard target is rejected at startup
    Given the allowlist is configured through <channel> as <value>
    When the configuration is validated at startup
    Then it is rejected as a wildcard rather than widening the boundary to everyone

    Examples:
      | channel                  | value |
      | the environment variable | *     |
      | the environment variable | ["*"] |
      | a per-App target list    | ["*"] |
