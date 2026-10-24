# syntax=docker/dockerfile:1
#
# Listens on 0.0.0.0:3000; probe GET /v1/health. Every table lives in the Postgres database
# DATABASE_URL names — this container keeps nothing on disk, so it needs no volume.
#
# Starting the container migrates the database first (see CMD). That step lives here rather than
# in the service, so it is visible in the image and can be skipped by overriding the command —
# `docker run … node dist/main` starts without touching the schema.

ARG NODE_VERSION=22

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# nest-cli.json drives the build, selecting tsconfig.build.json. The migrations need no asset
# copying: they are TypeScript classes, so the ordinary compile emits them into dist.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/

RUN npm run build

# The admin UI is its own npm project (ui/), built after the server because `nest build` empties
# dist/ first. Vite writes it to dist/ui, which src/admin-ui.ts serves at /admin; nothing else
# about the UI reaches the runtime image.
COPY ui/package.json ui/package-lock.json ui/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix ui ci
COPY ui/ ui/
RUN npm --prefix ui run build

# Drop the dev dependencies from the tree the runtime stage inherits.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# The one-step install's setup service (deploy/compose.yml) writes the env files it generates into
# /config-wallet and /config-manager and keeps its own state in /state; the migrate service reads
# the older single volume at /legacy-config. Creating them here, owned by the service user, is what
# makes a fresh named volume mounted there writable: Docker seeds an empty volume with the image
# directory's ownership. /config is where the manager itself finds its env file.
RUN addgroup -S dpmm && adduser -S dpmm -G dpmm \
    && mkdir -p /config /config-wallet /config-manager /state /legacy-config \
    && chown dpmm:dpmm /config /config-wallet /config-manager /state /legacy-config \
    && chmod 700 /state

USER dpmm

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
# Migrate, then hand the process over to the service. `exec` matters: without it the shell stays
# as tini's child and the service never sees SIGTERM, which would cost the 25s drain on shutdown.
# `&&` matters too — a failed migration must stop the boot rather than start against a stale schema.
CMD ["sh", "-c", "node dist/db/migrate-cli && exec node dist/main"]
