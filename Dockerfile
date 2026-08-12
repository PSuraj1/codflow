# =============================================================================
# CODkar — production image
#
# Debian slim rather than Alpine on purpose: Prisma 6 ships prebuilt query
# engines against glibc/OpenSSL 3. On Alpine (musl) you must pin
# binaryTargets = ["linux-musl-openssl-3.0.x"] and the engine download is a
# frequent source of "Query engine library not found" at container start.
# The extra ~40MB buys a build that works the first time.
#
#   docker build -t codflow .
#   docker run --env-file .env -p 3000:3000 codflow
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — install every dependency, including dev, for the build.
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# Prisma's engine downloader needs CA certificates; openssl is the engine's
# runtime dependency.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only manifests first so this layer caches until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/

# No `--allow-scripts`: npm 11 rejects the flag outright in a project-scoped
# install ("not allowed in project-scoped installs"), which failed the build
# rather than skipping a script. It is not needed either — Prisma's postinstall
# only fetches the query engine, and the build stage below runs
# `prisma generate` explicitly, which fetches it anyway. CI installs the same
# way, so the two agree.
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2 — build shared -> api -> admin (dependency order matters).
# -----------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# Generate the Prisma client before tsc: apps/api imports types from
# @prisma/client that do not exist until `prisma generate` has run.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# Build-time configuration for the admin bundle.
#
# Vite inlines both of these at build time, so they must exist *here* rather
# than only in the running container. Render and most platforms expose service
# environment variables to a Docker build through matching `ARG`s.
#
# An empty SHOPIFY_API_KEY is the dangerous one: App Bridge fails to
# initialise, and the embedded admin renders a blank frame with nothing in the
# console pointing at the cause. Defaulted to empty so a plain `docker build`
# still succeeds for a smoke test.
ARG SHOPIFY_API_KEY=""
ARG SUPPORT_TELEGRAM_URL=""
ENV SHOPIFY_API_KEY=$SHOPIFY_API_KEY
ENV SUPPORT_TELEGRAM_URL=$SUPPORT_TELEGRAM_URL

RUN npm run build --workspace @codflow/shared \
    && npm run build --workspace @codflow/api \
    && npm run build --workspace @codflow/admin

# -----------------------------------------------------------------------------
# Stage 3 — runtime. Production dependencies plus compiled output only.
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/

# Same reasoning as the deps stage, and here the postinstall would be wasted
# work regardless: the generated client is copied from the build stage rather
# than regenerated.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Compiled JS
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/admin/dist ./apps/admin/dist

# The legal pages are served at /legal/* and their URLs are on the App Store
# listing, so they have to exist in the runtime image. Markdown rather than
# compiled output: it is the source of truth, and it is what gets pasted into
# the Partner Dashboard.
COPY docs/legal ./docs/legal

# The FAQ is served the same way, from /help/faq. Kept out of docs/legal
# because it is support material rather than a contract — nothing here is
# reviewed by a lawyer, and grouping it with the policies invited that
# confusion.
COPY docs/help ./docs/help

# Schema and migrations must ship: the release command runs `prisma migrate deploy`.
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts

# The generated client lives in node_modules/.prisma and is not reproduced by
# `npm ci`, so carry it over from the build stage.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

# Drop privileges. The `node` user ships with the base image as uid 1000.
USER node

EXPOSE 3000

# dumb-init reaps zombies and forwards SIGTERM, so Railway/Render rolling
# restarts drain in-flight requests instead of killing the process group.
ENTRYPOINT ["dumb-init", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
