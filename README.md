<div align="center">

<img src="assets/woodhouse-readme.jpeg" alt="Woodhouse" width="180">

# Woodhouse

**A personal butler for your GitHub repositories.**

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
before writing, so an unchanged repository costs no write calls.

**Silver Platter.** Pull requests from actors listed in
`autoApproval.allowedActors` get an approving review — unless they touch a
protected path, are drafts, or are too large to inspect.

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

Unknown keys are rejected. A misspelled `allowedActor` that silently did
nothing would be a security problem, not a cosmetic one — so pull requests that
touch a config file get a `woodhouse/config` check that validates the proposed
content against the schema.

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
| Contents | Read-only | reading `woodhouse.yml` |
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
| `APP_ID` | yes | |
| `PRIVATE_KEY` | yes | raw PEM or base64 of it |
| `WEBHOOK_SECRET` | yes | |
| `ALLOWED_INSTALLATION_TARGETS` | yes | JSON array or comma-separated. No wildcard; empty is a startup error |
| `BASELINE_REPO` | no | default `.github-private` |
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
short commit SHA plus a moving `latest`. **Pin the SHA** in a compose file;
`latest` exists for convenience during early testing.

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

The image tag is pinned to a commit SHA rather than `latest`, deliberately:
Portainer will not notice a moving tag has changed, and an unexpected restart
pulling a different build is not a surprise you want from a bot holding admin
scopes.

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

## Testing against real repositories

[`docs/test-plan.md`](docs/test-plan.md) walks through validating an
installation end to end, ordered so the reversible behaviour is proven before
settings sync is allowed to write anything.

## Development

```bash
npm test          # unit tests
npm run typecheck
npm run build
```

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
