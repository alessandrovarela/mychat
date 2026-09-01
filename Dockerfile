# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends --yes python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

# The backend compiler deliberately has noEmit enabled for local checks. The
# image is the one place that emits the production Node program.
RUN npm run build && npx tsc --noEmit false --outDir build

FROM node:24-trixie-slim AS production-dependencies

WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends --yes python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-trixie-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --from=build --chown=node:node /app/build ./build
# The compiled static-route module lives at /app/build/src/http. Its
# WEB_DIST_DIR resolves ../../dist/web from there, so the web bundle must live
# under /app/build/dist rather than alongside the compiled application.
COPY --from=build --chown=node:node /app/dist ./build/dist
COPY --from=build --chown=node:node /app/src/i18n/locales ./build/src/i18n/locales
COPY --chown=node:node drizzle ./build/drizzle

USER node
EXPOSE 3000

CMD ["node", "build/src/main.js"]
