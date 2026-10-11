/**
 * Structural dry-run guard.
 *
 * Every write to GitHub goes through `performWrite`, so DRY_RUN mode is
 * enforced by construction rather than by remembering to add an
 * `if (!ctx.dryRun)` gate at each call site. In dry-run the guard logs what it
 * would have written and returns without invoking the callback; on the live
 * path the callback's result passes straight through.
 */

import type { Logger } from "pino";

export interface WriteContext {
  readonly dryRun: boolean;
  readonly log: Logger;
}

export async function performWrite<T>(
  ctx: WriteContext,
  label: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (ctx.dryRun) {
    ctx.log.info(`DRY_RUN: would ${label}`);
    return undefined;
  }

  return run();
}
