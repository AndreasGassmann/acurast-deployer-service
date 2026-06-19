#!/usr/bin/env bash
#
# Pull the latest code, rebuild the Docker images, restart the stack, and remove
# image layers left dangling by the rebuild. Run on the server from anywhere:
#
#   ./update.sh
#
set -euo pipefail

# Always operate from the repo root (where this script lives).
cd "$(dirname "$0")"

# Docker Compose v2 (`docker compose`) with a fallback to the legacy binary.
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    echo "ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2
    exit 1
fi

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Rebuilding images"
$COMPOSE build

echo "==> Restarting stack"
$COMPOSE up -d

# Rebuilds leave the previous, now-untagged image layers dangling. Drop them so
# disk doesn't grow every update. Only dangling (untagged) images are removed —
# tagged images in use are untouched.
echo "==> Removing dangling images"
docker image prune -f

echo "==> Done"
