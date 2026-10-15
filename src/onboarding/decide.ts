/**
 * The onboarding decision — pure, synchronous, and hermetic.
 *
 * Split from the API calls for the same reason as `approval/policy.ts` and
 * `gatekeeper/evaluate.ts`: every skip path is a plain fact about the input and
 * can be unit-tested without touching GitHub.
 *
 * Onboarding is repo-local consent. A repository that already carries any
 * settings file has deliberately configured itself (or is the baseline
 * repository, which always carries a root `woodhouse.yml`), and one with an
 * open onboarding pull request has already been offered. Only a repository with
 * neither is offered a pull request.
 *
 * The probe result is plain data assembled by the handler. The handler derives
 * `configPresent` from the four settings paths in `config/paths.ts` — the two
 * `.github/` locals and the two root-level baselines — so the set of paths that
 * counts as "already configured" is defined in exactly one place.
 */

/** One installed repository, as identified by the installation event. */
export interface OnboardingRepository {
  readonly owner: string;
  readonly name: string;
}

/**
 * What the handler learned by probing a repository before deciding.
 *
 * `openOnboardingPr` is deliberately tri-state, mirroring `ApprovalRequest`'s
 * `autoMergeEnabledBy`:
 *
 * - `false` — probed: no onboarding pull request is open.
 * - `true` — probed: one is open.
 * - `undefined` — not probed. The walk is cheap-first: an existing settings
 *   file decides the outcome, so the pull-request search is never made and the
 *   field is left unset. A missing probe *without* a settings file is treated
 *   as "cannot confirm no offer exists" and skipped rather than risk a
 *   duplicate branch, commit, or pull request.
 */
export interface OnboardingProbe {
  /** True when any of the four settings paths already exists in the repository. */
  readonly configPresent: boolean;
  readonly openOnboardingPr?: boolean;
}

/**
 * Why a repository was not offered onboarding. Machine-readable so the handler
 * can log the reason without matching on prose.
 */
export type OnboardingSkipReason =
  | "settings-file-present"
  | "onboarding-pull-request-open"
  | "pull-request-state-unprobed";

export type OnboardingDecision =
  | {
      readonly onboard: true;
      readonly repository: OnboardingRepository;
      readonly reason: "no-settings-file";
    }
  | {
      readonly onboard: false;
      readonly repository: OnboardingRepository;
      readonly reason: OnboardingSkipReason;
    };

/**
 * Decide whether to offer a repository the onboarding pull request.
 *
 * The order of the guards is the cheap-first short-circuit from the design: a
 * settings file ends the walk before the pull-request probe, so
 * `openOnboardingPr` is unprobed here and config-present skips regardless of
 * it.
 */
export function shouldOnboard(
  repository: OnboardingRepository,
  probe: OnboardingProbe,
): OnboardingDecision {
  if (probe.configPresent) {
    return { onboard: false, repository, reason: "settings-file-present" };
  }

  if (probe.openOnboardingPr === true) {
    return { onboard: false, repository, reason: "onboarding-pull-request-open" };
  }

  // Fail closed. With no settings file and no probe result the absence of an
  // open offer is unproven, and offering again could duplicate the branch, the
  // commit, or the pull request.
  if (probe.openOnboardingPr === undefined) {
    return { onboard: false, repository, reason: "pull-request-state-unprobed" };
  }

  return { onboard: true, repository, reason: "no-settings-file" };
}
