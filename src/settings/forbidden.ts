/**
 * Forbidden-error classification for the settings appliers.
 *
 * `describeForbidden` explains a 403 in terms an operator can act on: a bare
 * "Forbidden" is indistinguishable from a transient fault. There are two very
 * different causes, and the plan one is easy to lose an afternoon to — branch
 * protection and rulesets are simply unavailable on private repositories on
 * the Free plan, so the call fails no matter how the App is configured.
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

export function describeForbidden(applier: string, message: string): string {
  // GitHub's own wording for the plan case is the clearest signal available.
  const looksLikePlanLimit = /upgrade|not available|plan|public repositor/i.test(message);

  const planSensitive = applier === "branch-protection" || applier === "rulesets";

  if (planSensitive && looksLikePlanLimit) {
    return (
      `Cannot apply ${applier}: ${message} ` +
      "Both branch protection and rulesets require the repository to be " +
      "public, or a paid plan (Pro, Team or Enterprise) if it is private. " +
      "On the Free plan a private repository can use neither."
    );
  }

  if (planSensitive) {
    return (
      `Forbidden applying ${applier}: ${message} ` +
      "Check the App has `administration: write`. Note also that branch " +
      "protection and rulesets are unavailable on private repositories on " +
      "the Free plan."
    );
  }

  return (
    `Forbidden applying ${applier}: ${message} ` +
    "The App is probably missing a permission; `administration: write` is " +
    "required for repository settings."
  );
}
