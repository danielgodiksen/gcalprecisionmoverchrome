/* GCal Precision Mover — toolbar popup: manual update check + notification settings */

"use strict";

const $ = (id) => document.getElementById(id);

async function bg(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  // Only treat `error` as fatal for router-level failures ({ error } with no
  // `ok`). Handlers return structured results like { ok: false, helperMissing,
  // error } that callers must inspect (e.g. to show setup instructions).
  if (res && res.error && res.ok === undefined) throw new Error(res.error);
  return res;
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

let latestSeen = null;

const REPO_URL = "https://github.com/danielgodiksen/gcalprecisionmoverchrome";
const SETUP_CMD =
  "cd <extension folder> && bash native-host/install.sh";

function setStatus(text, cls) {
  const status = $("status");
  status.classList.remove("update", "error", "good");
  if (cls) status.classList.add(cls);
  status.textContent = text;
}

function render(st) {
  $("setup").classList.add("hidden");
  if (st.updateAvailable) {
    latestSeen = st.latest;
    setStatus(`Version ${st.latest} is available on GitHub.`, "update");
    $("update").classList.remove("hidden");
    $("footer").classList.remove("hidden");
  } else {
    const gh = st.latest ? `GitHub has ${st.latest}` : "no version info yet";
    setStatus(
      st.lastCheck
        ? `Up to date (${gh}, checked ${new Date(st.lastCheck).toLocaleTimeString()}).`
        : `Up to date (${gh}).`
    );
    $("update").classList.add("hidden");
    $("footer").classList.add("hidden");
  }
}

$("current").textContent = chrome.runtime.getManifest().version;
$("setup-cmd").textContent = SETUP_CMD;

$("check").addEventListener("click", async () => {
  const btn = $("check");
  btn.disabled = true;
  setStatus("Checking…");
  try {
    render(await bg({ type: "updateCheckNow" }));
  } catch (e) {
    setStatus("Check failed — are you offline?", "error");
  } finally {
    btn.disabled = false;
  }
});

// One-click update: git pull via the native helper, then the extension
// reloads itself (which closes this popup with the new version installed).
$("update").addEventListener("click", async () => {
  const btn = $("update");
  btn.disabled = true;
  setStatus("Updating…", "update");
  try {
    const res = await bg({ type: "updateNow" });
    if (res.ok && res.updated) {
      setStatus("Updated ✓ — reloading extension…", "good");
      return; // popup dies with the reload; that's expected
    }
    if (res.ok && !res.updated) {
      setStatus("Code already matches GitHub — reload the extension if needed.", "good");
      return;
    }
    if (res.helperMissing) {
      setStatus("Update helper not installed yet (one-time setup).", "error");
      $("setup").classList.remove("hidden");
    } else {
      setStatus(res.error || "Update failed.", "error");
    }
  } catch (e) {
    setStatus(String(e.message || e), "error");
  } finally {
    btn.disabled = false;
  }
});

$("view").addEventListener("click", async () => {
  try {
    await bg({ type: "updateViewChanges" });
  } catch (_) {
    chrome.tabs.create({ url: `${REPO_URL}/commits/main` });
  }
  window.close();
});

$("copy-cmd").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(SETUP_CMD);
    $("copy-cmd").textContent = "Copied ✓";
    setTimeout(() => ($("copy-cmd").textContent = "Copy command"), 1500);
  } catch (_) {}
});

$("open-gh").addEventListener("click", () => {
  chrome.tabs.create({ url: REPO_URL });
  window.close();
});

// Open the extension's options page (OAuth Client ID / sign-in setup).
$("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$("skip").addEventListener("click", async () => {
  if (latestSeen) {
    try {
      await bg({ type: "updateDismiss", version: latestSeen });
    } catch (_) {}
  }
  window.close();
});

// Show cached status on open (no network) — instant feedback.
(async () => {
  try {
    render(await bg({ type: "updateStatus" }));
  } catch (_) {}
})();

// ---------------------------------------------------------------------------
// Install from a pasted GitHub link (manual)
// ---------------------------------------------------------------------------

function setLinkStatus(text, cls) {
  const el = $("link-status");
  el.classList.remove("update", "error", "good");
  if (cls) el.classList.add(cls);
  el.textContent = text;
}

// Restore the last link typed, for convenience.
chrome.storage.local
  .get("gpmInstallLink")
  .then(({ gpmInstallLink }) => {
    if (gpmInstallLink) $("link-url").value = gpmInstallLink;
  })
  .catch(() => {});

$("install-link").addEventListener("click", async () => {
  const url = $("link-url").value.trim();
  if (!url) {
    setLinkStatus("Paste a GitHub link first.", "error");
    return;
  }
  chrome.storage.local.set({ gpmInstallLink: url }).catch(() => {});

  const btn = $("install-link");
  btn.disabled = true;
  setLinkStatus("Installing…", "update");
  try {
    const res = await bg({ type: "updateFromLink", url });
    if (res.ok && res.updated) {
      setLinkStatus(
        `Installed ${res.label || "that version"} ✓ — reloading extension…`,
        "good"
      );
      return; // popup dies with the reload; that's expected
    }
    if (res.ok && !res.updated) {
      setLinkStatus(
        `Already on ${res.label || "that version"} — nothing to install.`,
        "good"
      );
      return;
    }
    if (res.helperMissing) {
      setLinkStatus("Update helper not installed yet (one-time setup).", "error");
      $("setup").classList.remove("hidden");
    } else {
      setLinkStatus(res.error || "Install failed.", "error");
    }
  } catch (e) {
    setLinkStatus(String(e.message || e), "error");
  } finally {
    btn.disabled = false;
  }
});

// Enter in the field triggers the install.
$("link-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("install-link").click();
  }
});

// ---------------------------------------------------------------------------
// Notification settings (auto-saved to chrome.storage.local as gpmNotifSettings)
// ---------------------------------------------------------------------------

const NOTIF_DEFAULTS = {
  sound: true, // play beep.wav with reminder notifications
  updateNotify: true, // system notification when a new version is on GitHub
  updateBanner: true, // banner inside Google Calendar
  defLeads: "5,0", // default "alert before start" for new watches
  defFocusEvery: 0, // default focus-ping interval (0 = off)
  defFollowUp: false, // default "prompt follow-up when the event ends"
  defFollowUpMin: 30, // default follow-up block length
  dialogBackdropClose: false, // close the reminders dialog by clicking its backdrop
};

async function loadSettings() {
  const { gpmNotifSettings } = await chrome.storage.local.get("gpmNotifSettings");
  return { ...NOTIF_DEFAULTS, ...(gpmNotifSettings || {}) };
}

function readForm() {
  const leads = $("s-leads")
    .value.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return {
    sound: $("s-sound").checked,
    updateNotify: $("s-upd-notify").checked,
    updateBanner: $("s-upd-banner").checked,
    defLeads: (leads.length ? leads : [5, 0]).join(","),
    defFocusEvery: Math.max(0, parseInt($("s-focus").value, 10) || 0),
    defFollowUp: $("s-fu").checked,
    defFollowUpMin: Math.max(5, parseInt($("s-fumin").value, 10) || 30),
    dialogBackdropClose: $("s-backdrop").checked,
  };
}

function fillForm(s) {
  $("s-sound").checked = s.sound;
  $("s-upd-notify").checked = s.updateNotify;
  $("s-upd-banner").checked = s.updateBanner;
  $("s-leads").value = s.defLeads;
  $("s-focus").value = s.defFocusEvery;
  $("s-fu").checked = s.defFollowUp;
  $("s-fumin").value = s.defFollowUpMin;
  $("s-backdrop").checked = s.dialogBackdropClose;
  syncFollowUpField();
}

// The follow-up length only applies while the follow-up prompt is on.
function syncFollowUpField() {
  const on = $("s-fu").checked;
  $("s-fumin").disabled = !on;
  $("fumin-field").classList.toggle("disabled", !on);
}

let savedTimer = null;
async function saveSettings() {
  await chrome.storage.local.set({ gpmNotifSettings: readForm() });
  const el = $("saved");
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1500);
}

(async () => {
  fillForm(await loadSettings());
  for (const id of ["s-sound", "s-upd-notify", "s-upd-banner", "s-fu", "s-backdrop"]) {
    $(id).addEventListener("change", saveSettings);
  }
  $("s-fu").addEventListener("change", syncFollowUpField);
  for (const id of ["s-leads", "s-focus", "s-fumin"]) {
    $(id).addEventListener("change", saveSettings);
  }
})();
