/**
 * The onboarding handler — installation events to onboarding pull requests.
 *
 * Thin glue between the guard and the pure decision. `src/app.ts` registers the
 * two action-scoped events design D1 names (`installation.created` and
 * `installation_repositories.added`) through `GuardedApp` and forwards here;
 * this module owns the per-repository walk from design D2 and nothing else.
 *
 * The walk is cheap-first and stateless. For each repository: probe the four
 * settings paths; if any exists, skip without ever searching for a pull request.
 * Only when no file exists is the open-offer search made, and only when that
 * comes back negative are the write facts resolved and the offer made. Nothing
 * is remembered between deliveries — idempotency comes entirely from what GitHub
 * currently shows, so a re-delivery and a closed-unmerged offer both do the
 * right thing without a mutex.
 *
 * Repositories are walked strictly sequentially, one awaited before the next.
 * Homelab installations are single digits; the settings applier's sequential
 * loop is the pacing precedent, and a burst of parallel writes on one
 * installation would be worse than the latency.
 *
 * Every failure is caught per repository: a 403 is logged with a hint naming
 * both sides of the permission surface (a read probe can be refused for want of
 * the installation's read permissions, an offer for want of `contents: write`
 * or `pull_requests: write`), any other error with its message, and the walk
 * continues to the next repository. A failed offer is not retried here — the
 * next installation event offers again, and the current state is re-probed then.
 *
 * An action that names no repositories is not silent: when the delivery is one
 * this handler acts on (`created`/`added`) but carries no repository list — the
 * shape of an install with repository selection "All" — the repositories
 * accessible to the installation are enumerated and walked like any other
 * batch. A failing enumeration is recorded as one operator-facing error, and
 * that delivery opens no offers.
 */

import { BASELINE_PATHS, LOCAL_PATHS } from "../config/paths.js";
import type { WoodhouseConfig } from "../config/schema.js";
import { messageOf, statusOf } from "../settings/forbidden.js";
import { shouldOnboard, type OnboardingProbe } from "./decide.js";
import {
  openOnboardingPullRequest,
  type OnboardingFacts,
  type OnboardingWriteDeps,
} from "./write.js";
import { ONBOARDING_BRANCH, ONBOARDING_LABEL } from "./wording.js";

/**
 * Everything the handler needs: the same client and dry-run context as the
 * write seam, plus the resolved configuration for a candidate repository.
 *
 * `resolveConfig` is a narrow injected function rather than the resolver itself
 * (design D2): the injection point is where "unresolvable" is defined, so the
 * decision layer never sees the resolver's fallback defaults. It resolves the
 * full cascade (defaults → owner baseline → local 404 — the handler only calls
 * it after `configPresent` said the repository has no local file) and returns
 * `undefined` when that configuration cannot be determined.
 */
export interface OnboardingDeps extends OnboardingWriteDeps {
  readonly resolveConfig: (owner: string, repo: string) => Promise<WoodhouseConfig | undefined>;
}

/**
 * The four paths that count as "already configured", in probe order: the two
 * local `.github/` paths, then the two root-level baseline-shaped paths (so a
 * baseline repository carrying a root `woodhouse.yml` is skipped too). Shared
 * with the resolver rather than re-hardcoded, so the set is defined once.
 */
const CONFIG_PATHS = [...LOCAL_PATHS, ...BASELINE_PATHS];

/**
 * The payload shapes this handler understands, structurally.
 *
 * Deliberately not Probot's `Context<"installation">` union: the handler is
 * registered for two events whose payloads differ — `installation.repositories`
 * for a fresh install, `repositories_added` for a repository addition — and a
 * small local shape keeps the two distinguishable without importing the whole
 * webhook type surface. Fields are optional because Probot hands over the raw
 * delivery and a malformed payload must simply produce no repositories.
 */
export interface OnboardingPayload {
  readonly action?: string;
  readonly installation?: {
    readonly repositories?: ReadonlyArray<{ readonly name?: unknown } | null> | null;
  } | null;
  readonly repositories_added?: ReadonlyArray<{ readonly name?: unknown } | null> | null;
}

/** 404 is the common answer for a settings path; anything else is a real error. */
function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

/**
 * The usable names in a raw repository list, per design D1.
 *
 * Entries that are null, carry no string `name`, or name the empty string are
 * dropped, so a malformed payload simply produces fewer (or no) repositories.
 * Shared by the payload path and the enumeration fallback so both filter
 * identically rather than drifting apart.
 */
function namesOf(
  raw: ReadonlyArray<{ readonly name?: unknown } | null> | null | undefined,
): string[] {
  if (raw === undefined || raw === null) return [];
  const names: string[] = [];
  for (const entry of raw) {
    const name = entry?.name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
}

/**
 * The repository names carried by the payload, per design D1.
 *
 * A fresh installation lists them under `installation.repositories`; a later
 * addition under `repositories_added`. Actions this handler does not care about
 * (`deleted`, `removed`, `suspend`, …) yield an empty list, so the walk is a
 * no-op rather than needing a second early return somewhere else.
 */
function repositoryNames(payload: OnboardingPayload): string[] {
  const raw =
    payload.action === "created"
      ? payload.installation?.repositories
      : payload.action === "added"
        ? payload.repositories_added
        : undefined;

  return namesOf(raw);
}

/**
 * Enumerate the repositories accessible to the installation (design D1).
 *
 * The fallback for a list-less acted-on delivery: an install with repository
 * selection "All" does not name its repositories in the webhook, so the walk's
 * batch comes from `GET /installation/repositories`. Probot's `context.octokit`
 * is already bound to the installation, so no auth plumbing is needed, and the
 * pagination plugin follows every page (`per_page: 100` is the maximum).
 *
 * Errors are deliberately not caught here: the caller's own catch makes the
 * enumeration failure a delivery-level outcome, which is a different thing from
 * a per-repository failure.
 */
async function listInstallationRepositories(deps: OnboardingDeps): Promise<string[]> {
  const repositories = await deps.octokit.paginate(
    deps.octokit.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );
  return namesOf(repositories);
}

/**
 * True when any of the four settings paths exists in the repository.
 *
 * One `repos.getContent` per candidate, stopping at the first success: a
 * successful response of any kind is treated as present, which fails toward
 * skipping the repository rather than offering it a pull request it does not
 * need. A 404 moves on; any other error propagates to the per-repository catch.
 */
async function configPresent(deps: OnboardingDeps, owner: string, repo: string): Promise<boolean> {
  for (const path of CONFIG_PATHS) {
    try {
      await deps.octokit.repos.getContent({ owner, repo, path });
      return true;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return false;
}

/**
 * True when an open onboarding pull request already exists.
 *
 * Searched by head branch (`woodhouse/onboarding`) plus the onboarding label —
 * the two idempotency keys from D2. A closed-unmerged offer leaves the branch
 * but no open pull request, so the search finds nothing and the offer is made
 * again from the existing branch.
 */
async function onboardingPullRequestOpen(
  deps: OnboardingDeps,
  owner: string,
  repo: string,
): Promise<boolean> {
  const response = await deps.octokit.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${ONBOARDING_BRANCH}`,
  });

  return response.data.some((pull) => pull.labels.some((label) => label.name === ONBOARDING_LABEL));
}

/**
 * Resolve the write facts from GitHub's *current* state, never cached.
 *
 * The default branch names the base; its head SHA is what a new onboarding
 * branch is created from; `branchExists` tells the seam whether to create the
 * branch or open from the one already there. An empty repository has no default
 * branch, so this throws and the per-repository catch records it: no offer.
 */
async function resolveFacts(
  deps: OnboardingDeps,
  owner: string,
  repo: string,
): Promise<OnboardingFacts> {
  const { data } = await deps.octokit.repos.get({ owner, repo });
  const defaultBranch = data.default_branch;

  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    throw new Error(`Repository ${owner}/${repo} has no default branch`);
  }

  const head = await deps.octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });

  let branchExists = false;
  try {
    await deps.octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${ONBOARDING_BRANCH}`,
    });
    branchExists = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  return { defaultBranch, defaultBranchSha: head.data.object.sha, branchExists };
}

/**
 * Walk one repository: probe, decide, and only then offer.
 *
 * When a settings file is present the configuration is never resolved and the
 * pull-request search is never made — `openOnboardingPr` is left unset and
 * `shouldOnboard` skips on config alone (cheap-first). When it is absent the
 * resolved cascade decides whether the owner baseline already manages the
 * repository; a managed repository skips before the pull-request search, so it
 * never pays for `pulls.list`. Only an unmanaged repository is searched, and
 * that boolean result is what lets `shouldOnboard` offer: omitting it would
 * fail closed.
 *
 * An unresolvable configuration is an operational failure, not a decision: it
 * throws here so the per-repository catch logs it and the walk continues with
 * no offer. Handing the decision layer fallback defaults would offer a pull
 * request on unknown management state.
 */
async function walkRepository(deps: OnboardingDeps, owner: string, repo: string): Promise<void> {
  const present = await configPresent(deps, owner, repo);

  let probe: OnboardingProbe;
  if (present) {
    probe = { configPresent: true };
  } else {
    const config = await deps.resolveConfig(owner, repo);
    if (config === undefined) {
      throw new Error(`Could not resolve woodhouse configuration for ${owner}/${repo}`);
    }

    const managed = config.settings.enabled === true;
    probe = managed
      ? { configPresent: false, managed: true }
      : {
          configPresent: false,
          managed: false,
          openOnboardingPr: await onboardingPullRequestOpen(deps, owner, repo),
        };
  }

  const decision = shouldOnboard({ owner, name: repo }, probe);

  if (!decision.onboard) {
    deps.log.debug({ owner, repo, reason: decision.reason }, "Onboarding skipped");
    return;
  }

  const facts = await resolveFacts(deps, owner, repo);
  const result = await openOnboardingPullRequest(deps, owner, repo, facts);

  deps.log.info(
    { owner, repo, pullRequestNumber: result.pullRequestNumber ?? null, dryRun: deps.dryRun },
    "Onboarding offer complete",
  );
}

/**
 * Handle an installation or installation_repositories delivery.
 *
 * The wiring is action-scoped, but the action gate stays here as defence in
 * depth: `repositoryNames` ignores any action other than `created`/`added`, so
 * a mis-wired or replayed delivery is still a no-op. Repositories are then
 * walked sequentially, each in its own try/catch so one failure neither aborts
 * the delivery nor hides the next repository's offer.
 */
export async function handleOnboarding(
  deps: OnboardingDeps,
  owner: string,
  payload: unknown,
): Promise<void> {
  // A malformed payload produces no repositories, per the module contract —
  // never a throw that has to be caught far away by the guard.
  if (typeof payload !== "object" || payload === null) return;

  // The raw delivery is narrowed to the two shapes we care about. This is the
  // one cast, and it only ever reads optional fields defensively.
  const event = payload as OnboardingPayload;

  let repositories = repositoryNames(event);

  if (repositories.length === 0) {
    // `repositoryNames` also yields [] for actions this handler ignores; only
    // an acted-on action with no list is an all-repositories delivery worth
    // enumerating: a fresh *All repositories* install carries no list, and a
    // switch to it is delivered as the enumerated `added` delta. When the
    // payload does carry a list it stays authoritative — enumeration is the
    // fallback, not a second source.
    if (event.action !== "created" && event.action !== "added") return;

    try {
      repositories = await listInstallationRepositories(deps);
    } catch (error) {
      // The enumeration precedes the per-repository walk, so its failure is the
      // delivery's failure: one operator-facing line, no offers, and a normal
      // return (this handler never throws outward).
      deps.log.error(
        { owner, action: event.action, err: error },
        `Could not enumerate the repositories accessible to the installation for ${owner}: ` +
          `${messageOf(error)}. No onboarding offers were made for this delivery.`,
      );
      return;
    }
  }

  for (const repo of repositories) {
    try {
      await walkRepository(deps, owner, repo);
    } catch (error) {
      if (statusOf(error) === 403) {
        // A 403 can come from either side of the walk: a read probe (the
        // installation lacks a read permission) or the write seam (it lacks
        // `contents: write` / `pull_requests: write`). The hint names both so
        // it is honest whichever one was refused.
        deps.log.error(
          { owner, repo, err: error },
          `Onboarding forbidden for ${owner}/${repo}; reads require the installation's ` +
            `read permissions and writes require "contents: write" and ` +
            `"pull_requests: write". ${messageOf(error)}`,
        );
      } else {
        deps.log.error(
          { owner, repo, err: error },
          `Onboarding failed for ${owner}/${repo}: ${messageOf(error)}`,
        );
      }
    }
  }
}
