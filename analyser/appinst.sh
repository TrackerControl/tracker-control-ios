#!/bin/bash
set -euo pipefail

SCRIPTPATH="$( cd -- "$(dirname "$0")" >/dev/null 2>&1 ; pwd -P )"

# --- Configuration --------------------------------------------------------
: "${COMPATIBLE_EXTENSION_POINTS:?COMPATIBLE_EXTENSION_POINTS is not set. Run through processQueue.sh or export the whitelist first.}"

extension_point_is_compatible() {
    extension_point="$1"
    for allowed in $COMPATIBLE_EXTENSION_POINTS; do
        if [ "$extension_point" = "$allowed" ]; then
            return 0
        fi
    done
    return 1
}

# --- Locate IPA -----------------------------------------------------------
if [ $# -eq 1 ]; then
    IPA="$1"
else
    shopt -s nullglob
    IPAS=(*.ipa)
    shopt -u nullglob
    if [ ${#IPAS[@]} -eq 0 ]; then
        echo "Error: No .ipa found. Usage: $0 <file.ipa>" >&2; exit 1
    fi
    IPA="${IPAS[0]}"
    [ ${#IPAS[@]} -gt 1 ] && echo "Warning: multiple IPAs, using $IPA" >&2
fi

TMPDIR=$(mktemp -d)
PID=$$
LOCAL_PATCHED="/tmp/install_${PID}.ipa"
REMOTE_PATCHED="/tmp/install_${PID}.ipa"

cleanup() {
    rm -rf "$TMPDIR" "$LOCAL_PATCHED"
    ssh ios "rm -f '$REMOTE_PATCHED'" 2>/dev/null || true
}
trap cleanup EXIT

# --- Unzip ----------------------------------------------------------------
echo ">>> Extracting $IPA ..."
unzip -q "$IPA" -d "$TMPDIR"

APP_PATH=$(find "$TMPDIR/Payload" -maxdepth 1 -name "*.app" -type d | head -n 1)
[ -z "$APP_PATH" ] && { echo "Error: No .app found in Payload" >&2; exit 1; }

# --- Selective appex pruning ----------------------------------------------
if [ -d "$APP_PATH/Extensions" ]; then
    echo ">>> Auditing extensions ..."
    for appex in "$APP_PATH/Extensions"/*.appex; do
        [ -d "$appex" ] || continue
        plist="$appex/Info.plist"

        point=$(python3 "$SCRIPTPATH/plist_value.py" "$plist" "EXAppExtensionAttributes:EXExtensionPointIdentifier" 2>/dev/null \
             || python3 "$SCRIPTPATH/plist_value.py" "$plist" "NSExtension:NSExtensionPointIdentifier" 2>/dev/null \
             || echo "UNKNOWN")

        if extension_point_is_compatible "$point"; then
            echo "KEEP  ($point): $(basename "$appex")"
        else
            echo "REMOVE ($point): $(basename "$appex")"
            rm -rf "$appex"
        fi
    done
else
    echo ">>> No Extensions folder found."
fi

# --- Repackage, push, install ---------------------------------------------
echo ">>> Repackaging ..."
( cd "$TMPDIR" && zip -qr "$LOCAL_PATCHED" Payload )

echo ">>> Pushing to device ..."
scp "$LOCAL_PATCHED" ios:"$REMOTE_PATCHED"

echo ">>> Installing via appinst ..."
ssh ios "appinst '$REMOTE_PATCHED'"

echo ">>> Done."
