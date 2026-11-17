@REC-22
Feature: Multi-App registry
  As the operator of one container serving several private GitHub Apps
  I want every App validated and served with its own credentials and webhook secret
  So that a configuration mistake stops startup instead of silently misrouting deliveries

  @REC-22
  Scenario: Two Apps, one container
    Given a definition file configuring Apps "111" as "org-a-app" and "222" as "org-b-app"
    When the registry is created at startup
    Then both Apps are registered
    And the startup log lists the labels "org-a-app" and "org-b-app"

  @REC-22
  Scenario: Per-App allowlist overrides the default
    Given a global default allowlist of "acme" and baseline repository ".github-private"
    And an App definition setting its own allowed installation targets to "org-a"
    When the App's settings are resolved
    Then the App's boundary is "org-a" and not "acme"
    And the App's baseline repository is the default ".github-private"

  @REC-22
  Scenario: An App without its own settings inherits the global defaults
    Given a global default allowlist of "acme" and baseline repository ".github-private"
    And an App definition with no allowlist and no baseline repository of its own
    When the defaults are applied to the App
    Then the App's boundary is "acme" and its baseline repository is ".github-private"

  @REC-22
  Scenario: An unset environment variable makes startup fail naming the App
    Given a definition file whose App is labelled "org-c" and takes its ID from an unset variable
    When the configuration is resolved at startup
    Then startup fails naming "org-c" and the unset variable

  @REC-22
  Scenario: A private key that is not a PEM makes startup fail naming the App
    Given a definition file whose App 222 has a private key that is not a PEM
    When startup validates the configuration
    Then startup fails naming the App 222 and its private key

  @REC-22
  Scenario: Health check
    Given an instance serving two Apps
    When the health endpoint is requested
    Then the response is 200 with status "ok" and an App count of 2

  @REC-22
  Scenario: A duplicate App ID is refused at startup
    Given a configuration whose two Apps both declare the App ID 111
    When the configuration is validated at startup
    Then startup fails with "Duplicate App ID 111."
