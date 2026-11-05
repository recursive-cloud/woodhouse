# Design — log-unroutable-deliveries

## Context

`handleWebhook` (src/server.ts:122) routes by `X-GitHub-Hook-Installation-Target-ID` to the registry's Probot instance and hands the delivery to `app.probot.webhooks.verifyAndReceive` (server.ts:176). When no listener is registered for the event/action, `@octokit/webhooks`' `receive()` finds zero hooks and resolves — silent 200 (server.ts:182). `app.ts` registers only action-scoped names through `GuardedApp`, and no wildcard hooks exist; `onAny` could not observe the zero-hook path anyway. Verified against @octokit/webhooks v12.3.2 (`event-handler/receive.ts`). Config rule: fails closed, no wildcards, no silent fallbacks; and `GuardedApp` must remain the only listener registration path.

## Goals / Non-Goals

**Goals:**
- Every accepted delivery for which the routed App has no handler produces a warn log with delivery/event/action/App.
- The missing-required-headers rejection (400) produces a warn log.
- Response status codes unchanged anywhere; the observable change is logs only.

**Non-Goals:**
- No new rejection of unroutable events (see D3), no metrics endpoint, no per-App dashboards, no response-body change, no new dependencies.

## Decisions

**D1 — Coverage derived from actual registrations (`GuardedApp`), recorded verbatim.** `GuardedApp.on` is the single choke point every listener passes (repo rule), so recording there can never drift from reality. `on` keeps its behaviour (allowlist + handler) and additionally collects the registration names into an internal set; `handlesEvent(event, action?)` answers from that set. Records are verbatim: a bare `push` registration and an action-scoped `pull_request.opened` registration are each stored exactly as given. Alternative — also recording the bare `pull_request` form for action-scoped names — was rejected because it would make `pull_request.edited` look covered and defeat the purpose; it is a drift disguised as completeness. Query semantics: with `action` known, `handlesEvent` returns true iff the set contains `event` itself (all-actions listener) or `${event}.${action}`; with `action` unknown, iff the set contains `event` itself. A `*` registration (never used by Woodhouse, but a legal `@octokit/webhooks` listener) is recognised as covering everything — recognising an existing listener, not adding a wildcard; the recognition is unit-tested so it cannot silently break.

**D2 — Lookup by Probot instance via a module-level `WeakMap`, miss made observable.** The `GuardedApp` is created inside the `woodhouse` app function (src/app.ts:66) loaded by `probot.load`, so the registry cannot hold it in `RegisteredApp` without re-plumbing `makeApp`/registry types. The constructor keys itself in an exported `WeakMap<Probot, GuardedApp>` and the route uses `guardedByProbot.get(app.probot)`. Alternative — a `handlesEvent` on `Probot` itself — mutates a foreign class. A lookup miss is an internal invariant break, not a state to hide: the route logs a warn (`"Delivery routed to an App with no coverage record; treating as handled"`) and proceeds — observable, not silently dropped.

**D3 — The 200 stays; the log is the fix.** Unhandled-but-registered-elsewhere events (`pull_request.labeled`, `issues.opened`) arrive continuously; responding non-2xx would mark each one as a *failed* delivery in GitHub's delivery list for the App — noise for deliveries we deliberately ignore (see the archived backfill notes: GitHub does not redeliver a 4xx, so there is no retry storm to fear — the harm is false failure marks, plus no signal today at all). Requirement is "never silent", not "never accepted". Log uses the injected root logger with `{ deliveryId, event, action, appId }` and message `"Delivery routed to an App with no handler for this event"`, logged before `verifyAndReceive`.

**D4 — Extract `handleWebhook` into `src/webhook-route.ts`.** `server.ts` calls `main()` at import, so a test importing it boots the server. The handler plus the target-id header constants move to `src/webhook-route.ts`; `server.ts` keeps `main`, middleware wiring (`express.raw`) and shutdown, importing the handler. Behaviour identical; test imports the route module instead.

**D5 — Bounded, payload-blind action sniff.** One `JSON.parse` of the raw payload in try/catch. `action` is taken only when it is a string matching GitHub's action vocabulary — `^[a-z0-9_-]{1,64}$` — so an unverified attacker-controlled field cannot walk megabytes of garbage into the log line; anything else degrades to `undefined` and the coverage check runs event-only. Nothing else of the payload is consulted or logged on the pre-verification path (logger redaction also still applies post-verification).

**D6 — Missing-header warn fields.** `log.warn({ deliveryId, event }, "Delivery rejected: missing required GitHub webhook headers")` on the existing 400 path — passing whichever of the three values exists, mirroring the style of neighbouring rejections (targetType warn at server.ts:142).

**D7 — Server-level tests without new deps: real Express on port 0 + node `fetch`.** `test/server.test.ts` builds the same route surface as `server.ts` (`express.raw` + `handleWebhook`, wrapped in `http.createServer`), binds to port 0, and drives it with `fetch`. Fake registry entries mimic `RegisteredApp` with a stubbed `probot.webhooks.verifyAndReceive` (success, or a rejection-shaped error for the 400 signature case), and an injected fake logger in the style of `test/guard.test.ts`. Cases: unhandled event/action → 200 + warn; handled event → normal path, no warn; unparseable payload → no throw, `action` undefined in the warn, still 200 on the coverage path; missing headers → 400 + warn; unknown App → 404 + warn (pins existing behaviour); unroutable *and* invalid signature → warn logged, response 400 (coverage does not swallow the signature rejection); missing coverage record → warn and normal proceed. `supertest` is (still) not a devDependency, so it is not added.

**D8 — Reuse, not duplication, of `GuardedApp`.** This change touches `src/security/guard.ts` while the rule says every webhook listener is registered through `GuardedApp`. It records existing registrations and adds no listener, registers nothing on the Probot emitter, and bypasses nothing — `on`'s allowlist interception is untouched, so the guard rule's intent (every delivery passes the allowlist boundary) is preserved; this document says so explicitly for the record.

## Risks / Trade-offs

- [Warn noise on deliberately-ignored events] → That is the capability: the logs are how an operator sees an under-scoped App. Single-line JSON keeps them filterable by `event`/`appId`.
- [Pre-verification parse of up to 10 MB payloads] → One bounded `JSON.parse` per delivery on an already-materialised string; same order of cost as the signature check that follows.
- [Unverified payload influencing log content] → Only `action`, gated to GitHub's vocabulary and length-capped (D5).
- [Multi-App future drift if a Probot loads two guarded app functions] → Miss is warn-logged (D2), never silent; can be tightened then.

## Migration Plan

None required: additive logging, single replica, no config or schema change. Roll back by reverting the two commits (route + guard; README separately).

## Open Questions

None.
