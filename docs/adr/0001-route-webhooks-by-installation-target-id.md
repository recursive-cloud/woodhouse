# 0001. Route Webhooks by Installation Target ID Before Signature Verification

Status: Accepted (in force before 1.0; predates this directory)

## Context

One container serves several GitHub Apps, each with its own webhook secret. Signature verification needs the right secret, and only the `X-GitHub-Hook-Installation-Target-ID` header identifies which App sent a delivery. Probot's `run()` helper assumes a single App and mounts a landing page and setup wizard, none of which a headless server wants.

## Decision

Express owns the HTTP surface and Probot is used as a library (`src/server.ts`, `src/webhook-route.ts`). Each delivery is routed by the target-ID header to that App's Probot instance before its signature is verified. The header is unauthenticated and safe by construction. It only selects which key to try; a forged value selects a key the sender cannot sign for.

The unverified payload is parsed exactly once, bounded (`express.raw` with a 10 MB limit), and read only for a validated `action` token. Nothing else of the payload is logged or retained on that path (`sniffAction`).

## Consequences

- A delivery for an App the instance does not serve gets one clear log line and a 404; there is no silent fallback.
- Raw bodies are kept because the signature is computed over the exact bytes GitHub sent.
- Code added to the pre-verification path must stay bounded and must not trust payload contents.
