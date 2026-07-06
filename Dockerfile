# syntax=docker/dockerfile:1.7

# --- Stage 1: install production+dev dependencies for the build --------------
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat: some Alpine deps ship glibc-linked prebuilt binaries and fail
# to load under musl without this shim (openscad-wasm loader has hit this).
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: build the Next.js standalone bundle ----------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Stage 3: minimal runtime image ------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root runtime user. Do NOT reuse the base image's default "node" user,
# to keep the uid/gid explicit and matchable from compose / k8s specs.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# `output: 'standalone'` produces .next/standalone (self-contained server.js
# with a traced node_modules subset). Static assets and /public are not
# included in the standalone bundle and must be copied alongside.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
