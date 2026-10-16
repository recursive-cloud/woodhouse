# Spec Delta

## MODIFIED Requirements

### Requirement: Default-branch pushes trigger a settings sync
A push to a repository's default branch SHALL trigger a settings sync for that repository — a diff-based re-check that writes nothing when the repository already matches its configuration, except that rulesets are re-declared with an idempotent update, because GitHub's ruleset reads are normalised and cannot be compared against the planned body. Pushes to other branches and branch deletions MUST NOT trigger a sync.

#### Scenario: Settings change lands on the default branch
- **WHEN** a push to the default branch modifies `.github/woodhouse.yml`
- **THEN** Woodhouse resolves the cascaded configuration and syncs the repository to it

#### Scenario: File merely named like a settings file
- **WHEN** a push to the default branch touches only `docs/woodhouse.yml`
- **THEN** the file is not treated as a settings change: the settings cache is not invalidated
- **AND** the routine re-check writes nothing when the repository already matches its configuration

#### Scenario: Rulesets converge by re-declaration
- **WHEN** a default-branch push triggers a re-check on a repository with rulesets configured
- **THEN** each configured ruleset is re-declared with an idempotent update, and no user-visible change results when the content already matches

## ADDED Requirements

### Requirement: Ruleset conditions are typed to the repository surface
A ruleset's `conditions` SHALL accept only `ref_name` with `include` and `exclude` name lists — the only condition repository rulesets support. Any other condition key SHALL be a validation error.

#### Scenario: ref_name conditions accepted
- **WHEN** a ruleset declares `conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }`
- **THEN** the configuration validates

#### Scenario: Organization-only condition rejected
- **WHEN** a ruleset declares a `repository_name` condition (organization rulesets only)
- **THEN** validation fails with a path pointing at the condition key

### Requirement: Ruleset names are unique in a configuration
A configuration SHALL be rejected when two rulesets share a name, compared case-insensitively — names are the match key for updates, deletes, and prune protection.

#### Scenario: Duplicate names rejected
- **WHEN** a configuration lists two rulesets named `main` and `MAIN`
- **THEN** validation fails naming the duplicate

### Requirement: Prune deletes every unconfigured ruleset only by explicit opt-in
With `settings.pruneRulesets` enabled, a sync SHALL delete every ruleset in the repository that is not named in the configuration — including rulesets created outside Woodhouse. With it disabled (the default), unconfigured rulesets SHALL be left untouched. The configuration surface SHALL describe this behavior truthfully, without claiming ownership tracking that does not exist.

#### Scenario: Prune removes a hand-made ruleset
- **WHEN** a sync runs with `pruneRulesets: true` on a repository whose hand-made `hotfix` ruleset is not in the configuration
- **THEN** the `hotfix` ruleset is deleted

#### Scenario: Default leaves unconfigured rulesets alone
- **WHEN** a sync runs with `pruneRulesets` unset
- **THEN** rulesets absent from the configuration are left untouched
