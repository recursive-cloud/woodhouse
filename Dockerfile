# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1 — install the full dependency tree (including dev) for the build.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Copied separately from the source so this layer is only rebuilt when the
# dependency set actually changes.
COPY package.json package-lock.json ./

# `npm ci` for a reproducible install straight from the lockfile.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund


# -----------------------------------------------------------------------------
# Stage 2 — compile TypeScript.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm run build


# -----------------------------------------------------------------------------
# Stage 3 — production dependencies only.
#
# Resolved in a separate stage rather than by pruning stage 1, so no dev
# package is ever present in a layer that reaches the final image.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund


# -----------------------------------------------------------------------------
# Stage 4 — runtime.
#
# Distroless: no shell, no package manager, no busybox. If the app is ever
# compromised there is nothing in the image to pivot with. It also means no
# HEALTHCHECK instruction is possible (there is no curl to run) — Kubernetes
# probes handle that instead, which is where it belongs for this deployment.
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build     --chown=nonroot:nonroot /app/dist         ./dist
COPY --chown=nonroot:nonroot package.json ./

# uid 65532, baked into the distroless nonroot variant.
USER nonroot

EXPOSE 3000

# The distroless entrypoint is already `node`, so only the script is given.
CMD ["dist/server.js"]
