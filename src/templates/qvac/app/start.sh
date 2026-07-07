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
DROPBEAR_PID=""

apt-get update

if ! command -v curl >/dev/null 2>&1; then
    apt-get install -y curl
fi

. "$SCRIPT_DIR/callback.sh"

# Report a non-zero exit (set -e bails here) to the webhook, then clean up.
finish() {
    code=$?
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh exiting with code $code"
        report_error "start.sh exited with code $code"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

send_log "Setting up QVAC LLM environment"

# Toolchain for building the getifaddrs shim and any native npm addons.
# libvulkan1: the QVAC linux-arm64 worker hard-links libvulkan.so.1. No GPU is
# needed (llama.cpp falls back to CPU) — this just satisfies the dynamic link.
# On failure, ship the tail of the apt log to the webhook (sanitized: callback.sh
# embeds the message into JSON verbatim, and the webhook rejects any control
# character — apt emits \r progress lines — so keep only printable ASCII minus
# quote/backslash).
APT_LOG=/tmp/apt-install.log
sanitize() {
    tr -c '\40-\176' ' ' | tr -d '"\\'
}
apt-get install -y gcc g++ make python3 python3-cryptography libc6-dev xz-utils libvulkan1 dropbear >"$APT_LOG" 2>&1 || {
    APT_EXIT=$?
    tail -n 40 "$APT_LOG"
    APT_DETAIL=$(tail -c 500 "$APT_LOG" | sanitize)
    report_error "apt-get install failed ($APT_EXIT): $APT_DETAIL"
    exit "$APT_EXIT"
}

# ca-certificates separately: its postinst (update-ca-certificates / openssl
# rehash) fails under proot seccomp on some Android kernels. The package files
# are unpacked even when the postinst fails, so fall back to concatenating the
# Mozilla store into the bundle curl/node read.
if ! apt-get install -y ca-certificates >"$APT_LOG" 2>&1; then
    CA_DETAIL=$(sed -n '/Setting up ca-certificates/,$p' "$APT_LOG" | head -c 600 | sanitize)
    send_log "ca-certificates postinst failed, building CA bundle manually: $CA_DETAIL"
    update-ca-certificates >/dev/null 2>&1 || {
        mkdir -p /etc/ssl/certs
        cat /usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt || true
    }
fi
if ! curl -fsI --max-time 30 https://nodejs.org/ >/dev/null 2>&1; then
    report_error "TLS still broken after CA bundle fallback: curl to https://nodejs.org failed"
    exit 1
fi

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    echo "=== Building getifaddrs override shim ==="
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
    echo "=== Shim built ==="
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- SSH (dropbear over the SECONDARY tunnel) — started before the heavy
# Node/SDK steps so the box stays reachable for debugging when they fail. ---
# SSH key authentication only — password login is disabled (dropbear -s -g).
if [ -z "$SSH_AUTHORIZED_KEYS" ]; then
    echo "ERROR: SSH_AUTHORIZED_KEYS must be set (authorized_keys format)"
    report_error "SSH_AUTHORIZED_KEYS must be set (authorized_keys format)"
    exit 1
fi

mkdir -p /root/.ssh
# %b expands literal \n sequences so multiple keys can be passed in one env var.
printf '%b\n' "$SSH_AUTHORIZED_KEYS" > /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys

mkdir -p /etc/dropbear
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

# SSH sessions get the deployment's environment (LD_PRELOAD shim, PATH, ...).
mkdir -p /etc/profile.d
export -p > /etc/profile.d/acurast-env.sh

echo "=== SSH server starting on port 2222 ==="
send_log "Local SSH server starting on port 2222"
# -s disables password logins, -g disables root password logins: key auth only.
dropbear -F -E -p 2222 -R -s -g &
DROPBEAR_PID=$!

send_log "Opening Acurast reverse tunnel (web + SSH) before heavy setup steps"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# Keep SSH + tunnel alive after a fatal setup error so the box can be inspected.
debug_hold() {
    send_log "Fatal setup error - holding SSH tunnel open for debugging"
    [ -n "$TUNNEL_PID" ] && wait "$TUNNEL_PID"
    exit 1
}

# --- Node.js ---
if [ ! -x "${NODE_DIR}/bin/node" ]; then
    echo "=== Installing Node.js ${NODE_VERSION} ==="
    send_log "Installing Node.js ${NODE_VERSION}"
    mkdir -p /usr/local/lib/nodejs
    {
        curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz" -o /tmp/node.tar.xz &&
        tar -xf /tmp/node.tar.xz -C /usr/local/lib/nodejs
    } || {
        report_error "Node.js download/extract failed (exit $?)"
        debug_hold
    }
    rm -f /tmp/node.tar.xz
fi
export PATH="${NODE_DIR}/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
    report_error "Node.js install failed: node not on PATH after extract"
    debug_hold
fi
echo "node: $(node --version), npm: $(npm --version)"
# Refresh the SSH session environment now that PATH includes node.
export -p > /etc/profile.d/acurast-env.sh

# --- Install the QVAC SDK ---
cd "$SCRIPT_DIR"
if [ ! -d "$SCRIPT_DIR/node_modules/@qvac/sdk" ]; then
    echo "=== Installing @qvac/sdk (downloads native LLM runtime binaries, ~GBs) ==="
    send_log "Installing QVAC SDK (this downloads native LLM runtime binaries)"
    NPM_LOG=/tmp/npm-install.log
    npm install --no-audit --no-fund >"$NPM_LOG" 2>&1 || {
        NPM_EXIT=$?
        tail -n 40 "$NPM_LOG"
        NPM_DETAIL=$(tail -c 500 "$NPM_LOG" | sanitize)
        DISK=$(df -h "$SCRIPT_DIR" /tmp 2>/dev/null | tail -n +2 | sanitize)
        MEM=$(grep -E 'MemAvailable|MemTotal' /proc/meminfo 2>/dev/null | sanitize)
        report_error "npm install failed ($NPM_EXIT): $NPM_DETAIL | disk: $DISK | mem: $MEM"
        debug_hold
    }
fi
if [ ! -d "$SCRIPT_DIR/node_modules/@qvac/sdk" ]; then
    report_error "QVAC SDK install failed: node_modules/@qvac/sdk missing"
    debug_hold
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

echo "=== Starting QVAC LLM server on port ${WEB_PORT:-8080} ==="
send_log "Starting QVAC LLM server (loads the model in the background)"

node "$SCRIPT_DIR/server.mjs" &
SERVER_PID=$!

send_log "Local server started (tunnel already up)"

# Don't let `set -e` swallow the tunnel's exit code — handle it explicitly.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?

if [ "$TUNNEL_EXIT" -ne 0 ]; then
    echo "ERROR: tunnel exited with status $TUNNEL_EXIT"
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$SERVER_PID"
