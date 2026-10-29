# Design — onboard-all-repositories

## Context

`handleOnboarding` walks whatever batch `repositoryNames()` derives from the payload: `installation.repositories` on `created`, `repositories_added` on `added`, else empty. An acted-on action with an empty list logs one line and stops (handler.ts:319-324 — the comment there assumed only the fresh-install path could be list-less, which the access-switch event disproves). The decision function `shouldOnboard(repository, probe)` is purely repo-local: it sees the settings-file probe and the open-onboarding-PR probe but knows nothing about the config cascade, so a repository managed purely through the owner baseline cannot be recognized. See proposal.md for the incident and the decided direction (issue #24: B+C, "invite everything unmanaged").

## Goals / Non-Goals

**Goals:**

- A fresh All-repositories install onboards its repositories — the batch comes from enumeration, not the payload.
- Repositories whose resolved configuration already enables settings get no offer (new skip reason `baseline-managed`).
- Unknown management state fails closed: no offer, logged error, walk continues.
- The offer body no longer claims the repository may already inherit baseline.

**Non-Goals:**

- Moving the walk off the webhook response path (see Decision 3).
- Registering `installation.updated`; the `added` delta already covers a selection switch.
- Any schema or published-JSON-Schema change; no new config keys.
- Reconciling existing out-of-band onboarding PRs — the open-PR probe stays as-is (issue #28 territory).

## Decisions

### 1. Enumerate only when an acted-on delivery is list-less — via the installation-scoped octokit

When `handleOnboarding` receives an acted-on event whose batch is empty, it calls `GET /installation/repositories` (octokit `apps.listReposAccessibleToInstallation`) through `octokit.paginate` (`per_page: 100`) and treats the result as the batch, filtering to non-empty `name`s exactly as `repositoryNames()` does today. Probot binds `context.octokit` to the installation for these events, so no extra auth plumbing is needed. Enumeration happens outside the per-repository try/catch, so its failure path is explicit: an error is caught, logged as a dedicated operator-facing line (replacing today's "carried no repository list" info line in that case), and the delivery produces no offers.

*Alternatives:* registering `installation.updated` and enumerating on any selection change — rejected: it would double-walk (the `added` event enumerates the delta on the same switch) and expands event surface for no decided behavior; enumerating on every acted-on delivery even when the payload has a list — rejected: the payload list is authoritative and cheaper.

### 2. Management check reuses `ConfigResolver.resolve`; injected as a narrow function

At decision time the settings-file probe has already established that the candidate has no local file, so the full cascade (defaults → owner baseline → local-404) resolves to exactly the defaults + baseline configuration the issue defines — no separate baseline-only resolver is needed. `fetchLayer` is module-private; rather than exporting it and re-implementing merge/validate, the handler receives a narrow injected function `resolveConfig(owner, repo) → Promise<ParsedConfig | undefined>`, wired in `app.ts` as a thin wrapper around the existing shared `ConfigResolver` instance. The wrapper is where "unresolvable" is defined, because `resolve` itself never signals it: on validation failure it logs and returns defaults with a non-empty `issues` list (resolver.ts:225-231). The wrapper SHALL map to `undefined` both a rejection (HTTP error, network) and a resolution whose `issues` list is non-empty — it must never hand the decision layer the fallback defaults. `resolve` is read-only, so dry-run semantics are untouched. Cache note: the resolver's TtlCache keys the whole resolved config per `owner/repo@ref` (resolver.ts:149-151), so it deduplicates only *re-deliveries* of the same repository within TTL — an N-repo walk performs one baseline fetch per candidate, sequential (one shared resolver instance exists in `app.ts`).

Placement: the check runs in `walkRepository` right after `configPresent` and *before* the open-PR probe — a managed repository skips without paying for the PR search. The management fact reaches the decision as a new optional field on `OnboardingProbe` (`managed?: boolean`) rather than a third required parameter of `shouldOnboard`, so the decision-layer change compiles standalone and existing call sites keep their behavior (undefined is treated as not managed at the decision layer; the handler always populates the field by the time it decides, and skips unresolvable candidates earlier — see the group ordering in tasks.md). A `true` short-circuits to the new skip reason `baseline-managed`. The existing fail-closed `pull-request-state-unprobed` reason is untouched. The wrapper is where "unresolvable" is defined, because `resolve` itself never signals it: on validation failure it logs and returns defaults with a non-empty `issues` list (resolver.ts:225-231).

Resolution failure is not a decision reason — it is an operational error on the same level as "repository has no default branch": the walk logs it and moves to the next repository. This keeps `shouldOnboard` pure over plain data (architecture rule #15).

*Alternatives:* exporting `fetchLayer` and building a baseline-only resolver — rejected: forks cascade semantics and drifts from settings sync; checking only whether the baseline *file exists* — rejected: presence does not mean enabled; failing open (offer anyway) — rejected: re-creates the 0.9 incident.

### 3. Accept the redelivery window; keep the walk on the response path

Walking N repositories lengthens the delivery response past GitHub's ~10s redelivery window, and enumeration adds one more API call. Accepted deliberately: the 0.9 eight-repository walk completed without harmful duplication, and a redelivered walk is absorbed by the existing idempotency keys (settings-file probe, baseline-managed skip, open-PR probe, branch existence) — redelivery re-enumerates and re-skips everything. Moving the walk to background work would need persistence and a worker story that multi-replica constraints (in-process mutex, `strategy: Recreate`) don't support yet; the concurrent-delivery race documented in the README ("Two things worth knowing") remains the standing accepted edge, now slightly more reachable but still bounded by the same probes. The stale handler comment at handler.ts:249-252 is rewritten to describe the enumeration fallback; README documents the window and the absorption behavior.

### 4. Reword the baseline paragraph in the offer body

With Decision 2 in place, "this repository may already inherit baseline settings" is false for every recipient: an offer exists only because resolution said `settings.enabled` is not true. Replace the paragraph (wording.ts:82) with text that states the repository was checked and is not yet managed by the owner-level configuration, and that a local file is how the repository records its own consent. Tone and length stay comparable; `ONBOARDING_TEMPLATE` is unchanged.

## Risks / Trade-offs

- [Pagination regression walks only the first page] → tests drive the fake through more than one page (`per_page: 100`) and assert the full batch is walked.
- [Redelivery during a long walk interleaves with the original] → accepted trade-off (Decision 3), unchanged from the 0.9 behavior; the open-PR probe makes a duplicate walk a no-op in practice, and the README documents the window.
- [Invalid configuration that fails validation] → `resolve` reports it through `issues` rather than throwing; the wrapper maps non-empty `issues` to unresolvable, the repository is logged and skipped, the walk continues — consistent with fails-closed everywhere.
- [Invalid baseline configuration that fails YAML *parse* is invisible through `resolve`] → `fetchLayer` silently drops unparseable layers with only a warn (resolver.ts:111-115), so such an org resolves to defaults with empty `issues` and its repositories receive offers. Detecting it needs visibility into layer fetches, not just the resolved result. Accepted as a residual gap for this change and recorded for a follow-up issue; it is the resolver's existing shared behavior for every consumer, not something onboarding introduces.
- [Enumeration failure leaves an install silently un-onboarded] → the error is caught and logged as a dedicated line per delivery (Decision 1), so the operator sees why nothing happened; a later delivery retries the enumeration.
- [Larger enumeration batches than the 0.9 walk] → sequential walk already exercised; volume is bounded by repos-per-install and each offer is idempotent. Cost note: an empty-acted-on delivery adds one enumeration call, and each candidate adds a local-layer 404 probe plus a baseline fetch — one baseline fetch per candidate, sequential; the resolver cache only dedupes re-deliveries of the same repository within TTL.
- [Orgs relying on offers to baseline-managed repositories] → that behavior was the incident; the spec delta makes the skip normative, and release-please changelog surfaces it.

## Migration Plan

None. Deploy as a normal release; behavior change is immediate on the next `installation.created` / `installation_repositories.added` delivery. Rollback is reverting the release.

## Open Questions

None.
