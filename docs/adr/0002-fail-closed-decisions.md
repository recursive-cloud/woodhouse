# 0002. Fail Closed on Every Decision

Status: Accepted (in force before 1.0; predates this directory)

## Context

Woodhouse writes to repositories on the operator's behalf. A change that silently does the wrong thing is far worse than a loud stop.

## Decision

Every trust and configuration decision fails closed:

- Unknown config keys are rejected by the zod schema. There is no wildcard and no silent fallback.
- An App definition with no installation allowlist is a startup error: the process exits 78 (`EX_CONFIG`) rather than serving.
- Unrecognised gatekeeper check conclusions fail the check rather than pass it.
- Deliveries with invalid signatures get 400. Handlers that throw get 500, so GitHub marks the delivery failed and can redeliver it.

## Consequences

- Mistakes stop loudly at startup or at the decision boundary instead of writing somewhere wrong.
- Adding behaviour means adding an explicit allowlist entry, schema key or conclusion case first.
