# Architecture Decision Records

ADRs record decisions that shape how Woodhouse is built and must outlive the session that made them. Each ADR supplements the executable BDD specs; when a decision is later captured in a spec, that ADR becomes redundant and is superseded.

Decisions 0001 through 0007 predate this directory: they were in force before the 1.0 release. They are recorded here as Accepted so the reasoning is not rediscovered or reversed by accident.

Format: status line, then Context (the forces at the time), Decision, and Consequences.

[0008. Release Process](./0008-release-process.md) records the release process: release-please, least-privilege jobs, the App-minted token, image re-tagging and the manifest pins.

[0009. Settings Sync Opts In by Config File Presence](./0009-settings-sync-opt-in-by-file.md) records why a repository's own `.github/woodhouse.yml` is the settings-sync opt-in, with `settings.enabled` as the kill switch and the baseline root file never managing the baseline repository itself.

[0010. Check-Name Matching Is Case-Sensitive](./0010-case-sensitive-check-name-matching.md) records why `strictChecks` and `ignoredChecks` match check runs by exact name, so a case difference cannot satisfy or waive a requirement.

[0011. Repository Environments Are Never Deleted; They Converge by Full Re-Declaration](./0011-repository-environments-never-deleted.md) records why deployment environments are re-declared wholesale on every sync and never deleted, extending ADR 0006's posture to environment protection rules.

[0012. Deployment Branch Policies Under a Configured Environment Are Converged](./0012-deployment-branch-policies-are-converged.md) records that a configured environment's branch-policy patterns converge fully — created when missing, deleted when absent — amending 0011's never-deleted posture for patterns only, and that the config carries a plain mode string the applier maps to the API's mutually exclusive object.

[0013. Reviewer Routing Is Keyed to the Auto-Approval Actor Lists](./0013-reviewer-routing-keyed-to-auto-approval-actor-lists.md) records that reviewer requests follow the same trust model as auto-approval: owner and self-auto-merged bot pull requests are routed to Woodhouse, everything else to the configured owners, with replacement semantics for the pending routed set.
