# gatekeeper Delta

## MODIFIED Requirements

### Requirement: A consolidated check is maintained per pull request

Woodhouse SHALL maintain a check run named `woodhouse/white-glove` on the head commit of every pull request in a repository it serves, creating it when absent. When the latest same-name run for the head commit is not completed, or the fresh verdict is terminal, the existing run SHALL be updated in place — never duplicating. When the fresh verdict is pending (`in_progress`) while the latest same-name run for that head commit is completed, Woodhouse SHALL create a NEW check run (same name, same head commit) instead of updating the completed one: GitHub is observed to silently ignore regressing a completed run to pending (not officially documented), so updating there would leave the required check showing a stale terminal conclusion. The verdict SHALL be re-derived fresh from the head commit's check runs whenever a pull request event, a completed check run, a completed check suite, or a re-request arrives.

#### Scenario: Pull request opens
- **WHEN** a pull request opens, reopens, or synchronizes
- **THEN** the `woodhouse/white-glove` check exists on the new head commit

#### Scenario: Another check completes
- **WHEN** a check run on the head commit completes
- **THEN** the consolidated verdict is re-derived and the check is reconciled under the rule above (updated in place, or re-created when the fresh verdict is pending over a completed run)

#### Scenario: Re-requested
- **WHEN** the consolidated check is re-requested from the pull request UI
- **THEN** the verdict is re-derived fresh and the check is reconciled under the rule above (updated in place, or re-created when the fresh verdict is pending over a completed run)

#### Scenario: Reopen re-enters pending after a completed run
- **WHEN** the fresh verdict is pending and the latest same-name run on the head commit is completed
- **THEN** a new `woodhouse/white-glove` check run is created on that head commit — same name, same head SHA — and the completed run is not modified

#### Scenario: Pending verdict over a non-completed run updates in place
- **WHEN** the fresh verdict is pending and the latest same-name run on the head commit is `in_progress` or `queued`
- **THEN** the existing run is updated in place

#### Scenario: Terminal verdict over a completed run updates in place
- **WHEN** the fresh verdict is terminal and the latest same-name run on the head commit is completed
- **THEN** the existing run is updated in place

#### Scenario: Newest same-name run drives the decision
- **WHEN** more than one `woodhouse/white-glove` run exists for the head commit (for example, a completed run and a newer re-created pending run across suites)
- **THEN** the newest run — the latest attempt, by start time — drives the create-vs-update decision
