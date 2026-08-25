# syntax=docker/dockerfile:1
#
# Single image an operator runs inside their own infrastructure. Listens on 0.0.0.0:3000;
# probe GET /health.

ARG NODE_VERSION=24

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/

RUN npm run build

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

RUN addgroup -S dpm-wallet-manager && adduser -S dpm-wallet-manager -G dpm-wallet-manager

USER dpm-wallet-manager

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
