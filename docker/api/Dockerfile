# syntax=docker/dockerfile:1

ARG BUN_IMAGE=oven/bun:1.4.0-alpine

FROM ${BUN_IMAGE} AS base

WORKDIR /app

FROM base AS dependencies

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM base AS production-dependencies

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM dependencies AS build

COPY tsconfig*.json ./
COPY src ./src
RUN bun run build

FROM dependencies AS test

COPY tsconfig*.json eslint.config.mjs .prettierrc.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY docker ./docker

FROM ${BUN_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S app \
  && adduser -S -D -H -u 10001 -G app app

COPY --from=production-dependencies --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app
EXPOSE 3000

# Keep Bun as the process receiving SIGTERM so NestJS can drain gracefully.
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun"]
CMD ["dist/bootstrap.js"]
