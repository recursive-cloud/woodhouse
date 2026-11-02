# Proposal — log-unroutable-deliveries

## Why

GitHub webhooks arrive at Woodhouse for events nobody handles: `src/app.ts` registers only action-scoped listeners (`pull_request.opened`, `check_run.completed`, …), so `pull_request.edited`, `issues.opened` and friends are routed to an App, verified, and handed to `@octokit/webhooks`' `receive()` — which finds zero hooks and resolves silently. The server answers a 200 and nothing is logged: a misconfigured or under-scoped App is invisible, reducible only to "it's quiet". Every other rejection path already warns (unsupported target type, unusable App ID, unknown App, invalid signature); the single unlogged one is the missing-required-headers 400.

## What Changes

- `GuardedApp` records every listener registration (verbatim names as registered — bare `push` and action-scoped `pull_request.opened` alike) and exposes a derived coverage query, `handlesEvent(event, action?)`, plus a lookup by Probot instance. Recording only; no listener is added or bypassed.
- The webhook route determines the payload action defensively (single try/catch `JSON.parse`, action ignored on failure) and, when the routed App handles neither the event nor event+action, logs a warn naming delivery, event, action and App — and still responds 200. No response status code changes anywhere; the harm a non-2xx would cause is false failed-delivery marks in GitHub's App delivery list for events we deliberately ignore (the repo's archived notes record that GitHub does not redeliver a 4xx), not a retry storm.
- The missing-required-headers 400 path gains its warn log.
- README's operational notes document the two new logs.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `multi-app-operation`: routed deliveries for events with no registered handler are logged at warn while still accepted with 200 (non-2xx would mark deliberately-ignored events as failed deliveries), and the missing-headers rejection (400) is now logged. Two added requirements on the existing capability; no existing requirement text changes, so the delta carries only `## ADDED Requirements`.

## Impact

- `src/security/guard.ts` — registration recording + coverage query (no listener changes).
- `src/server.ts` / new `src/webhook-route.ts` — extraction of `handleWebhook` for testability plus the two new logs.
- `test/guard.test.ts` (extended), `test/server.test.ts` (new — first tests of the server route surface); no new dependencies.
- `README.md` — operational notes.
- Baseline suite: 35 files / 466 tests on main.
