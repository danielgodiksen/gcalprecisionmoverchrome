#!/usr/bin/env python3
"""GCal Precision Mover — native messaging host.

Launched by Chrome when the extension calls
chrome.runtime.sendNativeMessage("com.danielgodiksen.gpm_updater", ...).

Commands (JSON over Chrome's native messaging protocol):
  {"cmd": "status"}  -> { ok, sha, shortSha, branch, dirty, repo }
  {"cmd": "pull"}    -> { ok, updated, sha, output } | { ok: false, error }
  {"cmd": "checkout_ref", "ref": "...", "refType": "branch|tag|commit|default"}
       -> { ok, updated, sha, shortSha, method, ref } | { ok: false, error }
       Fetches from origin and moves the working tree to exactly that ref
       (fast-forward when possible, hard reset otherwise). Powers the popup's
       "install from a pasted GitHub link" field.

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


def _resolve_default_target():
    """Return the ref name of origin's default branch (e.g. 'origin/main')."""
    sh = git("symbolic-ref", "refs/remotes/origin/HEAD")
    if sh.returncode != 0:
        git("remote", "set-head", "origin", "-a")  # ask origin what HEAD is
        sh = git("symbolic-ref", "refs/remotes/origin/HEAD")
    if sh.returncode == 0 and sh.stdout.strip():
        # refs/remotes/origin/main -> origin/main
        return sh.stdout.strip().replace("refs/remotes/", "", 1)
    return "origin/main"


def cmd_checkout_ref(ref, ref_type):
    """Install exactly the ref a pasted GitHub link points to.

    Always fetches from the configured `origin` remote (the extension's own
    repo), so the field can only ever install code from that repo — a pasted
    link just selects which branch / tag / commit of it to check out.
    """
    before = git("rev-parse", "HEAD")
    if before.returncode != 0:
        return {"ok": False, "error": "Not a git repository: " + REPO}

    # Refuse to clobber uncommitted local edits (same guard as `pull`).
    if git("status", "--porcelain").stdout.strip():
        return {
            "ok": False,
            "error": "You have uncommitted local changes in the extension "
                     "folder — commit or stash them first, then install.",
        }

    # Pull down every branch + tag from origin so any reachable ref resolves.
    fetch = git("fetch", "origin", "--tags", "--prune", timeout=120)
    if fetch.returncode != 0:
        return {"ok": False,
                "error": "git fetch failed: " + fetch.stderr.strip()[:400]}

    ref = (ref or "").strip()
    ref_type = (ref_type or "default").strip()
    # Candidate targets to try, in priority order for the given ref type. Being
    # forgiving here means a /tree/<tag> link (parsed as a branch) still works,
    # and vice-versa.
    if ref_type == "default" or not ref:
        candidates = [_resolve_default_target()]
    elif ref_type == "tag":
        candidates = ["refs/tags/" + ref, "origin/" + ref, ref]
    elif ref_type == "commit":
        candidates = [ref]
    elif ref_type == "branch":
        candidates = ["origin/" + ref, "refs/tags/" + ref, ref]
    else:
        return {"ok": False, "error": "Unknown ref type: %r" % ref_type}

    # Resolve to a concrete commit so we can fast-forward/reset onto it.
    target_sha = None
    for cand in candidates:
        rev = git("rev-parse", "--verify", "--quiet", cand + "^{commit}")
        if rev.returncode == 0 and rev.stdout.strip():
            target_sha = rev.stdout.strip()
            break
    if not target_sha:
        return {
            "ok": False,
            "error": "Couldn't find %s in the repo. Check the link points to "
                     "a real branch, tag or commit on origin." % (ref or candidates[0]),
        }
    before_sha = before.stdout.strip()

    if target_sha == before_sha:
        method = "up-to-date"
    else:
        # Fast-forward only when HEAD is an ancestor of the target (moving
        # strictly forward keeps us on a branch cleanly). For an older or
        # diverged ref — including rewinding to a past commit, where a
        # `--ff-only` merge is a silent no-op — hard reset so the working tree
        # becomes EXACTLY the requested ref.
        can_ff = git("merge-base", "--is-ancestor", before_sha, target_sha).returncode == 0
        if can_ff:
            ff = git("merge", "--ff-only", target_sha)
            if ff.returncode != 0:
                can_ff = False
            else:
                method = "fast-forward"
        if not can_ff:
            reset = git("reset", "--hard", target_sha)
            if reset.returncode != 0:
                return {"ok": False,
                        "error": "git reset failed: " + reset.stderr.strip()[:400]}
            method = "reset"

    after = git("rev-parse", "HEAD").stdout.strip()
    return {
        "ok": True,
        "updated": after != before_sha,
        "sha": after,
        "shortSha": after[:7],
        "method": method,
        "ref": ref or "default branch",
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
            elif cmd == "checkout_ref":
                send_message(cmd_checkout_ref(
                    (msg or {}).get("ref"), (msg or {}).get("refType")))
            else:
                send_message({"ok": False, "error": "Unknown command: %r" % cmd})
        except Exception as e:
            send_message({"ok": False, "error": str(e)[:400]})


if __name__ == "__main__":
    main()
