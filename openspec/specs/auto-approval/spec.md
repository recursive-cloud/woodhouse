# auto-approval Specification

## Purpose

Woodhouse approves pull requests on behalf of configured actors: owners
unconditionally, bots only when the bot itself enabled auto-merge. The
capability covers actor classification, the protected-path veto, idempotency
per commit, and the feedback left behind.

## Requirements

### Requirement: Actor classes are configured explicitly
Auto-approval SHALL classify a pull request author by membership in the
configured `owners` and `bots` lists, compared case-insensitively, and never
by the account type on the pull request. An author in neither list MUST NOT
be auto-approved.

#### Scenario: Owner-listed author
- **WHEN** a pull request is opened by a login in `owners` (any casing)
- **THEN** the author is classified as an owner and approval proceeds subject to the other guards

#### Scenario: Author in neither list
- **WHEN** a pull request is opened by a login in neither list
- **THEN** it is never auto-approved

### Requirement: Owners are approved unconditionally
A pull request authored by an owner SHALL be approved without
class-specific conditions, subject only to the shared guards (protected
paths, draft state, commit idempotency).

#### Scenario: Owner pull request
- **WHEN** an owner opens a pull request touching no protected path
- **THEN** Woodhouse submits an approval review for it

### Requirement: Bots must have enabled auto-merge themselves
A pull request authored by a bots-listed login SHALL be approved only when
that same login enabled auto-merge on the pull request. The decision MUST
use the pull request's current auto-merge state, not the stale snapshot in
the webhook payload.

#### Scenario: Bot with its own auto-merge
- **WHEN** a bots-listed bot authored the pull request and enabled auto-merge itself
- **THEN** Woodhouse submits an approval review

#### Scenario: Bot without auto-merge
- **WHEN** a bots-listed bot authored the pull request and nobody has enabled auto-merge
- **THEN** the pull request is not approved

#### Scenario: Auto-merge enabled by someone else
- **WHEN** auto-merge was enabled by a login other than the author
- **THEN** the pull request is not approved

#### Scenario: Late toggle is fail-safe
- **WHEN** a bot opens a pull request and enables auto-merge shortly after, with no further event yet
- **THEN** the opened evaluation declines and no approval happens until a later event re-evaluates with auto-merge enabled — the gate never wrongly approves

### Requirement: Protected paths veto every class
A pull request touching any configured protected path MUST NOT be
auto-approved, regardless of actor class.

#### Scenario: Bot widens the actor lists
- **WHEN** a bots-listed bot opens a pull request that widens the auto-approval actor lists
- **THEN** it is not approved

### Requirement: Evaluation triggers and draft handling
Auto-approval SHALL be evaluated on pull request opened, reopened,
ready_for_review and synchronize events. A draft pull request MUST NOT be
approved until it becomes ready for review.

#### Scenario: Draft becomes ready
- **WHEN** a draft pull request by an eligible author becomes ready for review
- **THEN** it is evaluated and approved if eligible

### Requirement: Approval is idempotent per commit
An approval SHALL be pinned to the pull request's head commit. A duplicate
approval for a commit Woodhouse already approved MUST NOT be submitted, and
a new commit on the same pull request SHALL be evaluated fresh.

#### Scenario: Synchronize re-approval
- **WHEN** an eligible author force-pushes a new head commit to an approved pull request
- **THEN** the new commit gets a fresh approval evaluation

#### Scenario: No duplicate at the same commit
- **WHEN** an event re-delivers for a commit Woodhouse already approved
- **THEN** no duplicate review is submitted

### Requirement: Feedback is tailored to the actor class
The approval review body SHALL be tailored to the author's class — owner
wording for owners, bot wording naming the author for bots — and every
approval SHALL end with the service sign-off.

#### Scenario: Bot approval names its author
- **WHEN** a bot pull request is approved
- **THEN** the review body names the bot and states it asked to be merged

### Requirement: Actor lists are separate and strictly validated
Auto-approval configuration SHALL declare `owners` and `bots` as separate
lists. The legacy single flat list MUST be rejected as invalid
configuration.

#### Scenario: Flat list rejected
- **WHEN** a configuration sets `allowedActors` to a flat array of logins
- **THEN** it fails validation and is reported as invalid configuration

### Requirement: Dry-run never submits approvals
In dry-run mode the approval decision SHALL be evaluated and logged, and no
review SHALL be submitted.

#### Scenario: Dry-run approval
- **WHEN** an eligible pull request arrives while dry-run mode is on
- **THEN** the decision is logged and GitHub receives no review
