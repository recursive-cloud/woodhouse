# 0007. Operator Config Is CommonJS Loaded From Disk

Status: Accepted (in force before 1.0; predates this directory)

## Context

App definitions (`config/apps.cjs`) are operator-supplied code that runs inside the Woodhouse process and can be redirected with `APPS_CONFIG_PATH`. Operators need to compute values, pull from their own environment, and stay independent of the project's build tooling.

## Decision

`config/apps.cjs` stays CommonJS and is loaded with `require` (`src/apps/registry.ts`). It is deliberately not converted to ESM.

## Consequences

- Operators can generate definitions programmatically without a build step.
- The file is code, not data: it is trusted input, and the registry validates it. A map key that is not the App ID is a startup error, never a silently dropped webhook.
