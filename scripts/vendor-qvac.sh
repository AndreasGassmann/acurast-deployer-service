#!/bin/sh
# Refresh the vendored acurast-qvac payload from upstream.
# Vendors the real acurast.json (incl. the proot image url + sha256) and the app/
# directory into src/templates/qvac/, and records the source commit.
set -eu

REPO="https://github.com/Acurast/acurast-qvac"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/templates/qvac"
TMP="$(mktemp -d)"

echo "Cloning $REPO ..."
git clone --depth 1 "$REPO" "$TMP"

cp "$TMP/acurast.json" "$DEST/acurast.json"
rm -rf "$DEST/app"
cp -R "$TMP/app" "$DEST/app"
git -C "$TMP" rev-parse HEAD > "$DEST/UPSTREAM_COMMIT"

rm -rf "$TMP"
echo "Vendored acurast-qvac @ $(cat "$DEST/UPSTREAM_COMMIT")"
echo "NOTE: template projectName is 'qvac-llm' (see src/templates/qvac.ts)."
