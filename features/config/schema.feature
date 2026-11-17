@REC-15
Feature: The published JSON Schema
  As a configuration author
  I want a JSON Schema generated from the zod definitions that agrees with the runtime validator
  So that editors validate "woodhouse.yml" before it is pushed

  @REC-15
  Scenario Outline: Drift fails CI
    Given the committed JSON Schema <state>
    When the schema check runs
    Then it <result>

    Examples:
      | state                                | result                                          |
      | matches the zod definitions          | passes                                          |
      | has drifted from the zod definitions | fails and says to run "npm run schema:generate" |
      | is missing                           | fails and says to run "npm run schema:generate" |

  @REC-15
  Scenario: Parity corpus
    Given a corpus of valid and invalid configuration documents including the shipped example
    When the corpus runs through the published schema and the runtime validator
    Then their verdicts agree on every document

  @REC-15
  Scenario: Hover on rulesets
    When an editor hovers the "rulesets" key in a "woodhouse.yml"
    Then the schema shows guidance including the supported rule types, the "ref_name" condition shape, and a worked example

  @REC-15
  Scenario: Example on a fiddly field
    When an editor requests completion for "strictChecks"
    Then the schema offers an example value

  @REC-15
  Scenario: Prune described truthfully
    When the "pruneRulesets" description is read from the schema
    Then it states that every ruleset absent from the configuration is deleted, including hand-made ones
    And that the setting is off by default
