/**
 * Guarded event registration.
 *
 * Handlers are never registered directly on the Probot instance. They are
 * wrapped so that the allowlist check is unconditionally the first thing that
 * runs for every delivery — there is no code path that reaches a handler
 * without passing the boundary, and no way to forget the check when adding a
 * new listener later.
 */

import type { Context, Probot } from "probot";
import type { EmitterWebhookEventName } from "@octokit/webhooks";
import type { Logger } from "pino";
import { Allowlist } from "./allowlist.js";

/** Context handed to guarded handlers once the owner is known to be trusted. */
export interface EventScope {
  /** Verified against the allowlist. */
  readonly owner: string;
  /** Absent for events with no repository (e.g. org-level events). */
  readonly repo: string | undefined;
  readonly deliveryId: string;
  readonly event: string;
  readonly log: Logger;
}

export type GuardedHandler<E extends EmitterWebhookEventName> = (
  context: Context<E>,
  scope: EventScope,
) => Promise<void> | void;

function repoName(payload: unknown): string | undefined {
  const name = (payload as { repository?: { name?: unknown } } | null)
    ?.repository?.name;
  return typeof name === "string" ? name : undefined;
}

export class GuardedApp {
  constructor(
    private readonly app: Probot,
    private readonly allowlist: Allowlist,
  ) {}

  /**
   * Register a handler for one or more events, behind the allowlist.
   */
  on<E extends EmitterWebhookEventName>(
    events: E | E[],
    name: string,
    handler: GuardedHandler<E>,
  ): void {
    // Probot types the emitter callback as the raw webhook event intersected
    // with a partial Context; at runtime it is always a full Context. The cast
    // is confined to this one line rather than leaking into every handler.
    this.app.on(events, (async (context: Context<E>) => {
      const decision = this.allowlist.check(context.payload);

      if (!decision.allowed) {
        // Warn, drop, and return. We intentionally do not throw: an event from
        // an unapproved owner is not an error condition on our side, and
        // throwing would produce noisy failed deliveries for something we are
        // choosing to ignore.
        context.log.warn(
          {
            handler: name,
            event: context.name,
            deliveryId: context.id,
            owner: decision.owner ?? null,
            reason: decision.reason,
            decision: "rejected",
          },
          decision.reason === "unresolved-owner"
            ? "Rejected webhook: could not determine owning account"
            : `Rejected webhook from non-allowlisted owner "${decision.owner}"`,
        );
        return;
      }

      const scope: EventScope = {
        owner: decision.owner,
        repo: repoName(context.payload),
        deliveryId: context.id,
        event: context.name,
        log: context.log.child({
          handler: name,
          owner: decision.owner,
          repo: repoName(context.payload) ?? null,
          deliveryId: context.id,
        }),
      };

      try {
        await handler(context, scope);
      } catch (error) {
        scope.log.error(
          { err: error },
          `Handler "${name}" failed while processing ${context.name}`,
        );
        // Rethrow so the delivery is marked failed in GitHub's UI and can be
        // manually redelivered. Probot surfaces this via its error handling.
        throw error;
      }
    }) as Parameters<Probot["on"]>[1]);
  }
}
