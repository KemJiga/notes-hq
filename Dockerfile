# One image that serves the web app AND the relay from the same origin.
# Usage: docker build -t notes-hq . && docker run -p 8787:8787 -v notes-hq-data:/data notes-hq

FROM oven/bun:1.4-alpine AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_RELAY_URL=""
ENV VITE_RELAY_URL=$VITE_RELAY_URL
RUN bun run --filter '@notes-hq/web' build && bun run --filter '@notes-hq/relay' build

FROM oven/bun:1.4-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data STATIC_DIR=/app/web
RUN mkdir -p /data && chown bun:bun /data
# The relay bundle is self-contained (no node_modules needed).
COPY --from=build /src/apps/relay/dist/relay.js ./relay.js
COPY --from=build /src/apps/web/dist ./web
USER bun
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["bun", "relay.js"]
