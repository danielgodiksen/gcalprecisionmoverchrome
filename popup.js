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

function render(st) {
  const status = $("status");
  status.classList.remove("update", "error");
  if (st.updateAvailable) {
    latestSeen = st.latest;
    status.textContent = `Version ${st.latest} is available on GitHub.`;
    status.classList.add("update");
    $("open").classList.remove("hidden");
    $("footer").classList.remove("hidden");
  } else {
    status.textContent = st.lastCheck
      ? `Up to date (checked ${new Date(st.lastCheck).toLocaleTimeString()}).`
      : "Up to date.";
    $("open").classList.add("hidden");
    $("footer").classList.add("hidden");
  }
}

$("current").textContent = chrome.runtime.getManifest().version;

$("check").addEventListener("click", async () => {
  const btn = $("check");
  const status = $("status");
  btn.disabled = true;
  status.classList.remove("update", "error");
  status.textContent = "Checking…";
  try {
    render(await bg({ type: "updateCheckNow" }));
  } catch (e) {
    status.textContent = "Check failed — are you offline?";
    status.classList.add("error");
  } finally {
    btn.disabled = false;
  }
});

$("open").addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://github.com/danielgodiksen/gcalprecisionmoverchrome",
  });
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
