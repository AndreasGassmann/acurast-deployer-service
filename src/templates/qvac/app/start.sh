#!/bin/sh
set -e

echo "=== Setting up environment ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so
# QVAC SDK needs Node >= v22.17; v24 is the verified runtime on the processor.
NODE_VERSION=v24.16.0
NODE_DIST="node-${NODE_VERSION}-linux-arm64"
NODE_DIR="/usr/local/lib/nodejs/${NODE_DIST}"

# Children are killed and any failure is reported to the webhook on the way out.
SERVER_PID=""
TUNNEL_PID=""

# apt on the proot image fails intermittently (mirror hiccups, stale index) and
# bails the whole script with exit 100 under `set -e`. Retry apt with a fresh
# index each attempt so a transient failure doesn't kill the deployment. apt's
# real error only goes to the processor's stdout (invisible to us), so on the
# final failure we forward the tail of it via the webhook (send_log) to debug.
export DEBIAN_FRONTEND=noninteractive
apt_retry() {
    i=1
    while :; do
        out=$( { apt-get update && apt-get "$@"; } 2>&1 ) && return 0
        if [ "$i" -ge 5 ]; then
            echo "ERROR: 'apt-get $*' failed after $i attempts"
            echo "$out"
            tail=$(printf '%s' "$out" | tail -n 4 | tr '\n' '|')
            command -v send_log >/dev/null 2>&1 && send_log "apt 'apt-get $*' failed: ${tail}"
            return 1
        fi
        echo "apt-get $* failed (attempt $i), retrying in 10s"
        sleep 10
        i=$((i + 1))
    done
}

if ! command -v curl >/dev/null 2>&1; then
    apt_retry install -y curl
fi

. "$SCRIPT_DIR/callback.sh"

# Current step, so a `set -e` abort reports WHERE it died, not just the code.
STEP="startup"
step() {
    STEP="$1"
    echo "=== $STEP ==="
}

# Retry a flaky (usually network) command a few times before giving up.
retry() {
    i=1
    while :; do
        "$@" && return 0
        if [ "$i" -ge 3 ]; then
            echo "ERROR: '$*' failed after $i attempts"
            return 1
        fi
        echo "'$*' failed (attempt $i); retrying in 10s"
        sleep 10
        i=$((i + 1))
    done
}

# Report a non-zero exit (set -e bails here) to the webhook, then clean up.
finish() {
    code=$?
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh failed during '$STEP' (exit $code)"
        report_error "start.sh failed during '$STEP' (exit $code)"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

send_log "Setting up QVAC LLM environment"

# Toolchain for building the getifaddrs shim and any native npm addons.
# libvulkan1: the QVAC linux-arm64 worker hard-links libvulkan.so.1. No GPU is
# needed (llama.cpp falls back to CPU) — this just satisfies the dynamic link.
step "apt install toolchain"
apt_retry install -y gcc g++ make python3 python3-cryptography libc6-dev xz-utils ca-certificates libvulkan1

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    step "build getifaddrs shim"
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
    echo "=== Shim built ==="
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- Node.js ---
if [ ! -x "${NODE_DIR}/bin/node" ]; then
    step "install Node.js ${NODE_VERSION}"
    send_log "Installing Node.js ${NODE_VERSION}"
    mkdir -p /usr/local/lib/nodejs
    retry curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz" -o /tmp/node.tar.xz
    tar -xf /tmp/node.tar.xz -C /usr/local/lib/nodejs
    rm -f /tmp/node.tar.xz
fi
export PATH="${NODE_DIR}/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
    report_error "Node.js install failed: node not on PATH after extract"
    exit 1
fi
echo "node: $(node --version), npm: $(npm --version)"

# --- Install the QVAC SDK ---
cd "$SCRIPT_DIR"
if [ ! -d "$SCRIPT_DIR/node_modules/@qvac/sdk" ]; then
    step "install @qvac/sdk"
    send_log "Installing QVAC SDK (this downloads native LLM runtime binaries)"
    retry npm install --no-audit --no-fund
fi
if [ ! -d "$SCRIPT_DIR/node_modules/@qvac/sdk" ]; then
    report_error "QVAC SDK install failed: node_modules/@qvac/sdk missing"
    exit 1
fi

# --- QVAC runtime workarounds (Android arm64 under glibc proot) ---
#
# 1. Short TMPDIR. The SDK creates its IPC socket under os.tmpdir(); on Android
#    that resolves to a long cache path, pushing the socket path past Linux's
#    ~108-char Unix-socket limit (EINVAL). Force a short one.
mkdir -p /tmp
export TMPDIR=/tmp
#
# 2. LLM-only worker. The default SDK worker registers every plugin, and some
#    linux-arm64 prebuilts (e.g. translation/nmt) are compiled with SVE, which
#    many Android CPUs lack — loading them SIGILLs in a static initializer
#    before any model runs. Generate a worker that registers only the LLM
#    plugin. Generated at runtime so the absolute file:// paths match wherever
#    the deployment was unpacked (the SDK's internal modules aren't in its
#    package "exports" map and Bare enforces that map, so they must be imported
#    by absolute file URL; the plugin entry IS exported).
WORKER_ENTRY="$SCRIPT_DIR/worker.entry.mjs"
SDK_DIST="$SCRIPT_DIR/node_modules/@qvac/sdk/dist"
cat > "$WORKER_ENTRY" <<EOF
import { initializeWorkerCore, ensureRPCSetup } from "file://${SDK_DIST}/server/worker-core.js";
import { registerPlugins } from "file://${SDK_DIST}/server/plugins/index.js";
import { getServerLogger } from "file://${SDK_DIST}/logging/index.js";
import { llmPlugin } from "@qvac/sdk/llamacpp-completion/plugin";

const { hasRPCConfig } = initializeWorkerCore();
const logger = getServerLogger();
logger.info("Custom LLM-only QVAC worker starting");

registerPlugins([llmPlugin]);

if (hasRPCConfig) {
    ensureRPCSetup();
} else {
    logger.info("Running in direct mode - RPC setup will be lazy");
}
EOF
export QVAC_WORKER_PATH="$WORKER_ENTRY"

step "start QVAC LLM server"
send_log "Starting QVAC LLM server (loads the model in the background)"

node "$SCRIPT_DIR/server.mjs" &
SERVER_PID=$!

step "open Acurast tunnel"
send_log "Local server ready, opening Acurast reverse tunnel"

python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# Don't let `set -e` swallow the tunnel's exit code — handle it explicitly.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?

if [ "$TUNNEL_EXIT" -ne 0 ]; then
    echo "ERROR: tunnel exited with status $TUNNEL_EXIT"
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$SERVER_PID"
