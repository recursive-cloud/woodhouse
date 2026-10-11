/**
 * Settings-file paths — the single definition.
 *
 * Config-domain knowledge (no GitHub/octokit), so it lives in `config/` with
 * the resolver and schema. Every consumer that needs to answer "is this a
 * settings file?" — the push trigger in `app.ts`, `config/resolver.ts` when
 * fetching layers, and PR-time validation in `settings/validate.ts` — shares
 * this list rather than re-deriving it.
 */

/** Paths to the owner-wide baseline config, relative to the baseline repo. */
export const BASELINE_PATHS = ["woodhouse.yml", "woodhouse.yaml"] as const;

/** Paths to a repository's local override, relative to the repository root. */
export const LOCAL_PATHS = [".github/woodhouse.yml", ".github/woodhouse.yaml"] as const;

/** Every path this app reads as configuration. */
const SETTINGS_PATHS = new Set<string>([...LOCAL_PATHS, ...BASELINE_PATHS]);

/**
 * True when `path` is exactly one of the four settings-file paths.
 *
 * Exact match on purpose: a file that merely ends in `woodhouse.yml`, such as
 * `docs/woodhouse.yml`, is not configuration and must not be treated as such.
 */
export function isSettingsPath(path: string): boolean {
  return SETTINGS_PATHS.has(path);
}
