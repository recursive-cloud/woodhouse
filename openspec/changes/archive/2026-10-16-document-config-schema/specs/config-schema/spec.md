# Spec Delta

## Purpose

The published JSON Schema for `woodhouse.yml`: editor-facing validation and documentation of the configuration surface, generated from the zod definitions that also drive the runtime validator.

## ADDED Requirements

### Requirement: The schema is generated, never hand-edited
The JSON Schema SHALL be generated from the zod definitions in the configuration schema source, and CI SHALL fail when the committed schema has drifted from them.

#### Scenario: Drift fails CI
- **WHEN** the zod definitions change and the committed schema is not regenerated
- **THEN** CI's schema check fails

### Requirement: The schema and the runtime validator agree
The published schema and the runtime validator SHALL accept and reject the same documents, proved by a test that runs both over the same corpus. Where the runtime is deliberately open — ruleset rule bodies, validated by GitHub at write time — the schema is open too, and this parity is intentional, not an oversight.

#### Scenario: Parity corpus
- **WHEN** the parity test runs valid and invalid configuration documents through both the schema and the runtime validator
- **THEN** their verdicts agree on every document

### Requirement: Every field is documented
Every field in the published schema SHALL carry a description suitable for hover documentation, derived from the same prose that documents the runtime schema. The fiddly fields — `strictChecks`, `protectedPaths`, and the rulesets section — SHALL additionally carry examples.

#### Scenario: Hover on rulesets
- **WHEN** an editor hovers the `rulesets` key in a `woodhouse.yml`
- **THEN** the schema shows guidance including the supported rule types, the `ref_name` condition shape, and a worked example

#### Scenario: Example on a fiddly field
- **WHEN** an editor requests completion for `strictChecks`
- **THEN** the schema offers an example value

### Requirement: Descriptions tell the truth
A field's description SHALL describe the behavior the runtime actually implements — including deliberately sharp edges such as prune's converge-everything semantics.

#### Scenario: Prune described truthfully
- **WHEN** the `pruneRulesets` description is read from the schema
- **THEN** it states that every ruleset absent from the configuration is deleted, including hand-made ones, and that the setting is off by default
