# --- build stage ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# --- runtime stage ---
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# history.jsonl lives here; mount a volume to persist it
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "dist/server.js"]
