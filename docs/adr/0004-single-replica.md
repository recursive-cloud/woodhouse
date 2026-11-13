# 0004. Single Replica, Serialised in Process

Status: Accepted (in force before 1.0; predates this directory)

## Context

Per-commit work (settings sync, check runs) must not race with itself. Redis would buy distributed locking at the cost of another component in a self-hosted deployment.

## Decision

One replica only. Per-commit work is serialised by the in-process keyed mutex (`src/lib/mutex.ts`), and the k8s Deployment uses `strategy: Recreate` so two pods never overlap. State that is naturally in-process (the scheduler and cache under `src/lib/`) stays in-process.

## Consequences

- A second replica requires Redis, or an equivalent external lock and cache, first. It is not a Deployment edit.
- Downtime at restart is accepted; the settings sync converges on the next event or schedule.
