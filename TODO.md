# TODO

Deferred work, roughly in the order it is worth doing.

## Housekeeping

- [x] **License.** Add `LICENSE` (MIT).

## Configuration authoring

- [ ] **Upgrade zod to v4.** Needed for native JSON Schema generation
      (`z.toJSONSchema()`). v4 is a breaking change: `.strict()` becomes
      `z.strictObject()`, `.passthrough()` becomes `z.looseObject()`, and the
      `ZodError.issues` shape moves slightly — `src/config/schema.ts` and the
      `parseConfig` issue mapping both need revisiting.

- [ ] **Publish a JSON Schema for `woodhouse.yml`.** Generate it from the zod
      schema at build time so the two cannot drift, commit it to the repo, and
      document the `yaml.schemas` setting (or a `# yaml-language-server:
      $schema=` modeline) so editors validate before anything is pushed.
      Depends on the zod v4 upgrade.

- [ ] **Comment on pull requests with invalid configuration.** The
      `woodhouse/config` check already validates and fails
      (`src/settings/validate.ts`), which is enough to block a merge once it is
      a required check. Still missing: an actual PR comment carrying the
      validation errors, so the problem is visible without opening the Checks
      tab. Should upsert a single comment rather than adding one per push.

## Findings from the first round of real testing

- [x] **Re-approve on `synchronize`** — done.
- [x] **Handle `pull_request.ready_for_review`** — done.
- [x] **False green when a PR has no checks yet** — done, via a grace period.
      See `gatekeeper.gracePeriodSeconds`.

- [x] **Branch protection and rulesets on private Free repositories** — these
      require the repository to be public, or a paid plan if private. *Neither*
      mechanism is available on Free with a private repo. Now reported with an
      explanation instead of a bare 403; see `describeForbidden`.

## Before 1.0

- [ ] **Distinguish owners from "the help" in auto-approval.** Split
      `autoApproval.allowedActors` so human owners and everything else (bots,
      service accounts) are recognised separately, and tailor the review
      comment accordingly. For an owner, something in the register of "let me
      get that for you, sir". For a bot, still addressed to the owner rather
      than the bot: "sir, just letting you know I am letting the handyman in to
      fix a few things".

      Needs a decision on the config shape — most likely `allowedActors.owners`
      and `allowedActors.staff`, with the current flat array still accepted so
      existing configs keep working. Further customisation of the wording is a
      post-1.0 stretch goal.

## Onboarding pull request

- [ ] **Open an onboarding PR when the App is installed on a repository.**
      Acts as the gate before Woodhouse becomes active: the PR adds
      `.github/woodhouse.yml` (and optionally the always-on workflow above),
      is validated by the config check like any other change, and merging it
      is what switches management on. Renovate's onboarding PR is the model.
      Depends on releases being in place.

## Developer experience

- [ ] **mise for local tooling.** Pin the Node version and expose the common
      tasks (`test`, `lint`, `fmt`, `build`, `dev`) so they are identical
      locally and in CI.

- [ ] **oxfmt + oxlint.** Formatting and linting, wired into pre-commit via
      [hk](https://hk.jdx.dev/) against staged files only. Deliberately do not
      gate the commit on the test suite — tests belong in CI on the PR, and a
      slow pre-commit hook is a hook people start bypassing with `--no-verify`.

- [ ] **Add lint to CI** once oxlint is configured, as a separate job from the
      test suite.

## Releases

- [ ] **release-please** for version bumps and changelog generation.

- [ ] **Enforce conventional commit PR titles** with an action, since
      release-please derives the changelog from them. Note the existing commit
      history does *not* follow conventional commits, so either start from the
      next commit or accept a gap in the first generated changelog.

- [ ] **Tag images with the release version** in addition to the commit SHA,
      and switch the compose deployment to a version tag once releases exist.

## Multi-App operation

- [ ] **Consider deriving the allowlist from actual installations.** For a
      private App, `GET /app/installations` is authoritative about which
      accounts can send events, which would remove the allowlist from
      configuration entirely for the common case. Rejected for now because it
      would silently widen the boundary if an App were ever made public, and
      installations change at runtime. Revisit only if configuring it proves
      genuinely annoying.

- [ ] **Per-App health and metrics.** `/healthz` reports the number of Apps
      served but says nothing about whether each is authenticating
      successfully. A bad private key is currently only visible as failing
      deliveries.

## Accepted tradeoffs

Recorded so they are not rediscovered as bugs. Revisit only if the premise
changes.

- **Grace period timers do not survive a restart.** A restart during the grace
  window on a pull request with no CI leaves the white-glove check
  `in_progress` until the next push or manual re-run. Acceptable while this is
  a single replica; the fix arrives naturally with the datastore that HA would
  require anyway, which would also make the feature more robust.

- **App configuration is read once at boot.** Adding or changing a tenant means
  restarting the container. Configuration changes are not expected to be
  frequent after setup.

## Deferred / revisit

- [ ] **Image signing and provenance.** `provenance: false` is set in CI to
      keep the GHCR package listing clean. Worth revisiting together with
      cosign signing and SBOM generation.

- [ ] **`docker/*` actions still target Node 20.** CI logs a deprecation
      warning for `setup-qemu-action`, `setup-buildx-action`, `login-action`,
      `metadata-action` and `build-push-action`. These are already the latest
      released majors, so this is upstream — recheck periodically.

- [ ] **Shared state for multi-replica operation.** Work is serialised per
      commit with an in-process lock (`src/lib/mutex.ts`), and the config cache
      is in-process too. Both would need to move to Redis before running more
      than one replica. Not needed while the deployment is a singleton.
