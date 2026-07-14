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

# --- E7: verify both version = lines in app.conf are identical -----------
VERSION2=$(grep '^version' "$APP_DIR/default/app.conf" | tail -1 | cut -d= -f2 | tr -d ' ')
if [ "$VERSION" != "$VERSION2" ]; then
    echo "ERROR: version mismatch in $APP_DIR/default/app.conf:" >&2
    echo "  first  'version' line: $VERSION" >&2
    echo "  second 'version' line: $VERSION2" >&2
    echo "Fix both lines to match before building." >&2
    exit 1
fi

echo "=== Building $APP_NAME v$VERSION ==="
echo ""

# 1) Build every custom-viz bundle under appserver/static/visualizations/*.
VIZ_BASE="$APP_DIR/appserver/static/visualizations"
for vd in "$VIZ_BASE"/*/; do
    [ -f "$vd/package.json" ] || continue
    VIZ_NAME=$(basename "$vd")
    # --- E5: prune stale chunk files before rebuild ----------------------
    # output.path for these vizs equals the viz dir itself (source + output
    # co-located), so webpack's output.clean:true would nuke src/ etc.
    # Instead, remove numeric/named chunk JS files that webpack may rename
    # across builds (leaving stale committed chunks that would ship).
    for stale in "$vd"/*.chunk.js "$vd"/*.chunk.js.LICENSE.txt; do
        [ -f "$stale" ] && rm -f "$stale"
    done
    # --- E6: always install from lockfile (npm ci) -----------------------
    echo "[viz: $VIZ_NAME] Installing npm dependencies (npm ci)..."
    if [ -f "$vd/package-lock.json" ]; then
        (cd "$vd" && npm ci --silent)
    else
        (cd "$vd" && npm install --silent)
    fi
    echo "[viz: $VIZ_NAME] Building webpack bundle..."
    (cd "$vd" && npm run build --silent)
done

# 2) Build the React wrapper app page (src/ -> appserver/static/pages/wrapper.js).
if [ -f "$APP_DIR/package.json" ]; then
    # --- E6: always install from lockfile (npm ci) -----------------------
    echo "[page: wrapper] Installing npm dependencies (npm ci)..."
    if [ -f "$APP_DIR/package-lock.json" ]; then
        (cd "$APP_DIR" && NODE_OPTIONS= npm ci --silent)
    else
        (cd "$APP_DIR" && NODE_OPTIONS= npm install --silent)
    fi
    echo "[page: wrapper] Building webpack bundle..."
    (cd "$APP_DIR" && NODE_OPTIONS= npm run build --silent)
fi

echo ""

# --- E8: IP scrub + guard ---------------------------------------------------
# @splunk/visualization-schemas (bundled by dashboard-core inside
# live_render.chunk.js) ships the literal IP 12.21.1.11 as an example value
# inside an option description string. AppInspect flags any IP literal, so we
# replace it with a non-IP placeholder. Applied to ALL emitted JS — viz
# bundles AND the wrapper page — so no path is missed.
BANNED_IP='12\.21\.1\.11'
for js_file in \
    "$APP_DIR"/appserver/static/pages/*.js \
    "$APP_DIR"/appserver/static/visualizations/*/*.js; do
    [ -f "$js_file" ] || continue
    if grep -q "$BANNED_IP" "$js_file" 2>/dev/null; then
        echo "[IP scrub] Scrubbing $BANNED_IP from $(basename "$js_file")..."
        sed -i.bak 's/12\.21\.1\.11/redacted_ip/g' "$js_file"
        rm -f "${js_file}.bak"
    fi
done

# Post-scrub guard: fail if the IP survived the sed (e.g. a new library
# added it in a form the pattern misses, or the sed was skipped on a platform
# that lacks -i.bak semantics).
FOUND_IP=0
for js_file in \
    "$APP_DIR"/appserver/static/pages/*.js \
    "$APP_DIR"/appserver/static/visualizations/*/*.js; do
    [ -f "$js_file" ] || continue
    if grep -q "$BANNED_IP" "$js_file" 2>/dev/null; then
        echo "ERROR: banned IP still present after scrub: $js_file" >&2
        FOUND_IP=1
    fi
done
if [ "$FOUND_IP" -ne 0 ]; then
    echo "Build aborted — IP scrub did not remove all occurrences." >&2
    exit 1
fi

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
    # App icons — modern Splunk + AppInspect read static/; appserver/static/ copies
    # are byte-identical legacy duplicates kept in git pending live launcher-icon
    # verification on the demo instance before being deleted from git.
    --exclude="$APP_NAME/appserver/static/appIcon.png"
    --exclude="$APP_NAME/appserver/static/appIcon_2x.png"
    --exclude="$APP_NAME/appserver/static/appIcon_3x.png"
    --exclude="$APP_NAME/appserver/static/appIconAlt.png"
    --exclude="$APP_NAME/appserver/static/appIconAlt_2x.png"
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
