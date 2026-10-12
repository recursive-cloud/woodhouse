# Spec Delta

## Purpose

Installation lockdown: the hard security boundary that decides which accounts' events Woodhouse will act on, enforced before any handler runs and refused at startup when it cannot be enforced.

## ADDED Requirements

### Requirement: Every delivery passes the allowlist before any handler
Every webhook delivery SHALL be checked against the installation allowlist before any handler runs. A delivery whose owner cannot be resolved, or whose owner is not allowlisted, SHALL run no handler.

#### Scenario: Event from a non-allowlisted account
- **WHEN** a delivery arrives for a repository whose owner is not on the App's allowlist
- **THEN** no handler runs and the rejection is logged

#### Scenario: Owner unresolvable
- **WHEN** a delivery's payload carries no owner any resolution rule can name
- **THEN** the delivery is rejected as unresolved, running no handler

### Requirement: Owner resolution falls back in order and never trusts the sender
The owner SHALL be resolved from `repository.owner.login`, falling back to `organization.login`, then to `installation.account.login` for events that carry no repository. The event's sender SHALL NOT be used to authorize — the sender is the actor who triggered the event, not the owner of the resource — and the boundary never consults it at all.

#### Scenario: Installation event without a repository
- **WHEN** an `installation` event arrives carrying no repository object
- **THEN** the owner is resolved from `installation.account.login` and the allowlist check proceeds

#### Scenario: Allowlisted sender, non-allowlisted repository
- **WHEN** an allowlisted user triggers an event on a repository owned by a non-allowlisted account
- **THEN** the delivery is rejected

### Requirement: A boundaryless configuration refuses to start
An App definition with no allowlist — neither its own nor the global default — SHALL be a startup error. So shall an empty App map, a map key that disagrees with its own App ID, and a duplicate App ID. The server SHALL exit with a configuration error rather than serve a boundary it cannot enforce.

#### Scenario: No allowlist anywhere
- **WHEN** an App definition sets no `allowedInstallationTargets` and no global default exists
- **THEN** startup fails with a refusal to start without a boundary

#### Scenario: Map key disagrees with the App ID
- **WHEN** the App map's key does not match the App ID it defines
- **THEN** startup fails rather than silently misrouting or dropping events

### Requirement: The allowlist is exact and case-insensitive
Allowlist entries SHALL be compared case-insensitively (GitHub logins are case-insensitive), SHALL NOT accept wildcards, and an empty allowlist SHALL NOT be constructible.

#### Scenario: Wildcard rejected
- **WHEN** an allowlist target is `*`
- **THEN** it is rejected at startup rather than widening the boundary to everyone

#### Scenario: Case differences still match
- **WHEN** an event's owner login differs in case from the allowlisted entry
- **THEN** the owner is allowlisted
