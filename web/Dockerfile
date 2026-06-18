# Builds the Astro static site and bakes it into a Caddy image that also
# reverse-proxies the API. Build context must be the repo root.
#
#   docker compose build caddy   (compose sets context: . , dockerfile: web/Dockerfile)

# --- build the static site ---
FROM node:20-bookworm-slim AS build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
# PUBLIC_API_BASE is baked into the static build at compile time.
ARG PUBLIC_API_BASE=https://api.qvac.acurast.dev
ARG PUBLIC_DEPLOY_KEY=changeme-public-qvac-key
ENV PUBLIC_API_BASE=$PUBLIC_API_BASE
ENV PUBLIC_DEPLOY_KEY=$PUBLIC_DEPLOY_KEY
RUN npm run build

# --- serve via Caddy ---
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /web/dist /srv
