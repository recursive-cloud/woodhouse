@REC-16
Feature: Settings sync planning
  As the settings planner
  I want the cascaded configuration resolved, gated and planned deterministically
  So that a repository is only ever synced to configuration it opted into

  @REC-16
  Scenario Outline: The sync gate decides from the resolved configuration
    Given a baseline layer <baseline>
    And a local layer <local>
    When the repository's configuration is resolved
    Then the sync gate reports <gate>
    And the resolved settings switch is <enabled>

    Examples:
      | baseline                         | local                                | gate             | enabled |
      | that is absent                   | that is absent                       | no local file    | true    |
      | that sets settings enabled false | that sets repository has_issues true | settings disabled | false  |
      | that sets settings enabled false | that sets settings enabled true      | runs             | true    |
      | that is absent                   | that sets an invalid gatekeeper      | invalid config   | true    |
      | that is absent                   | that is not valid YAML               | no local file    | true    |

  @REC-16
  Scenario: The baseline repository resolves its root file as the baseline layer
    Given a root woodhouse.yml in the baseline repository
    When the baseline repository's configuration is resolved
    Then the root file contributes as the baseline layer
    And no local file is reported
    And the sync gate reports "no local file"

  @REC-16
  Scenario: The baseline repository resolves to defaults with no configuration anywhere
    Given no baseline file and no local file
    When the baseline repository's configuration is resolved
    Then the configuration resolves to defaults
    And no local file is reported

  @REC-16
  Scenario: The baseline repository manages itself through its own settings file
    Given a root woodhouse.yml in the baseline repository
    And the baseline repository's own .github settings file
    When the baseline repository's configuration is resolved
    Then the local file is reported
    And the sync gate reports "runs"

  @REC-16
  Scenario: A root settings file in an ordinary repository contributes nothing
    Given a baseline layer that sets repository has_wiki false
    And a local layer that sets repository has_wiki false
    And a root woodhouse.yml in the repository that sets settings enabled false
    When the repository's configuration is resolved
    Then the root file is not among the resolved sources
    And the resolved settings switch is true
    And the sync gate reports "runs"

  @REC-16
  Scenario Outline: Layers cascade with objects merged and arrays replaced
    Given a baseline layer <baseline>
    And a local layer <local>
    When the repository's configuration is resolved
    Then the merged value at <key> is <value>

    Examples:
      | baseline                                          | local                                 | key                     | value           |
      | that sets repository has_wiki false               | that sets repository has_issues true  | repository.has_wiki     | false           |
      | that sets repository has_wiki false               | that sets repository has_issues true  | repository.has_issues   | true            |
      | that sets repository has_wiki true                | that sets repository has_wiki false   | repository.has_wiki     | false           |
      | that sets gatekeeper strictChecks build and lint  | that sets gatekeeper strictChecks build | gatekeeper.strictChecks | the list build |
      | that sets gatekeeper strictChecks build           | that sets gatekeeper strictChecks none  | gatekeeper.strictChecks | an empty list  |
      | that sets repository has_wiki false               | that sets repository has_wiki null      | repository.has_wiki     | absent          |

  @REC-16
  Scenario: Layers merge before validation so baseline values survive local defaults
    Given a baseline layer that sets gatekeeper strictChecks build
    And a local layer that sets gatekeeper ignoredChecks coverage
    When the repository's configuration is resolved
    Then the configuration validates with strictChecks build and ignoredChecks coverage

  @REC-16
  Scenario: inherit false drops the baseline layer entirely
    Given a baseline layer that sets repository has_wiki false
    And a local layer that sets inherit false
    When the repository's configuration is resolved
    Then the resolved sources contain no baseline layer
    And the merged value at repository.has_wiki is absent

  @REC-16
  Scenario Outline: Ruleset conditions accept only ref_name
    Given a configuration with a ruleset named main declaring conditions <conditions>
    When the configuration is validated
    Then the validation <verdict>

    Examples:
      | conditions                                           | verdict                              |
      | that accept ref_name with include DEFAULT_BRANCH     | passes                               |
      | that reject the organization-only repository_name key | fails naming rulesets.0.conditions |

  @REC-16
  Scenario: Ruleset names are unique case-insensitively
    Given a configuration listing rulesets named main and MAIN
    When the configuration is validated
    Then the validation fails naming the duplicate

  @REC-16
  Scenario Outline: The ruleset plan converges by re-declaration and prunes only on opt-in
    Given existing rulesets <existing>
    And configured rulesets <configured>
    And pruning is <prune>
    When the ruleset plan is built
    Then it plans <plan>

    Examples:
      | existing                            | configured              | prune | plan                                        |
      | that is empty                       | that configure main     | off   | a create for main                           |
      | that hold main as id 7              | that configure main     | off   | an update for main id 7                     |
      | that hold hotfix as id 9            | that configure nothing  | off   | no deletes                                  |
      | that hold hotfix as id 9            | that configure nothing  | on    | a delete for hotfix id 9                    |
      | that hold main as id 7 and hotfix as id 9 | that configure main | on  | a delete for hotfix id 9 and an update for main id 7 |

  @REC-16
  Scenario Outline: Only the four settings paths are configuration
    Given a changed file at <path>
    When the path is classified
    Then it is <verdict>

    Examples:
      | path                     | verdict              |
      | .github/woodhouse.yml    | configuration        |
      | .github/woodhouse.yaml   | configuration        |
      | woodhouse.yml            | configuration        |
      | woodhouse.yaml           | configuration        |
      | docs/woodhouse.yml       | not configuration    |
      | sub/.github/woodhouse.yml | not configuration   |
      | woodhouse.yml.example    | not configuration    |
      | WOODHOUSE.yml            | not configuration    |

  @REC-16
  Scenario: The settings paths are exactly the four known paths
    Given the exported local and baseline paths
    Then they are exactly the four settings paths

  @REC-16
  Scenario: A removed branchProtection block plans no write for that branch
    Given a configuration that protects branches main and release
    When branch protection is planned for a configuration that stops listing release
    Then no write is planned for release
    And no branch protection is planned as a delete

  @REC-16
  Scenario: The branch protection surface points at the Convert to ruleset flow
    Given the branch protection configuration surface description
    Then it directs operators to GitHub's Convert to ruleset flow
    And it says removal does not delete the protection behind the block

  @REC-16
  Scenario: The prune surface warns it deletes hand-made rulesets
    Given the pruneRulesets configuration surface description
    Then it warns that prune deletes every ruleset not named in the configuration
    And it says that includes rulesets created outside Woodhouse
