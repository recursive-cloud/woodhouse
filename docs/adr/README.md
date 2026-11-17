# Architecture Decision Records

ADRs record decisions that shape how Woodhouse is built and must outlive the session that made them. Each ADR supplements the executable BDD specs; when a decision is later captured in a spec, that ADR becomes redundant and is superseded.

Decisions 0001 through 0007 predate this directory: they were in force before the 1.0 release. They are recorded here as Accepted so the reasoning is not rediscovered or reversed by accident.

Format: status line, then Context (the forces at the time), Decision, and Consequences.

[0008. Release Process](./0008-release-process.md) records the release process: release-please, least-privilege jobs, the App-minted token, image re-tagging and the manifest pins.

[0009. Settings Sync Opts In by Config File Presence](./0009-settings-sync-opt-in-by-file.md) records why a repository's own `.github/woodhouse.yml` is the settings-sync opt-in, with `settings.enabled` as the kill switch and the baseline root file never managing the baseline repository itself.
