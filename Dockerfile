# One image that serves the web app AND the relay from the same origin.
# Usage: docker build -t notes-hq . && docker run -p 8787:8787 -v notes-hq-data:/data notes-hq

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
ARG VITE_RELAY_URL=""
ENV VITE_RELAY_URL=$VITE_RELAY_URL
RUN npm run build --workspace @notes-hq/web && npm run build --workspace @notes-hq/relay

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data STATIC_DIR=/app/web
RUN npm install --omit=dev --no-save ws@8 && mkdir -p /data && chown node:node /data
COPY --from=build /src/apps/relay/dist/relay.mjs ./relay.mjs
COPY --from=build /src/apps/web/dist ./web
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "relay.mjs"]
