/* GCal Precision Mover — GitHub update checker
 *
 * Loaded after background.js/reminders.js in the same service-worker scope,
 * so it extends the shared `handlers` map defined in background.js.
 *
 * How it works: every 6 hours (and shortly after the worker wakes) it fetches
 * manifest.json from the repo's main branch on GitHub and compares the version
 * against the installed one. If GitHub is newer, it fires a Chrome
 * notification ("Open GitHub" / "Skip this version") once per version, and the
 * content script shows a banner in Google Calendar (via the updateStatus
 * handler) until the version is updated or skipped.
 */

"use strict";

const GPM_UPD = {
  RAW_MANIFEST:
    "https://raw.githubusercontent.com/danielgodiksen/gcalprecisionmoverchrome/main/manifest.json",
  REPO_URL: "https://github.com/danielgodiksen/gcalprecisionmoverchrome",
  ALARM: "gpm-upd-check",
  PERIOD_MIN: 360, // check every 6 hours
  NOTIF_PREFIX: "gpm-upd|",
};

/** Compare dotted versions: 1 if a > b, -1 if a < b, 0 if equal. */
function gpmCmpVer(a, b) {
  const pa = String(a || "").split(".");
  const pb = String(b || "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function gpmUpdState() {
  try {
    const { gpmUpdate } = await chrome.storage.local.get("gpmUpdate");
    return gpmUpdate || {};
  } catch (_) {
    return {};
  }
}

async function gpmUpdSave(patch) {
  const st = await gpmUpdState();
  await chrome.storage.local.set({ gpmUpdate: { ...st, ...patch } });
}

/** Fetch the manifest on main and, if newer, notify (once per version). */
async function gpmCheckForUpdate() {
  let latest;
  try {
    const res = await fetch(`${GPM_UPD.RAW_MANIFEST}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    latest = (await res.json()).version;
  } catch (_) {
    return; // offline / GitHub hiccup — try again on the next alarm
  }
  if (!latest) return;

  await gpmUpdSave({ latest, lastCheck: Date.now() });

  const current = chrome.runtime.getManifest().version;
  if (gpmCmpVer(latest, current) <= 0) return;

  const st = await gpmUpdState();
  if (st.dismissed === latest) return; // user chose "skip this version"
  if (st.notified === latest) return; // already notified for this version

  // Respect the "system notification for updates" toggle (default: on).
  try {
    const { gpmNotifSettings } = await chrome.storage.local.get("gpmNotifSettings");
    if (gpmNotifSettings && gpmNotifSettings.updateNotify === false) return;
  } catch (_) {}

  await gpmUpdSave({ notified: latest });
  chrome.notifications.create(GPM_UPD.NOTIF_PREFIX + latest, {
    type: "basic",
    iconUrl: "icons/icon96.png",
    title: "GCal Precision Mover update available",
    message: `Version ${latest} is on GitHub (you have ${current}). Update now?`,
    buttons: [{ title: "Open GitHub" }, { title: "Skip this version" }],
    priority: 1,
    requireInteraction: true,
  });
}

// Notification interactions -------------------------------------------------

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith(GPM_UPD.NOTIF_PREFIX)) return;
  chrome.tabs.create({ url: GPM_UPD.REPO_URL });
  chrome.notifications.clear(id);
});

chrome.notifications.onButtonClicked.addListener(async (id, btnIdx) => {
  if (!id.startsWith(GPM_UPD.NOTIF_PREFIX)) return;
  const ver = id.slice(GPM_UPD.NOTIF_PREFIX.length);
  if (btnIdx === 0) {
    chrome.tabs.create({ url: GPM_UPD.REPO_URL });
  } else {
    await gpmUpdSave({ dismissed: ver });
  }
  chrome.notifications.clear(id);
});

// Content-script API (banner in Google Calendar) ------------------------------

Object.assign(handlers, {
  /** Report whether a newer version exists (refreshes if the check is stale). */
  async updateStatus() {
    const st = await gpmUpdState();
    if (!st.lastCheck || Date.now() - st.lastCheck > GPM_UPD.PERIOD_MIN * 60_000) {
      await gpmCheckForUpdate();
    }
    const fresh = await gpmUpdState();
    const current = chrome.runtime.getManifest().version;
    const updateAvailable =
      !!fresh.latest &&
      gpmCmpVer(fresh.latest, current) > 0 &&
      fresh.dismissed !== fresh.latest;
    let showBanner = true;
    try {
      const { gpmNotifSettings } = await chrome.storage.local.get("gpmNotifSettings");
      if (gpmNotifSettings && gpmNotifSettings.updateBanner === false) showBanner = false;
    } catch (_) {}
    return {
      ok: true,
      updateAvailable,
      latest: fresh.latest,
      current,
      lastCheck: fresh.lastCheck,
      showBanner,
      url: GPM_UPD.REPO_URL,
    };
  },

  /** Manual check from the toolbar popup: always hits GitHub. */
  async updateCheckNow() {
    await gpmCheckForUpdate();
    return handlers.updateStatus();
  },

  /** "Skip this version" from the in-page banner. */
  async updateDismiss({ version }) {
    await gpmUpdSave({ dismissed: version });
    return { ok: true };
  },
});

// Scheduling ------------------------------------------------------------------

chrome.alarms.create(GPM_UPD.ALARM, {
  delayInMinutes: 1,
  periodInMinutes: GPM_UPD.PERIOD_MIN,
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === GPM_UPD.ALARM) gpmCheckForUpdate();
});
