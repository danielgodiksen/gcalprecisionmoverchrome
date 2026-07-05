#!/usr/bin/env python3
"""GCal Precision Mover — native messaging host.

Launched by Chrome when the extension calls
chrome.runtime.sendNativeMessage("com.danielgodiksen.gpm_updater", ...).

Commands (JSON over Chrome's native messaging protocol):
  {"cmd": "status"}  -> { ok, sha, shortSha, branch, dirty, repo }
  {"cmd": "pull"}    -> { ok, updated, sha, output } | { ok: false, error }

The repo path is derived from this script's location (it lives in
<repo>/native-host/), so cloning the repo anywhere just works.
"""

import json
import os
import struct
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(msg):
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def git(*args, timeout=60):
    return subprocess.run(
        ["git", "-C", REPO, *args],
        capture_output=True, text=True, timeout=timeout,
    )


def cmd_status():
    sha = git("rev-parse", "HEAD")
    if sha.returncode != 0:
        return {"ok": False, "error": "Not a git repository: " + REPO}
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    dirty = git("status", "--porcelain")
    head = sha.stdout.strip()
    return {
        "ok": True,
        "sha": head,
        "shortSha": head[:7],
        "branch": branch.stdout.strip(),
        "dirty": bool(dirty.stdout.strip()),
        "repo": REPO,
    }


def cmd_pull():
    before = git("rev-parse", "HEAD")
    if before.returncode != 0:
        return {"ok": False, "error": "Not a git repository: " + REPO}

    # Refuse to clobber uncommitted local edits.
    dirty = git("status", "--porcelain").stdout.strip()
    if dirty:
        return {
            "ok": False,
            "error": "You have uncommitted local changes in the extension "
                     "folder — commit or stash them first, then update.",
        }

    fetch = git("fetch", "origin", "main", timeout=120)
    if fetch.returncode != 0:
        return {"ok": False,
                "error": "git fetch failed: " + fetch.stderr.strip()[:400]}

    merge = git("merge", "--ff-only", "origin/main")
    if merge.returncode != 0:
        return {
            "ok": False,
            "error": "Local branch has diverged from GitHub (fast-forward "
                     "not possible): " + merge.stderr.strip()[:300],
        }

    after = git("rev-parse", "HEAD").stdout.strip()
    return {
        "ok": True,
        "updated": after != before.stdout.strip(),
        "sha": after,
        "output": merge.stdout.strip()[:400],
    }


def log_crash(exc):
    """Chrome swallows the host's stderr — keep a breadcrumb on disk."""
    try:
        import datetime
        import traceback
        with open("/tmp/gpm-native-host.log", "a") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now(),
                                   "".join(traceback.format_exception(
                                       type(exc), exc, exc.__traceback__))))
    except Exception:
        pass


def main():
    while True:
        try:
            msg = read_message()
        except Exception as e:
            log_crash(e)
            return
        if msg is None:
            return
        cmd = (msg or {}).get("cmd")
        try:
            if cmd == "status":
                send_message(cmd_status())
            elif cmd == "pull":
                send_message(cmd_pull())
            else:
                send_message({"ok": False, "error": "Unknown command: %r" % cmd})
        except Exception as e:
            send_message({"ok": False, "error": str(e)[:400]})


if __name__ == "__main__":
    main()
