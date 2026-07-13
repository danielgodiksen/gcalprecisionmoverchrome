#!/bin/bash
# GCal Precision Mover — native host launcher.
#
# Chrome starts native hosts with a minimal environment (PATH is just
# /usr/bin:/bin:/usr/sbin:/sbin on macOS, no shell profile), so a plain
# `#!/usr/bin/env python3` shebang dies when python3 lives in Homebrew or
# pyenv — Chrome then reports "Native host has exited." This wrapper finds a
# python3 that actually runs and execs the real host with it.
#
# install.sh COPIES this launcher (plus gpm_native_host.py and a generated
# gpm_host.conf holding the repo path) into a folder outside ~/Documents.
# That matters on macOS: Documents/Desktop/Downloads are TCC-protected, and
# Chromium launches native hosts with the browser's TCC permissions stripped
# (disclaimed responsibility chain), so this process runs as bare bash/python
# with no folder access — regardless of what the browser itself was granted.
# A host script inside a protected folder dies before line 1 and Chrome shows
# "Native host has exited." Running from ~/Library sidesteps that; only the
# git commands then touch the repo, and the host reports THOSE failures with
# a fix hint (move the repo outside the protected folders).
#
# Every launch logs a breadcrumb to /tmp/gpm-native-host.log for debugging,
# and launcher-level failures are sent back to the browser as a real native
# messaging reply so the popup shows an actionable error.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$DIR/gpm_native_host.py"
LOG="/tmp/gpm-native-host.log"

# Installed copies live outside the repo; the conf tells the host where the
# repo is. When run straight from the repo (no conf), derive it from our path.
[ -f "$DIR/gpm_host.conf" ] && . "$DIR/gpm_host.conf"
export GPM_REPO="${GPM_REPO:-$(dirname "$DIR")}"

# Prefer the repo's host script when we can read it, so a `git pull` updates
# the helper too; the installed snapshot is the fallback that always starts.
# The probe must actually open the file: `[ -r ]` uses access(2), which macOS
# TCC does not intercept, so it reports a Documents-folder script as readable
# even when the browser's open(2) of it would get EPERM — python would then
# die before the host could reply.
REPO_HOST="$GPM_REPO/native-host/gpm_native_host.py"
[ "$REPO_HOST" != "$HOST" ] && head -c1 "$REPO_HOST" >/dev/null 2>&1 && HOST="$REPO_HOST"

log() { echo "[$(date)] $*" >> "$LOG"; }

# Reply with a framed native-messaging error (4-byte LE length + JSON) so the
# extension popup shows this message instead of "Native host has exited."
# $1 must be plain ASCII with no double quotes or backslashes.
fail() {
  log "FAIL: $1"
  local msg="{\"ok\":false,\"error\":\"$1\"}"
  local len=${#msg}
  printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' \
    $((len & 255)) $((len >> 8 & 255)) $((len >> 16 & 255)) $((len >> 24 & 255)))"
  printf '%s' "$msg"
  exit 0
}

log "launched from $DIR (repo: $GPM_REPO)"

[ -r "$HOST" ] || fail "Update helper cannot read $HOST - re-run native-host/install.sh."

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

fail "No working python3 found (tried system, Homebrew and PATH locations)."
