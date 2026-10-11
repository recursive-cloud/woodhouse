/**
 * Shared types for the settings appliers.
 *
 * The appliers are plain functions over plain data (the project's convention):
 * each takes an `ApplierContext` and the resolved `WoodhouseConfig`, returns an
 * `ApplierResult`, and may throw. Thrown errors are collected as failures by
 * the orchestrator, so one repository lacking a `main` branch does not prevent
 * its labels from being synced.
 */

import type { Context } from "probot";
import type { WoodhouseConfig } from "../../config/schema.js";
import type { WriteContext } from "../../lib/dry-run.js";

type Api = Context<"push">["octokit"];

/**
 * Everything an applier needs to run one repository's sync.
 *
 * Extends `WriteContext`, so an `ApplierContext` can be handed straight to
 * `performWrite` (which enforces dry-run gating structurally).
 */
export interface ApplierContext extends WriteContext {
  readonly octokit: Api;
  readonly owner: string;
  readonly repo: string;
}

/**
 * A single applied change, small enough to render in a log line now and in a
 * merged-pull-request comment later without re-fetching anything.
 */
export interface ChangeRecord {
  readonly area: string;
  readonly action: "create" | "update" | "delete" | "rename";
  readonly target: string;
}

/**
 * A failure collected while applying one area.
 *
 * The message carries the human explanation: when a 403 is classified the
 * applier folds the `describeForbidden` detail in here, so the log (and the
 * later outcome comment) is actionable without a second GitHub fetch.
 */
export interface Failure {
  readonly area: string;
  readonly message: string;
}

export interface ApplierResult {
  readonly changes: ChangeRecord[];
  readonly failures: Failure[];
}

/** The common applier shape; each settings area implements exactly this. */
export type Applier = (ctx: ApplierContext, config: WoodhouseConfig) => Promise<ApplierResult>;
