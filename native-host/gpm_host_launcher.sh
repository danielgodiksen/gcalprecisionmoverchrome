#!/bin/bash
# GCal Precision Mover — native host launcher.
#
# Chrome starts native hosts with a minimal environment (PATH is just
# /usr/bin:/bin:/usr/sbin:/sbin on macOS, no shell profile), so a plain
# `#!/usr/bin/env python3` shebang dies when python3 lives in Homebrew or
# pyenv — Chrome then reports "Native host has exited." This wrapper finds a
# python3 that actually runs and execs the real host with it.
#
# Failures are logged to /tmp/gpm-native-host.log for easy debugging.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$DIR/gpm_native_host.py"
LOG="/tmp/gpm-native-host.log"

CANDIDATES=(
  /usr/bin/python3          # macOS system python (Xcode CLT) / most Linux
  /opt/homebrew/bin/python3 # Homebrew on Apple Silicon
  /usr/local/bin/python3    # Homebrew on Intel macs / manual installs
  python3                   # whatever PATH has, as a last resort
)

for py in "${CANDIDATES[@]}"; do
  # `-c ''` verifies the interpreter genuinely runs (the Xcode-stub
  # /usr/bin/python3 exists but exits with an error when CLT is missing).
  if "$py" -c '' 2>/dev/null; then
    exec "$py" "$HOST"
  fi
done

echo "[$(date)] No working python3 found (tried: ${CANDIDATES[*]})" >> "$LOG"
exit 1
