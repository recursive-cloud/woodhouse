# settings-sync Delta

## MODIFIED Requirements

### Requirement: Default-branch pushes trigger a settings sync
A push to a repository's default branch SHALL trigger a settings sync for that repository — a re-check that writes nothing when the repository already matches its configuration, except two areas that converge by unconditional re-declaration with an idempotent update and are reported as applied on every pass: rulesets (GitHub's ruleset reads are normalised and cannot be compared against the planned body) and branch protection (the GET representation differs structurally from the PUT payload, so diffing is more error-prone than an idempotent write). Pushes to other branches and branch deletions MUST NOT trigger a sync.

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

#### Scenario: Branch protection converges by re-declaration
- **WHEN** a sync runs on a repository with `branchProtection` blocks configured, whether or not the protection already matches
- **THEN** protection for each configured branch is re-PUT and a `branch-protection update` row is reported per branch, even when the content already matches

### Requirement: The comment reports the real outcome
The outcome comment SHALL report what was applied per settings area and any
failures collected during the sync. When nothing needed changing, the comment
SHALL say so rather than stay silent — and because rulesets and branch
protection are re-declared on every pass, that no-op wording applies only
when the merged configuration has no `branchProtection` blocks configured
(and no other re-declared area): with blocks configured, the comment lists
the re-declared branches every time. The wording reflects the write that
actually happened: it never claims a change that was not written, and
never writes a change without listing it.

#### Scenario: Failures are listed
- **WHEN** the sync cannot apply part of the settings, for example a ruleset write is forbidden on the plan the repository is on
- **THEN** the comment lists the failure and its reason

#### Scenario: Nothing further to change
- **WHEN** the settings were already fully applied — no re-declared areas are configured — for example by the merge push itself
- **THEN** the comment states the settings are in effect and nothing further needed changing

#### Scenario: No-op wording unreachable with branch protection configured
- **WHEN** a pure no-op sync runs on a repository whose configuration has a `branchProtection` block
- **THEN** the outcome comment does not use the no-op wording; it lists the re-declared `branch-protection update` row(s)

## ADDED Requirements

### Requirement: Removing a branchProtection block does not remove protection
A removed `branchProtection` block stops the re-assertion; pulling it from
the configuration MUST NOT delete the protection that already exists on the
branch — there is no delete path and no prune equivalent for branch
protection. The configuration surface SHALL state this and point at
GitHub's assisted branch-protection → rulesets converter as the off-boarding
path, which can delete the original protection once the ruleset has landed.

#### Scenario: Block removed, protection stays
- **WHEN** a configuration stops listing a `branchProtection` block for a branch whose protection was previously applied
- **THEN** the following syncs re-assert nothing for that branch, and the
    branch's existing protection remains in place, no longer managed by Woodhouse

#### Scenario: Off-boarding is manual
- **WHEN** an operator wants to retire branch protection in favour of rulesets
- **THEN** the configuration surface directs them to GitHub's manual "Convert to ruleset" flow rather than shipping any delete path
