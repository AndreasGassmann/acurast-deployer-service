# Builds the Astro static site and serves it with nginx. Build context = repo root.
#
#   docker compose build web   (compose sets context: . , dockerfile: web/Dockerfile)

# --- build the static site ---
FROM node:20-bookworm-slim AS build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
# PUBLIC_* values are baked into the static build at compile time.
ARG PUBLIC_API_BASE=https://api.qvac.acurast.dev
ARG PUBLIC_DEPLOY_KEY=changeme-public-qvac-key
ENV PUBLIC_API_BASE=$PUBLIC_API_BASE
ENV PUBLIC_DEPLOY_KEY=$PUBLIC_DEPLOY_KEY
RUN npm run build

# --- serve static files ---
FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
