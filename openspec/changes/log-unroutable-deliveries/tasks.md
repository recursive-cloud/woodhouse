# Tasks

## 1. GuardedApp records registrations and exposes handlesEvent (high-risk)

- [x] 1.1 In `src/security/guard.ts`: collect every name passed to `GuardedApp.on` (verbatim, added individually for array registrations) into an internal set; expose `handlesEvent(event: string, action?: string): boolean` and an exported Probot→GuardedApp lookup, without adding a listener to the Probot emitter or altering the allowlist interception. Verify via the extended unit tests (1.2).
- [x] 1.2 Extend `test/guard.test.ts` in the existing fakeProbot/fakeLogger style to pin the recordings and query semantics: bare event, action-scoped event, array of events, `*` registration covering any event/action, and unregistered event/action names returning false. Verify: `npx vitest run test/guard.test.ts`.
- [x] 1.3 Run the exact verification command: `npx vitest run test/guard.test.ts`, then `npm run typecheck` — both green with no new diagnostics.

## 2. Log unroutable and missing-header deliveries at the route (high-risk)

- [ ] 2.1 Extract `handleWebhook` and the target-id header constants from `src/server.ts` into a new `src/webhook-route.ts`; keep `main`, the `express.raw` wiring and shutdown in `server.ts` importing the handler. Behaviour identical. Verify: `npm run typecheck` plus the unchanged full suite runs green (`npx vitest run`).
- [ ] 2.2 In `src/webhook-route.ts`: single `JSON.parse` in try/catch to sniff `action` (string only, never logged); when the route-app lookup says the App handles neither `event` nor `event.action`, `log.warn({ deliveryId, event, action, appId }, "Delivery routed to an App with no handler for this event")` while still responding 200; add the warn to the existing missing-headers 400 path. Verify via 2.3.
- [ ] 2.3 New `test/server.test.ts`: real Express app with `express.raw` on a port-0 listener driven by node `fetch`, fake registry entries with stubbed `verifyAndReceive` and a fake injected logger. Cover: (1) unhandled event/action → 200 + warn; (2) handled event → normal path, no warn; (3) unparseable-JSON payload → no throw, action undefined in fields, still 200 on the coverage path; (4) missing headers → 400 + new warn; (5) unknown App id → 404 + warn; (6) unroutable *and* invalid signature → warn logged, response 400; (7) missing coverage record (WeakMap miss) → warn logged, normal path continues. Verify: `npx vitest run test/server.test.ts`.
- [ ] 2.4 Run the exact verification: `npx vitest run` and `npm run typecheck` — full suite green.

## 3. Document the new logs

- [ ] 3.1 README operational notes: the unroutable-delivery 200+warn and the missing-header 400+warn, alongside the existing "Rejected webhooks return 200" note. Verify: `npx oxlint README.md && npx oxfmt --check README.md`.
