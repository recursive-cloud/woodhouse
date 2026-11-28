/**
 * The app's own login, e.g. `woodhouse[bot]`.
 *
 * Resolved once per process: it cannot change while we are running, and
 * `GET /app` is a wasted request on every pull request otherwise. Routing,
 * approval and escalation share this one cache, so the single request serves
 * every pass.
 */

import type { Context } from "probot";

type Api = Context<"pull_request">["octokit"];

let cachedAppLogin: Promise<string> | undefined;

/** Drop the cached login so the next call performs `GET /app` again. */
export function resetAppLoginCache(): void {
  cachedAppLogin = undefined;
}

/**
 * Return the app login, starting the one `GET /app` on first use and reusing
 * the in-flight or settled promise afterwards. The return is deliberately not
 * `async`: callers await the shared promise rather than wrapping it.
 */
export function appLogin(octokit: Api): Promise<string> {
  cachedAppLogin ??= octokit.apps
    .getAuthenticated()
    .then((response) => `${(response.data as { slug: string }).slug}[bot]`)
    .catch((error: unknown) => {
      // Do not cache a failure; a transient error should not disable approvals
      // or routing for the lifetime of the process.
      cachedAppLogin = undefined;
      throw error;
    });
  return cachedAppLogin;
}
