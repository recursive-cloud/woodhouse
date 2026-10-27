# settings-sync Delta

## ADDED Requirements

### Requirement: The baseline repository resolves its own configuration

For the baseline repository, its own root baseline-shaped files
(`woodhouse.yml`, `woodhouse.yaml`) SHALL be resolved as the repository's
local configuration layer, so settings management can be enabled on the
baseline repository itself. The baseline layer MUST NOT be fetched from the
baseline repository into its own resolution — no file merges into itself.

#### Scenario: Baseline repository merge syncs itself

- **WHEN** a settings change merges on the baseline repository whose root configuration enables settings management
- **THEN** the merged configuration has settings management enabled and the baseline repository is synced to its own root configuration
- **AND** the outcome comment reports that the baseline was synced and other repositories adopt it at their next event

#### Scenario: No self-merge

- **WHEN** the baseline repository resolves its cascaded configuration
- **THEN** only its own root configuration contributes as the local layer; the baseline layer is absent from the merge

#### Scenario: Root paths absent from the baseline repository

- **WHEN** the baseline repository has no root `woodhouse.yml` or `woodhouse.yaml`
- **THEN** its configuration resolves to defaults, as any other repository without a settings file
