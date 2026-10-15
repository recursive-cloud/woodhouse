<div align="center">

<img src="assets/woodhouse-readme.png" alt="Woodhouse" width="240">

# Woodhouse

**An open-source repository valet providing white-glove automated approvals and check consolidation.**

</div>

A self-hosted GitHub App that keeps repository settings consistent, approves
pull requests from trusted actors, and consolidates every CI check into a
single required status.

Built for a private homelab. It is not multi-tenant, and it refuses to run
without an explicit installation allowlist.

## What it does

**Installation lockdown.** Every webhook is checked against
`ALLOWED_INSTALLATION_TARGETS` before anything else happens — before a token is
minted, before any API call. Events from any other owner are logged and
dropped. Handlers are registered through a guard wrapper rather than on the
Probot instance directly, so a new listener cannot accidentally skip the check.

**Cascading settings sync.** On a push to the default branch, Woodhouse merges
`woodhouse.yml` from your owner-level `.github-private` repository with
`.github/woodhouse.yml` from the repository itself, and reconciles repository
options, topics, labels, branch protection and rulesets. Settings are diffed
before writing, so an unchanged repository costs no write calls. Merging a pull
request that changes a settings file into the default branch triggers the same
sync, and Woodhouse comments on that pull request with the outcome: what was
applied in each area, any failures with their reason, or that nothing further
needed changing. A merge on the baseline repository says so truthfully — the
baseline was synced directly, and other repositories adopt the change at their
next event — and a repository with settings disabled stays silent. Re-delivering
the event updates the comment in place rather than duplicating it. Both triggers
serialise per repository, so a merge push and the closed event cannot apply the
same change twice.

**Silver Platter.** PR authors listed under `autoApproval.allowedActors.owners`
get an approving review without any extra preconditions — still vetoed by
protected paths, drafts, and pull requests too large to inspect. Authors under
`...bots` are approved only when that same bot enabled auto-merge on the pull
request itself; Woodhouse reads the live pull request at decision time, because
the webhook payload's snapshot is stale. `allowedActors` was once a flat list:
it is not carried forward, the legacy shape is rejected as invalid
configuration, and existing configs are migrated by hand.

**The white glove check.** A single check run, `woodhouse/white-glove`, that
aggregates every other check on the commit. Make it your only required status
and stop maintaining a list of required contexts in branch protection.

| Situation | `woodhouse/white-glove` |
| --- | --- |
| All checks succeeded | success |
| Any check failed, timed out, cancelled | failure |
| Any check still running | pending |
| A check was skipped or neutral | ignored |
| A `strictChecks` entry was skipped or neutral | failure |
| A `strictChecks` entry never reported at all | pending |
| An unrecognised conclusion | failure (fails closed) |

Failure beats pending, and pending beats success.

## Configuration

See [`woodhouse.example.yml`](./woodhouse.example.yml) for a fully commented
baseline. Local settings override the inherited baseline; objects merge, and
arrays are **replaced** rather than concatenated so a repository can narrow an
inherited list, not just extend it.

| Layer | Location |
| --- | --- |
| Baseline (owner-wide) | `woodhouse.yml` in the owner's `.github-private` repo |
| Local (per repository) | `.github/woodhouse.yml` |

The baseline lives in `.github-private`, not `.github`, because `.github` has
to be **public** for GitHub's community-health and org-profile features to
apply to public repositories — and this config lists who may auto-approve pull
requests. Set `BASELINE_REPO` to override the location.

Both the baseline repo and the repositories being managed must be included in
the App installation, or Woodhouse cannot read them.

> **Private repositories on the Free plan** can use neither `branchProtection`
> nor `rulesets` — both require the repository to be public, or a paid plan
> (Pro, Team or Enterprise) if it is private. Everything else (repository
> options, topics, labels, the white-glove check and auto-approval) works
> regardless. Woodhouse says so explicitly when the API refuses, rather than
> logging a bare 403.

Unknown keys are rejected. A misspelled `allowedActor` that silently did
nothing would be a security problem, not a cosmetic one — so pull requests that
touch a config file get a `woodhouse/config` check that validates the proposed
content, and a comment spelling out what is wrong. The comment is edited in
place as you push fixes, and removed once the file validates.

### Editor validation

Catch mistakes before pushing by adding this to the top of the file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/recursive-cloud/woodhouse/main/schema/woodhouse.schema.json
```

That works in VS Code (with the YAML extension), Neovim and anything else
speaking the YAML language server protocol. The schema is generated from the
same zod definitions the bot validates with, and CI fails if the two drift, so
your editor and the bot cannot disagree.

### Deliberate omissions

`repository.private` and `repository.archived` are not configurable. Going
private permanently deletes every fork, and archiving would lock the app out of
the very config that controls it. Neither is a reasonable outcome of a typo in
a file that cascades across every repository you own.

## GitHub App setup

Create an App at `https://github.com/settings/apps/new` with:

**Permissions**

| Scope | Access | Needed for |
| --- | --- | --- |
| Administration | Read & write | repository settings, branch protection, rulesets |
| Checks | Read & write | the white-glove and config checks |
| Contents | Read & write | reading `woodhouse.yml`; also required for approvals to satisfy branch protection and for auto-merge |
| Issues | Read & write | label sync |
| Pull requests | Read & write | auto-approval |
| Metadata | Read-only | mandatory |

**Webhook events:** Check run, Check suite, Pull request, Push.

Then set the webhook URL to your Cloudflare Tunnel hostname with the path
`/api/github/webhooks`.

**Logo.** Upload [`assets/woodhouse.jpeg`](assets/woodhouse.jpeg) under the
App's *Display information*. It is 1024×1024 and 704 KB, within GitHub's
square/1 MB limit.

The App slug can be anything; Woodhouse resolves its own bot login at runtime
via `GET /app` and caches it, so the "have I already approved this commit?"
check keeps working whatever you name it.

## Serving several GitHub Apps

Woodhouse is a **private** App: rather than one public installation anyone can
add, each user or organisation registers their own. One container can serve
any number of them.

Probot is used as a library rather than through its `run()` helper. Express
owns the HTTP surface, and each delivery is routed to the right App using the
`X-GitHub-Hook-Installation-Target-ID` header before its signature is checked
— necessarily, since every App has its own webhook secret.

That header is unauthenticated, which is fine: it only selects *which* secret
to try, and the HMAC check still has to pass with it. A forged value simply
picks a key the sender cannot produce a valid signature for.

Apps are described by [`config/apps.cjs`](config/apps.cjs), which exports a
function of the environment. It is code rather than data so you can map
whatever variable names your secret tooling already produces:

```js
module.exports = function (env) {
  return {
    [env.ORG_A_APP_ID]: {
      appId: parseInt(env.ORG_A_APP_ID, 10),
      privateKey: env.ORG_A_PRIVATE_KEY,
      webhookSecret: env.ORG_A_WEBHOOK_SECRET,
      allowedInstallationTargets: ["org-a"],
    },
    [env.ORG_B_APP_ID]: {
      appId: parseInt(env.ORG_B_APP_ID, 10),
      privateKey: env.ORG_B_PRIVATE_KEY,
      webhookSecret: env.ORG_B_WEBHOOK_SECRET,
      allowedInstallationTargets: ["org-b"],
    },
  };
};
```

The map key must be the App ID, since that is what deliveries are matched on;
a mismatch is a startup error rather than a silently dropped webhook. Each App
may also set `baselineRepo` and `label`.

### The allowlist

Each App must end up with an allowlist, from one of two places:

| Source | Applies to |
| --- | --- |
| `allowedInstallationTargets` on an App | that App only; takes precedence |
| `ALLOWED_INSTALLATION_TARGETS` | default for Apps that do not set their own |

**Setting it per App means the environment variable is not needed at all.**
Setting it in neither is a startup error.

Per-App is worth preferring when serving more than one tenant, since it
confines each App to its own owners: a delivery for org A that reaches org B's
App is dropped.

For a private App the allowlist is belt and braces — only the owning account
can install it, so it should never actually reject anything. It earns its keep
if an App is made public or installed at the Enterprise level, where one App
can span many organisations, and as a guard against pointing the wrong
credentials at the wrong tenant.

The shipped default is the single-App case and needs no editing — set
`APP_ID`, `PRIVATE_KEY` and `WEBHOOK_SECRET` and it works. Mount your own file
over it and set `APPS_CONFIG_PATH` to serve several.

## Running it

```bash
cp .env.example .env    # fill in APP_ID, PRIVATE_KEY, WEBHOOK_SECRET
npm install
npm run dev
```

Set `DRY_RUN=true` for the first run against real repositories: every decision
is evaluated and logged, but nothing is written back to GitHub.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_ID` | yes* | read by the default config file |
| `PRIVATE_KEY` | yes* | raw PEM or base64 of it |
| `WEBHOOK_SECRET` | yes* | |
| `ALLOWED_INSTALLATION_TARGETS` | yes† | JSON array or comma-separated. No wildcard |
| `APPS_CONFIG_PATH` | no | default `config/apps.cjs` |
| `BASELINE_REPO` | no | default `.github-private` |

\* Only for the shipped single-App config. A custom `apps.cjs` may read any
variable names it likes.
&nbsp;† Optional if every App defines its own `allowedInstallationTargets`. An
App that ends up with neither is a startup error — there is no way to run
without a boundary.
| `PORT` | no | default 3000 |
| `LOG_LEVEL` | no | default `info` |
| `DRY_RUN` | no | default `false` |

### Docker

```bash
docker build -t woodhouse:latest .
```

Multi-stage, ending on distroless — no shell, no package manager, non-root.

CI publishes multi-arch (`linux/amd64`, `linux/arm64`) images to
`ghcr.io/recursive-cloud/woodhouse` on every push to `main`, tagged with the
short commit SHA plus a moving `latest`. Compose and the kustomization pin the
**release version** instead — release-please bumps both automatically on every
release (see [Releases](#releases)); `latest` exists for convenience during
early testing.

The package is **private** by default, so a pull will fail with `denied` until
you either:

- make it public — GHCR package → *Package settings* → *Change visibility*; or
- authenticate the host, using a PAT with `read:packages`:

  ```bash
  echo "$GHCR_PAT" | docker login ghcr.io -u YOUR_USERNAME --password-stdin
  ```

  In Portainer this is a registry entry under *Registries* → *Custom registry*.

### Docker Compose

[`docker-compose.yml`](./docker-compose.yml) is ready for Portainer. Copy
`.env.example` to `.env`, fill it in, and:

```bash
docker compose up -d
```

Nothing is published to the host — cloudflared reaches the container over the
shared Docker network. Point the tunnel's public hostname at
`http://woodhouse:3000` and set the App's webhook URL to
`https://<hostname>/api/github/webhooks`.

The image tag is pinned to the release version rather than `latest`,
deliberately: Portainer will not notice a moving tag has changed, and an
unexpected restart pulling a different build is not a surprise you want from a
bot holding admin scopes. release-please bumps the pin on every release (see
[Releases](#releases)).

### Kubernetes

```bash
kubectl apply -f k8s/namespace.yaml

kubectl create secret generic woodhouse -n woodhouse \
  --from-literal=APP_ID=123456 \
  --from-literal=WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  --from-file=PRIVATE_KEY=./woodhouse.private-key.pem

kubectl apply -k k8s/
```

The Deployment is single-replica with `strategy: Recreate`, not
RollingUpdate. Woodhouse serialises work per commit with an in-process lock, so
two pods running simultaneously could both decide no white-glove check exists
and create duplicates. Running more than one replica requires moving that lock
to Redis first.

There is no Ingress: the Service is ClusterIP and cloudflared connects to it
from inside the cluster.

## Releases

Releases are cut by
[release-please](https://github.com/googleapis/release-please) from the
conventional-commit titles of squash-merged pull requests.

release-please maintains a running release pull request on `main`, titled
`chore(main): release X.Y.Z`, that accumulates changelog entries as those pull
requests merge. Merging it cuts the tag, publishes the GitHub release, opens
the next release pull request, and bumps both deployment pins — the annotated
`# x-release-please-version` lines in
[`docker-compose.yml`](./docker-compose.yml) and
[`k8s/kustomization.yaml`](./k8s/kustomization.yaml). ([`release.yml`](.github/workflows/release.yml)
wires this up; [`ci.yml`](.github/workflows/ci.yml) is untouched.)

On a release cut, a job in the release workflow re-tags the already-built
short-SHA image with `vX.Y.Z` and the floating `vX` via
`docker buildx imagetools` — no rebuild, so the version tags carry the exact
digest of the push build that CI tested. The raw `latest` tag keeps following
`main`; releases never re-point it.

### Release runbook

- **Merging the release pull request** cuts the release: tag, GitHub release,
  `vX.Y.Z` and `vX` image tags, and the two deployment pins all move in the
  release commit.
- **Prerequisite:** Settings → Actions → General must have *Allow GitHub
  Actions to create and approve pull requests* enabled, or the release pull
  request cannot be opened.
- **The release pull request runs no CI checks of its own.** Pull requests
  created with the default `GITHUB_TOKEN` do not trigger workflows. Accepted:
  the release pull request's content is generated from commits that already
  passed CI on their own pull requests.
- **The re-tag job waits for the image build.** It starts in the same workflow
  run as the release merge, before `ci.yml`'s image push has finished, so it
  polls for the short-SHA image to appear — up to 20 minutes — and then re-tags
  it; the normal path completes hands-off. On timeout (e.g. a further push to
  `main` cancelled the release merge's CI build via `cancel-in-progress`, or
  the build failed), re-run CI's image job first, then the re-tag job; the
  re-tag is idempotent.
- **Manual-bump fallback.** If an extra-files update ever misses the pin lines,
  bump the two annotated lines by hand in a normal pull request. That is the
  whole fallback — the pins still reference a released version, they are just
  moved without release-please's help that once.

## Testing against real repositories

[`docs/test-plan.md`](docs/test-plan.md) walks through validating an
installation end to end, ordered so the reversible behaviour is proven before
settings sync is allowed to write anything.

## Development

[mise](https://mise.jdx.dev) pins the toolchain and exposes the common tasks:

```bash
mise install      # Node, hk, pkl, then npm ci and the git hooks
mise run ci       # lint, typecheck, test, build - exactly what CI runs
mise run fix      # apply formatting and lint fixes
```

Without mise, the npm scripts work directly:

```bash
npm test          # unit tests
npm run typecheck
npm run lint      # oxlint
npm run format    # oxfmt --check
npm run build
```

### Pre-commit

`mise install` sets up a [hk](https://hk.jdx.dev) pre-commit hook that runs
oxfmt and oxlint over staged files, fixing what it can. Unstaged work is
stashed for the duration, so a partially staged file is checked as staged
rather than picking up changes that were not meant for the commit.

The hook deliberately does **not** run the test suite or the type checker.
Both are enforced in CI on the pull request, and a hook slow enough to notice
is one that gets bypassed with `--no-verify`. Slower checks added later belong
in `pre-push`.

`HK=0 git commit` skips it when you genuinely need to.

The interesting logic is deliberately pure and separated from the API calls:
`gatekeeper/evaluate.ts`, `settings/plan.ts` and `approval/policy.ts` are all
plain functions over plain data, and hold the bulk of the test suite.

## Operational notes

- Log output is single-line JSON on stdout, with secrets redacted.
- `/healthz` is the only non-webhook route. There is no landing page or setup
  wizard; Probot's `run()` helper is not used.
- Rejected webhooks return 200. An event from an unapproved owner is not an
  error on our side, and failing the delivery would produce noise for something
  we are choosing to ignore.
- Handler errors are rethrown so the delivery is marked failed in GitHub's UI
  and can be redelivered from the App's Advanced tab.

## Legal & Disclaimer

**Woodhouse** is an independent, community-driven open-source project. 

This software is not affiliated, associated, authorized, endorsed by, or in any way officially connected with FX Network, Floyd County Productions, the creators of the television show *Archer*, or any of their subsidiaries or affiliates. All product and company names, trademarks, and registered trademarks used in this project belong to their respective holders; their use here does not imply any affiliation with or endorsement by them.
