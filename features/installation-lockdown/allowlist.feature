@REC-13
Feature: Installation lockdown allowlist
  As the webhook guard
  I want to reject events whose owner is unresolvable or not allowlisted
  So that only allowlisted owners can act on their repositories

  @REC-13
  Scenario Outline: The event owner is resolved from the payload's highest-priority source
    Given a webhook payload <payload>
    When the owner is resolved
    Then the owner is <owner>
    And its source is <source>

    Examples:
      | payload                                                   | owner    | source                     |
      | with repository owner "octocat" and organization "my-org" | octocat  | repository.owner.login     |
      | with organization "my-org" only                           | my-org   | organization.login         |
      | with installation account "acct" only                     | acct     | installation.account.login |
      | with sender "attacker" only                               | no owner | no source                  |
      | with blank repository owner "   " only                    | no owner | no source                  |
      | with no owner fields                                      | no owner | no source                  |
      | with a null repository object                             | no owner | no source                  |
      | that is a null value                                      | no owner | no source                  |
      | that is an undefined value                                | no owner | no source                  |
      | that is a number value                                    | no owner | no source                  |
      | that is a string value                                    | no owner | no source                  |

  @REC-13
  Scenario Outline: An allowlist check decides on the resolved owner
    Given an allowlist containing "My-User" and "homelab-org"
    When the payload <payload> is checked against the allowlist
    Then the decision is <decision>

    Examples:
      | payload                                      | decision                                              |
      | with repository owner "homelab-org"          | allowed for "homelab-org"                             |
      | with repository owner "My-User"              | allowed for "My-User"                                 |
      | with repository owner "MY-USER"              | allowed for "MY-USER"                                 |
      | with repository owner "someone-else"         | denied for "someone-else" because "not-allowlisted"   |
      | with repository owner "my-us"                | denied for "my-us" because "not-allowlisted"          |
      | with repository owner "my-user-evil"         | denied for "my-user-evil" because "not-allowlisted"   |
      | with sender "attacker" only                  | denied without owner because "unresolved-owner"       |
      | with no owner fields                         | denied without owner because "unresolved-owner"       |
      | that is a null value                         | denied without owner because "unresolved-owner"       |

  @REC-13
  Scenario: An allowlist refuses to be constructed without targets
    Given the configured allowlist targets are empty
    When an allowlist is built from them
    Then the build fails with "Allowlist requires at least one target."
