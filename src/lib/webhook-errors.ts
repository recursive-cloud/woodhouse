/**
 * Distinguish "we rejected this request" from "our handler broke".
 *
 * `@octokit/webhooks` reports a bad signature as an error carrying HTTP 400,
 * but may wrap it in an AggregateError alongside listener errors, so the
 * aggregate has to be inspected rather than just the outer error's name.
 *
 * The distinction matters operationally: a 400 means GitHub should not retry,
 * whereas a 500 marks the delivery failed so it can be redelivered once the
 * underlying fault is fixed.
 */
export function isRequestRejection(error: unknown): boolean {
  const candidates: unknown[] = [error];

  const aggregated = (error as { errors?: unknown } | null)?.errors;
  if (Array.isArray(aggregated)) candidates.push(...aggregated);

  return candidates.some((candidate) => {
    const status = (candidate as { status?: unknown } | null)?.status;
    if (status === 400) return true;
    const message = (candidate as { message?: unknown } | null)?.message;
    return (
      typeof message === "string" && message.includes("signature does not match")
    );
  });
}

