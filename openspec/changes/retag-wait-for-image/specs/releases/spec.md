# Spec Delta

## MODIFIED Requirements

### Requirement: Images are tagged with release versions without rebuilding
On a published release, the container image built for the release commit SHALL be tagged with the release version (`vX.Y.Z`) and the floating major tag (`vX`) by re-tagging the existing image, not by building a new one. The re-tag SHALL first wait — bounded — for the release commit's image to exist rather than fail while the push build is still running, and SHALL fail loudly when the wait times out.

#### Scenario: Release published
- **WHEN** a release is published
- **THEN** the image digest that the release commit's push build produced carries the `vX.Y.Z` and `vX` tags

#### Scenario: Release cut while the image build is still running
- **WHEN** the release cut completes while the release commit's push build is still building
- **THEN** the re-tag job waits for the image to appear and completes without a manual re-run

#### Scenario: The wait times out
- **WHEN** the release commit's image does not appear within the bound
- **THEN** the re-tag job fails with a message pointing at the runbook recovery
