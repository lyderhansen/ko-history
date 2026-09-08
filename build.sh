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

# --- E9: a build that does not build must not look like success -------------
# `npm run build` runs `webpack --mode production`. When webpack is not
# resolvable -- a partially materialised node_modules, a missing .bin, a cloud
# sync folder that has not hydrated -- the shell prints
# "webpack: command not found" and npm STILL EXITS 0. set -euo pipefail cannot
# see it. The build then packages whatever bundle happens to be on disk and
# reports success, which is how a release ships source changes that never made
# it into the compiled output. That has happened here at least once.
#
# NOT mtime. The first version of this guard compared the bundle's mtime across
# the build and failed the moment it met a no-op rebuild: webpack reports
# "[compared for emit]" and deliberately does NOT rewrite a file whose contents
# are unchanged, so an unchanged mtime is the normal result of building twice
# with no source edits, not evidence of a broken toolchain.
#
# What actually distinguishes "webpack ran" from "webpack was missing" is
# webpack's own success line, so assert on that.
assert_compiled() {
    local label="$1" out="$2"
    if ! printf '%s' "$out" | grep -q "compiled successfully"; then
        echo "FATAL: [$label] webpack never reported success." >&2
        echo "       npm exits 0 when webpack is missing, so this is the only" >&2
        echo "       reliable signal. Check node_modules/.bin/webpack exists." >&2
        exit 1
    fi
}


# 1) Build every REGISTERED custom-viz bundle under appserver/static/visualizations/*.
#    Registration = a stanza in default/visualizations.conf. An unregistered
#    directory is build residue of a removed viz (git no longer tracks it, but
#    the files can linger in a working tree). Building it wastes minutes on
#    npm ci and — worse — regenerates chunk files that then get PACKAGED,
#    silently re-bloating the release (v1.0.3 shrank the app from 13.2 MB to
#    0.96 MB precisely by removing such a viz).
VIZ_BASE="$APP_DIR/appserver/static/visualizations"
VIZ_CONF="$APP_DIR/default/visualizations.conf"
for vd in "$VIZ_BASE"/*/; do
    [ -f "$vd/package.json" ] || continue
    VIZ_NAME=$(basename "$vd")
    if ! grep -q "^\[$VIZ_NAME\]" "$VIZ_CONF" 2>/dev/null; then
        echo "[viz: $VIZ_NAME] SKIPPED — no [$VIZ_NAME] stanza in visualizations.conf (build residue)."
        continue
    fi
    # --- E5: prune stale chunk files before rebuild ----------------------
    # output.path for these vizs equals the viz dir itself (source + output
    # co-located), so webpack's output.clean:true would nuke src/ etc.
    # Instead, remove numeric/named chunk JS files that webpack may rename
    # across builds (leaving stale committed chunks that would ship).
    for stale in "$vd"/*.chunk.js "$vd"/*.chunk.js.LICENSE.txt; do
        [ -f "$stale" ] && rm -f "$stale"
    done
    # --- E6: always install from lockfile (npm ci) -----------------------
    #
    # NODE_OPTIONS is cleared on every node/npm invocation here, exactly as the
    # page build below already did. An inherited NODE_OPTIONS carrying
    # --require=<path> aborts npm the moment that path stops existing, which is
    # normal for a preload script living in a temp directory: the build then dies
    # with MODULE_NOT_FOUND from internal/preload and a node stack trace, naming
    # a file that has nothing to do with this app. Clearing it in one place and
    # not the other is how that arrived as a mystery viz-build failure while the
    # page build carried on working.
    echo "[viz: $VIZ_NAME] Installing npm dependencies (npm ci)..."
    if [ -f "$vd/package-lock.json" ]; then
        (cd "$vd" && NODE_OPTIONS= npm ci --silent)
    else
        (cd "$vd" && NODE_OPTIONS= npm install --silent)
    fi
    echo "[viz: $VIZ_NAME] Building webpack bundle..."
    _viz_out=$( (cd "$vd" && NODE_OPTIONS= npm run build --silent) 2>&1 ) || { echo "$_viz_out"; exit 1; }
    echo "$_viz_out"
    assert_compiled "viz: $VIZ_NAME" "$_viz_out"
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
    _pages_out=$( (cd "$APP_DIR" && NODE_OPTIONS= npm run build --silent) 2>&1 ) || { echo "$_pages_out"; exit 1; }
    echo "$_pages_out"
    assert_compiled "pages: wrapper + settings" "$_pages_out"
    # Both entry chunks must exist: a webpack entry that silently stopped being
    # emitted would otherwise ship an app page that 404s on its bundle.
    for _p in wrapper settings; do
        [ -s "$APP_DIR/appserver/static/pages/$_p.js" ] || {
            echo "FATAL: [pages] $_p.js is missing or empty after a successful build." >&2; exit 1; }
    done
fi

echo ""

# --- E8: IP scrub + guard ---------------------------------------------------
# AppInspect flags any IP literal in shipped JS, including ones that are just
# example values inside a third-party library's option descriptions. This
# replaces the known offender with a non-IP placeholder across ALL emitted JS,
# both viz bundles and the wrapper page, so no path is missed.
#
# The library that carried it (@splunk/visualization-schemas, via dashboard-core)
# left with dashboard_preview_ds in 1.0.3, so the scrub is currently a no-op.
# It stays because the guard below is the useful half: it fails the build if a
# future dependency reintroduces an IP literal, rather than letting AppInspect
# find it after upload.
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
# Collect exclude flags for any viz dir that has no visualizations.conf stanza.
UNREGISTERED_VIZ_EXCLUDES=()
for vd in "$VIZ_BASE"/*/; do
    [ -d "$vd" ] || continue
    vname=$(basename "$vd")
    if ! grep -q "^\[$vname\]" "$VIZ_CONF" 2>/dev/null; then
        UNREGISTERED_VIZ_EXCLUDES+=(--exclude="$APP_NAME/appserver/static/visualizations/$vname")
        echo "[package] excluding unregistered viz dir: $vname"
    fi
done

if [[ "$(uname)" == "Darwin" ]]; then
    # PRUNE node_modules. `xattr -rc "$APP_DIR"` walks every file under the app,
    # and node_modules is tens of thousands of them across ~100 packages. On a
    # cloud-sync-backed folder that does not finish in any reasonable time: it
    # was observed still running after six minutes, with the build sitting at
    # "Packaging..." and no tar process yet started, which reads as a hang.
    #
    # The work was pointless as well as slow. node_modules is excluded from the
    # tarball a few lines below, so its extended attributes were being cleared
    # on files that are never packaged. Only what actually ships needs cleaning.
    find "$APP_DIR" -name node_modules -type d -prune -o -print0 2>/dev/null \
        | xargs -0 xattr -c 2>/dev/null || true
    export COPYFILE_DISABLE=1
    TAR_FLAGS+=(--disable-copyfile --no-xattrs --no-mac-metadata)
fi

EXCLUDE_FLAGS=(
    --exclude='.*' --exclude='._*' --exclude='__MACOSX'
    # Unregistered viz directories (build residue of removed vizs): belt and
    # braces with the build-loop skip above, so residue can never be packaged
    # even if its bundles were produced by some other means.
    #
    # The ${arr[@]+"${arr[@]}"} form is required, not stylistic. bash 3.2 (the
    # /bin/bash on every macOS) treats an empty-array expansion as an unset
    # variable under `set -u`, so a plain "${UNREGISTERED_VIZ_EXCLUDES[@]}"
    # aborts the build with 'unbound variable' in the normal case where every
    # viz is registered and the array is empty.
    ${UNREGISTERED_VIZ_EXCLUDES[@]+"${UNREGISTERED_VIZ_EXCLUDES[@]}"}
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
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_test.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_ds_v1.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_ds_v2.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_sxml_v1.xml"
    --exclude="$APP_NAME/default/data/ui/views/ko_diff_sxml_v2.xml"
    --exclude="$APP_NAME/default/data/ui/views/wrapper_token_test.xml"
)

# TAR_FLAGS is only populated on Darwin, so it is empty on Linux and needs the
# same empty-array guard as above. EXCLUDE_FLAGS always has at least one entry.
tar ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} "${EXCLUDE_FLAGS[@]}" \
    -czf "$TARBALL" \
    -C "$SCRIPT_DIR" \
    "$APP_NAME"

echo ""
echo "Done! Install with:"
echo "  \$SPLUNK_HOME/bin/splunk install app $TARBALL"
echo ""
