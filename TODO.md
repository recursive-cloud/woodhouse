# TODO

Deferred work, roughly in the order it is worth doing.

## Housekeeping

- [ ] **License.** Add `LICENSE` (MIT).

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
