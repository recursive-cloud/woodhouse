/**
 * Cascading configuration resolver.
 *
 * Layer order (lowest precedence first):
 *   1. schema defaults
 *   2. `woodhouse.yml` in the owner's `.github` repository  (global baseline)
 *   3. `.github/woodhouse.yml` in the repository itself     (local override)
 *
 * The raw YAML of each layer is merged *before* validation. Validating each
 * layer independently would be wrong: zod would fill in defaults for the local
 * layer, and those defaults would then overwrite real values from the baseline.
 * Merge first, validate once.
 */

import yaml from "js-yaml";
import type { Logger } from "pino";
import { mergeLayers } from "./merge.js";
import {
  defaultConfig,
  parseConfig,
  type ValidationIssue,
  type WoodhouseConfig,
} from "./schema.js";
import { TtlCache } from "../lib/cache.js";

/**
 * Repository holding an owner's baseline config.
 *
 * `.github-private` rather than `.github`: the `.github` repository has to be
 * public for several built-in GitHub features (default community health files,
 * the public org profile) to apply to public repositories, and this config
 * contains the auto-approval actor list and branch protection rules. Those do
 * not belong in a repository you may be obliged to make public.
 *
 * `.github-private` is an existing GitHub convention for the member-only org
 * profile README, so it is a natural home for owner-scoped private config.
 * Override with the BASELINE_REPO environment variable.
 */
export const DEFAULT_BASELINE_REPO = ".github-private";
export const BASELINE_PATHS = ["woodhouse.yml", "woodhouse.yaml"] as const;
export const LOCAL_PATHS = [
  ".github/woodhouse.yml",
  ".github/woodhouse.yaml",
] as const;

/** Minimal shape of the Octokit client we need; keeps this unit-testable. */
export interface ContentsClient {
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<{ data: unknown }>;
  };
}

export interface ResolvedConfig {
  readonly config: WoodhouseConfig;
  /** Which layers actually contributed, for logging and debugging. */
  readonly sources: readonly string[];
  /** Non-fatal validation problems; config falls back to defaults on error. */
  readonly issues: readonly ValidationIssue[];
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404;
}

/**
 * Fetch and YAML-parse the first path that exists. Returns undefined when the
 * layer is absent, which is the normal case for most repositories.
 */
async function fetchLayer(
  client: ContentsClient,
  owner: string,
  repo: string,
  paths: readonly string[],
  ref: string | undefined,
  log: Logger,
): Promise<{ data: unknown; source: string } | undefined> {
  for (const path of paths) {
    try {
      const response = await client.repos.getContent(
        ref === undefined
          ? { owner, repo, path }
          : { owner, repo, path, ref },
      );

      const file = response.data as {
        type?: string;
        content?: string;
        encoding?: string;
      };

      if (file.type !== "file" || typeof file.content !== "string") {
        log.warn({ owner, repo, path }, "Config path is not a regular file");
        continue;
      }

      const text = Buffer.from(file.content, "base64").toString("utf8");
      const parsed = yaml.load(text, { filename: path });

      // An empty YAML document parses to undefined/null; treat as an empty
      // layer rather than an error.
      return {
        data: parsed ?? {},
        source: `${owner}/${repo}:${path}`,
      };
    } catch (error) {
      if (isNotFound(error)) continue;
      if (error instanceof yaml.YAMLException) {
        log.warn(
          { owner, repo, path, err: error.message },
          "Config file is not valid YAML; skipping layer",
        );
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

export interface ResolverOptions {
  /** Cache entry lifetime. Short by default; push events invalidate directly. */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Repository holding the owner-wide baseline. */
  readonly baselineRepo?: string;
}

export class ConfigResolver {
  private readonly cache: TtlCache<ResolvedConfig>;
  readonly baselineRepo: string;

  constructor(options: ResolverOptions = {}) {
    this.baselineRepo = options.baselineRepo ?? DEFAULT_BASELINE_REPO;
    this.cache = new TtlCache<ResolvedConfig>({
      ttlMs: options.ttlMs ?? 5 * 60_000,
      maxEntries: options.maxEntries ?? 500,
    });
  }

  /** True when a push to this repo changes the baseline for the whole owner. */
  isBaselineRepo(repo: string): boolean {
    return repo.toLowerCase() === this.baselineRepo.toLowerCase();
  }

  private static key(owner: string, repo: string, ref: string | undefined) {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref ?? "default"}`;
  }

  invalidate(owner: string, repo: string): void {
    this.cache.deleteByPrefix(`${owner.toLowerCase()}/${repo.toLowerCase()}@`);
  }

  /**
   * Drop every cached entry for an owner. Needed when the baseline in the
   * owner's `.github` repository changes, since that affects the resolved
   * config of every repository they own, not just `.github` itself.
   */
  invalidateOwner(owner: string): void {
    this.cache.deleteByPrefix(`${owner.toLowerCase()}/`);
  }

  async resolve(
    client: ContentsClient,
    owner: string,
    repo: string,
    log: Logger,
    ref?: string,
  ): Promise<ResolvedConfig> {
    const key = ConfigResolver.key(owner, repo, ref);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.load(client, owner, repo, log, ref);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async load(
    client: ContentsClient,
    owner: string,
    repo: string,
    log: Logger,
    ref: string | undefined,
  ): Promise<ResolvedConfig> {
    // Fetched in parallel: they are independent and this halves the latency
    // added to every event.
    const [baseline, local] = await Promise.all([
      // The baseline always comes from the default branch of the baseline
      // repository; pinning it to the current repo's ref would be meaningless.
      // Skipped entirely when the repo *is* the baseline, which would
      // otherwise merge the file into itself.
      this.isBaselineRepo(repo)
        ? Promise.resolve(undefined)
        : fetchLayer(
            client,
            owner,
            this.baselineRepo,
            BASELINE_PATHS,
            undefined,
            log,
          ),
      fetchLayer(client, owner, repo, LOCAL_PATHS, ref, log),
    ]);

    const sources: string[] = [];
    const layers: unknown[] = [];

    // `inherit: false` in the local config drops the baseline entirely.
    const inherits =
      (local?.data as { inherit?: unknown } | undefined)?.inherit !== false;

    if (baseline !== undefined && inherits) {
      layers.push(baseline.data);
      sources.push(baseline.source);
    }
    if (local !== undefined) {
      layers.push(local.data);
      sources.push(local.source);
    }

    const merged = mergeLayers(layers);
    const result = parseConfig(merged);

    if (!result.ok) {
      log.error(
        { owner, repo, sources, issues: result.issues },
        "Invalid woodhouse configuration; falling back to defaults",
      );
      return { config: defaultConfig(), sources, issues: result.issues };
    }

    log.debug({ owner, repo, sources }, "Resolved woodhouse configuration");
    return { config: result.config, sources, issues: [] };
  }
}
