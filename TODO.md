# TODO

Deferred work, roughly in the order it is worth doing.

## Where things stand

All three feature areas are implemented and have been exercised against real
repositories: installation lockdown, cascading settings sync, the white-glove
consolidated check, auto-approval, and config validation. Two GitHub Apps run
in one container. CI builds and publishes a multi-arch image per commit.

Tooling is in place: mise pins the toolchain, hk runs oxfmt and oxlint at
pre-commit, and a JSON Schema is generated from the zod definitions.

The obvious next chunk is **Releases** — release-please, conventional commit
enforcement, and version-tagged images. Conventional commits begin at
`0755843`; everything before that is prose, so the first generated changelog
will have a gap.

Worth knowing before picking this up:

- Commit `34a57ed` does not satisfy the lint gate it introduces, because the
  fixes land in `85cb24a`. Only the tip is pushed, so CI never saw it red, but
  `mise run ci` at that commit will fail. Every other commit is green in
  isolation.
- `hk install --mise` is required rather than plain `hk install`, since hk is
  mise-managed and is otherwise not on `PATH` inside the hook.

## Housekeeping

- [x] **License.** Add `LICENSE` (MIT).

## Configuration authoring

- [x] **Upgrade zod to v4** — done. `.strict()` and `.passthrough()` turned out
      to still work; the actual breaks were `z.record` needing an explicit key
      type, and `.default({})` on a section now meaning the *output* value, for
      which `.prefault({})` is the replacement.

- [x] **Publish a JSON Schema for `woodhouse.yml`** — done. Generated from the
      zod definitions into `schema/woodhouse.schema.json`, with a CI check that
      fails if it drifts, and a test asserting the schema and the runtime
      validator accept and reject the same documents.

- [x] **Comment on pull requests with invalid configuration** — done. A single
      comment, edited in place on each push and deleted once the file
      validates.

- [ ] **Add descriptions to the JSON Schema.** The generated schema currently
      has 79 nodes and zero `description` fields, so editors offer completion
      and validation but no hover documentation. The explanatory comments in
      `src/config/schema.ts` are TSDoc and do not carry through; zod needs
      `.describe()` (or `.meta({ description })` in v4) on each field for them
      to reach the schema.

      Worth doing as a single pass over `schema.ts`, since the prose largely
      exists already and only needs moving. Consider also `.meta({ examples })`
      for the fiddlier fields — `strictChecks`, `protectedPaths`, `rulesets` —
      and marking anything deprecated as the config shape evolves, for instance
      when `allowedActors` gains the owners/staff split.

      Check whether `z.toJSONSchema` emits `title` from `.meta()` too, and
      whether descriptions survive the `prefault` wrappers on each section.

- [ ] **Offer the schema modeline on new config files.** The validation comment
      suggests the `# yaml-language-server:` line, but nothing adds it. Best
      handled by the onboarding PR, which is writing the file anyway.

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

- [x] **mise for local tooling** — done. `mise.toml` pins Node, hk and pkl, and
      exposes `install`, `lint`, `fix`, `test`, `typecheck`, `build` and `ci`.

- [x] **oxfmt + oxlint via hk pre-commit** — done, staged files only, with the
      test suite and type checker deliberately left to CI.

- [x] **Add lint to CI** — done, as its own job that the image build also
      depends on.

- [ ] **Re-enable Markdown formatting when oxfmt stabilises.** Markdown is in
      `.oxfmtrc.json`'s ignore list because oxfmt 0.67 does not converge on a
      list item containing a second paragraph: it re-indents the continuation
      lines on every run, so `check` fails immediately after `fix` and the hook
      would rewrite docs on alternate commits. Worth retrying at 1.0, and worth
      reporting upstream.

- [ ] **Consider `hk install --global`.** hk recommends installing once into
      `~/.gitconfig`, where it no-ops in repositories without an `hk.pkl`. This
      repo uses a per-repo install so nothing outside it was touched. A global
      install belongs in dotfiles rather than here, but if it is adopted, the
      per-repo install becomes redundant and hk will skip it automatically.

- [ ] **Slower linters on pre-push.** `hk init` detected actionlint, hadolint,
      zizmor and dclint as applicable here. All are useful and none are fast
      enough for pre-commit; `pre-push` is the right home, with CI as backstop.

- [ ] **Revisit the oxlint categories.** `correctness`, `suspicious` and `perf`
      are enabled. `pedantic` produced 127 findings and was not adopted; it may
      be worth working through selectively. `no-await-in-loop` is off because
      the sequential API calls in `settings/apply.ts` are deliberate — they
      pace writes against rate limits and keep ruleset application last.

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
