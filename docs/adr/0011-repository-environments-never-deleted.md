# 0011. Repository Environments Are Never Deleted; They Converge by Full Re-Declaration

Status: Accepted (operator, 2026-11-25)

## Context

GitHub documents neither replace nor merge semantics for the environment
protection-rules PUT, and the GET representation does not round-trip against
the PUT payload. Environments carry deployment protection, so silently deleting
one — or silently dropping a reviewer from it — locks deployments without
anyone deciding to.

## Decision

Extending ADR 0006's posture to environments: convergence is by unconditional
re-declaration. Every configured environment is PUT with its complete desired
state on every sync — unset fields are sent as the API defaults (`wait_timer`
0, `prevent_self_review` false, `reviewers` null) and `deployment_branch_policy`
as null — so the configuration is the single source of truth for the
environments it names. Woodhouse never deletes an environment: removing the
entry from config stops the re-assertion and leaves the repository's
environment in place.

## Consequences

- Syncs are idempotent and simple, at the cost of a PUT per configured
  environment on every sync, even when nothing changed.
- A hand-tuned environment drifts back to the declared state on the next sync;
  off-boarding is the operator's job, in GitHub's UI.
- A case-variant environment already on the repository is left untouched:
  matching is by exact declared name.
- Deployment branch-policy convergence may later amend this ADR.
