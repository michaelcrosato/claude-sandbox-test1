# Posthorn — single-container, no-Redis webhook delivery gateway.
#
# This image is the headline deployment artifact of the wedge: one process, one
# image, durable state in an embedded SQLite file (no Postgres, no Redis, no
# external services). Posthorn has **zero runtime dependencies** — every moving
# part is a Node built-in (`node:http`, `node:sqlite`, `node:crypto`) — so the
# runtime stage carries only the compiled `dist/` and a Node binary; there is no
# `node_modules/` to ship, audit, or patch.
#
# Build:  docker build -t posthorn .
# Run:    docker run -p 3000:3000 -v posthorn-data:/data posthorn
# Admin:  docker run --rm -v posthorn-data:/data posthorn admin create-app "My App"
#         docker run --rm -v posthorn-data:/data posthorn admin create-key <appId>

# ---------------------------------------------------------------------------
# Stage 1 — builder: install the toolchain and compile TypeScript -> dist/.
# Pinned to Node 24 (matches the dev/test runtime; `node:sqlite` is a stable
# built-in there) on Alpine for a small footprint.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies from the lockfile first so this layer caches across
# source-only changes. devDependencies (TypeScript) are required to build.
COPY package.json package-lock.json ./
RUN npm ci

# Compile. tsconfig emits ESM into ./dist. Then strip the test/spec output that
# tsc also produces from `src/**/*.test.ts` — it is never on the runtime graph
# (only the test runner imports `vitest`), so it has no business in the image.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && find dist -name '*.test.js' -delete \
  && find dist -name '*.test.d.ts' -delete \
  && find dist -name '*.test.js.map' -delete

# ---------------------------------------------------------------------------
# Stage 2 — runtime: just Node + the compiled output. No npm install, no
# node_modules, no build toolchain.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# OCI image metadata (https://github.com/opencontainers/image-spec). VERSION is
# supplied at build time — CI passes the package.json version; it defaults to
# "dev" for a bare `docker build`.
ARG POSTHORN_VERSION=dev
LABEL org.opencontainers.image.title="Posthorn" \
      org.opencontainers.image.description="Standard Webhooks-compliant reliable outbound webhook delivery — single container, embedded SQLite, no Redis." \
      org.opencontainers.image.source="https://github.com/michaelcrosato/claude-sandbox-test1" \
      org.opencontainers.image.documentation="https://github.com/michaelcrosato/claude-sandbox-test1#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Michael Crosato" \
      org.opencontainers.image.version="${POSTHORN_VERSION}"

ENV NODE_ENV=production \
    POSTHORN_HOST=0.0.0.0 \
    POSTHORN_PORT=3000 \
    POSTHORN_DATA_DIR=/data

WORKDIR /app

# `package.json` carries `"type": "module"`, which Node needs so it loads the
# compiled `dist/*.js` as ESM. The compiled output is the only other payload.
COPY package.json ./
COPY --from=builder /app/dist ./dist

# Durable SQLite files live under /data; make it writable by the unprivileged
# `node` user (uid 1000, shipped in the base image) before dropping privilege.
# Declaring it a VOLUME captures this node-owned baseline for anonymous volumes.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node

EXPOSE 3000

# Liveness via the unauthenticated /healthz route, using Node's built-in fetch —
# no curl/wget dependency, consistent with the zero-dependency posture.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.POSTHORN_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: `node` is PID 1 and receives SIGTERM/SIGINT directly, which main.js
# translates into a graceful drain-and-stop. With no args the gateway boots; with
# `admin <command>` it runs a one-shot provisioning command and exits.
ENTRYPOINT ["node", "dist/main.js"]
