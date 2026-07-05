/* GCal Precision Mover — toolbar popup: manual update check + notification settings */

"use strict";

const $ = (id) => document.getElementById(id);

async function bg(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res && res.error) throw new Error(res.error);
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
  for (const id of ["s-sound", "s-upd-notify", "s-upd-banner", "s-fu"]) {
    $(id).addEventListener("change", saveSettings);
  }
  for (const id of ["s-leads", "s-focus", "s-fumin"]) {
    $(id).addEventListener("change", saveSettings);
  }
})();
