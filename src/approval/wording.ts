/**
 * Approval review bodies, tailored to the author's actor class.
 *
 * Pure string construction, kept out of the API-calling module so the exact
 * wording is directly testable. Both bodies end with the service sign-off.
 */

import type { ActorClass } from "./policy.js";

/** The sign-off every approval carries, whichever class the author is. */
const SIGN_OFF = "_Woodhouse, at your service._";

/** Butler register for an owner: approval on their behalf. */
const OWNER_REASON =
  "Very good, sir. Approving on your behalf — this pull request touches no protected paths.";

/**
 * Butler register for a bot, naming the author. The bot has asked to be merged
 * itself, so we let it in rather than speaking on the owner's behalf.
 */
function botReason(author: string): string {
  return (
    "Sir, just letting you know I am letting the handyman in to fix a few things — " +
    `${author} asked to be merged and this pull request touches no protected paths.`
  );
}

/**
 * Build the review body for an approval. `neither` is never submitted (the
 * decision declines such an author), but the function stays total and uses the
 * bot wording for it.
 */
export function approvalBody(actorClass: ActorClass, author: string): string {
  const reason = actorClass === "owner" ? OWNER_REASON : botReason(author);
  return `${reason}\n\n${SIGN_OFF}`;
}
