/**
 * Forbidden-error classification for the settings appliers.
 *
 * `describeForbidden` explains a 403 in terms an operator can act on: a bare
 * "Forbidden" is indistinguishable from a transient fault. There are two very
 * different causes, and the plan one is easy to lose an afternoon to — branch
 * protection, rulesets and environments are simply unavailable on private
 * repositories on the Free plan, so the call fails no matter how the App is
 * configured.
 *
 * `statusOf` extracts the HTTP status carried by an Octokit request failure, if
 * any, and `messageOf` a readable message for an unknown thrown value.
 */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A readable message for an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a GitHub error message names the billing plan, which is the clearest
 * signal that a write is plan-restricted. Shared by the 403 classifier and by
 * appliers that also recognise a plan-naming 422.
 */
export function looksLikePlanLimit(message: string): boolean {
  return /upgrade|not available|plan|public repositor/i.test(message);
}

/**
 * The plan-limit explanation, framed for one applier.
 *
 * Shared with appliers that map a 404, or a plan-naming 422, to the same cause:
 * GitHub hides an endpoint entirely on plans that do not support it, so the
 * write 404s instead of returning the usual 403, and some plan-restricted
 * writes fail with a 422 whose message names the billing plan. `message` is
 * the raw GitHub message when there is one; a 404 mapping has none to add.
 */
export function planLimitDetail(applier: string, message?: string): string {
  const reason = message === undefined ? "" : `${message} `;
  return (
    `Cannot apply ${applier}: ${reason}` +
    "Branch protection, rulesets and environments require the repository to be " +
    "public, or a paid plan (Pro, Team or Enterprise) if it is private. On the " +
    "Free plan a private repository can use none of them."
  );
}

export function describeForbidden(applier: string, message: string): string {
  const planSensitive =
    applier === "branch-protection" || applier === "rulesets" || applier === "environments";

  if (planSensitive && looksLikePlanLimit(message)) {
    return planLimitDetail(applier, message);
  }

  if (planSensitive) {
    return (
      `Forbidden applying ${applier}: ${message} ` +
      "Check the App has `administration: write`. Note also that branch " +
      "protection, rulesets and environments are unavailable on private " +
      "repositories on the Free plan."
    );
  }

  return (
    `Forbidden applying ${applier}: ${message} ` +
    "The App is probably missing a permission; `administration: write` is " +
    "required for repository settings."
  );
}
