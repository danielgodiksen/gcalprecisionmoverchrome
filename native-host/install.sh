#!/bin/bash
# GCal Precision Mover — one-time installer for the update helper.
#
# Registers native-host/gpm_native_host.py with Chrome so the extension's
# "Update now" button can run `git pull` in this folder and reload itself.
#
# Usage:  bash install.sh
# Remove: bash install.sh --uninstall

set -euo pipefail

HOST_NAME="com.danielgodiksen.gpm_updater"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
HOST_SCRIPT="$DIR/gpm_native_host.py"

case "$(uname -s)" in
  Darwin)
    TARGETS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    )
    ;;
  Linux)
    TARGETS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Unsupported OS (Windows needs registry keys — see README)." >&2
    exit 1
    ;;
esac

if [[ "${1:-}" == "--uninstall" ]]; then
  for t in "${TARGETS[@]}"; do
    rm -f "$t/$HOST_NAME.json" && echo "Removed $t/$HOST_NAME.json" || true
  done
  exit 0
fi

# Derive the extension ID from the "key" pinned in manifest.json.
EXT_ID="$(python3 - "$REPO/manifest.json" <<'PY'
import json, hashlib, base64, sys
key = json.load(open(sys.argv[1]))["key"]
h = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
PY
)"

chmod +x "$HOST_SCRIPT"

INSTALLED=0
for t in "${TARGETS[@]}"; do
  # Only install for browsers that exist on this machine.
  [[ -d "$(dirname "$t")" ]] || continue
  mkdir -p "$t"
  cat > "$t/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "GCal Precision Mover update helper (git pull)",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "Installed: $t/$HOST_NAME.json"
  INSTALLED=1
done

if [[ "$INSTALLED" == "0" ]]; then
  echo "No Chrome profile folder found — is Chrome installed?" >&2
  exit 1
fi

echo
echo "Done. Extension ID: $EXT_ID"
echo "Reload the extension once (chrome://extensions → ↻), then the"
echo "'Update now' button in the popup will work."
