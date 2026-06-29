#!/usr/bin/env bash
set -euo pipefail

#
# build.sh — Build and package the KO History Splunk app.
#
# Single merged app (ko_history): bundles the dashboard_preview custom
# visualizations AND the React wrapper app page (@splunk/react-page).
#
# Usage:   ./build.sh
# Output:  dist/ko_history-<version>.tar.gz
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="ko_history"
APP_DIR="$SCRIPT_DIR/$APP_NAME"
OUTPUT_DIR="$SCRIPT_DIR/dist"

mkdir -p "$OUTPUT_DIR"

VERSION=$(grep '^version' "$APP_DIR/default/app.conf" | head -1 | cut -d= -f2 | tr -d ' ')
TARBALL="$OUTPUT_DIR/${APP_NAME}-${VERSION}.tar.gz"

echo "=== Building $APP_NAME v$VERSION ==="
echo ""

# 1) Build every custom-viz bundle under appserver/static/visualizations/*.
VIZ_BASE="$APP_DIR/appserver/static/visualizations"
for vd in "$VIZ_BASE"/*/; do
    [ -f "$vd/package.json" ] || continue
    VIZ_NAME=$(basename "$vd")
    if [ ! -d "$vd/node_modules" ]; then
        echo "[viz: $VIZ_NAME] Installing npm dependencies..."
        (cd "$vd" && npm install --silent)
    fi
    echo "[viz: $VIZ_NAME] Building webpack bundle..."
    (cd "$vd" && npm run build --silent)
    # Scrub a real public IP that ships inside a bundled Splunk library
    # (@splunk/visualization-schemas) as an example in an option description.
    # AppInspect's check_hostnames_and_ips flags ANY IP-shaped literal (even an
    # RFC 5737 doc address triggers a warning), so replace it with a non-IP
    # placeholder. Harmless — it only appears inside a help string.
    # Apply to ALL emitted .js files (visualization.js + any async *.chunk.js).
    for jsfile in "$vd"/*.js; do
        [ -f "$jsfile" ] || continue
        sed -i.bak 's/12\.21\.1\.11/redacted_ip/g' "$jsfile"
        rm -f "${jsfile}.bak"
    done
done

# 2) Build the React wrapper app page (src/ -> appserver/static/pages/wrapper.js).
if [ -f "$APP_DIR/package.json" ]; then
    if [ ! -d "$APP_DIR/node_modules" ]; then
        echo "[page: wrapper] Installing npm dependencies..."
        (cd "$APP_DIR" && npm install --silent)
    fi
    echo "[page: wrapper] Building webpack bundle..."
    (cd "$APP_DIR" && npm run build --silent)
fi

echo ""
echo "Packaging $TARBALL..."

TAR_FLAGS=()
if [[ "$(uname)" == "Darwin" ]]; then
    xattr -rc "$APP_DIR" 2>/dev/null || true
    export COPYFILE_DISABLE=1
    TAR_FLAGS+=(--disable-copyfile --no-xattrs --no-mac-metadata)
fi

EXCLUDE_FLAGS=(
    --exclude='.*' --exclude='._*' --exclude='__MACOSX'
    # custom-viz build inputs
    --exclude="$APP_NAME/appserver/static/visualizations/*/node_modules"
    --exclude="$APP_NAME/appserver/static/visualizations/*/src"
    --exclude="$APP_NAME/appserver/static/visualizations/*/package.json"
    --exclude="$APP_NAME/appserver/static/visualizations/*/package-lock.json"
    --exclude="$APP_NAME/appserver/static/visualizations/*/webpack.config.js"
    --exclude="$APP_NAME/appserver/static/visualizations/*/VIZ-README.md"
    # React page build inputs (app root)
    --exclude="$APP_NAME/node_modules"
    --exclude="$APP_NAME/src"
    --exclude="$APP_NAME/package.json"
    --exclude="$APP_NAME/package-lock.json"
    --exclude="$APP_NAME/webpack.config.js"
    # Developer test/scratch views — kept in git as harnesses, not shipped.
    # ko_rest_explorer.xml is nav-linked and stays in the package.
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_test.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_ds_v1.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_ds_v2.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_sxml_v1.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_sxml_v2.xml"
    --exclude="$APP_NAME/default/data/ui/views/wrapper_token_test.xml"
)

tar "${TAR_FLAGS[@]}" "${EXCLUDE_FLAGS[@]}" \
    -czf "$TARBALL" \
    -C "$SCRIPT_DIR" \
    "$APP_NAME"

echo ""
echo "Done! Install with:"
echo "  \$SPLUNK_HOME/bin/splunk install app $TARBALL"
echo ""
