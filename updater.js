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
  // GitHub API: always fresh (raw.githubusercontent.com is CDN-cached and can
  // serve a stale manifest for several minutes after a push).
  API_MANIFEST:
    "https://api.github.com/repos/danielgodiksen/gcalprecisionmoverchrome/contents/manifest.json?ref=main",
  RAW_MANIFEST:
    "https://raw.githubusercontent.com/danielgodiksen/gcalprecisionmoverchrome/main/manifest.json",
  REPO_URL: "https://github.com/danielgodiksen/gcalprecisionmoverchrome",
  ALARM: "gpm-upd-check",
  PERIOD_MIN: 360, // check every 6 hours
  NOTIF_PREFIX: "gpm-upd|",
  // Native messaging host (native-host/install.sh registers it): lets the
  // extension run `git pull` in its own folder for true one-click updates.
  NATIVE_HOST: "com.danielgodiksen.gpm_updater",
};

/** Talk to the local update helper. Rejects if it isn't installed. */
function gpmNative(cmd) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(GPM_UPD.NATIVE_HOST, { cmd }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!res || res.ok === false) {
          reject(new Error((res && res.error) || "Update helper failed."));
        } else {
          resolve(res);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

function gpmHostMissing(e) {
  return /native messaging host|not found|forbidden/i.test(String(e && e.message));
}

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

/** Get the version on main: GitHub API first (fresh), raw CDN as fallback. */
async function gpmFetchLatestVersion() {
  try {
    const res = await fetch(GPM_UPD.API_MANIFEST, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    if (res.ok) {
      const v = (await res.json()).version;
      if (v) return v;
    }
  } catch (_) {}
  try {
    // Fallback (e.g. API rate-limited): may lag a few minutes behind a push.
    const res = await fetch(`${GPM_UPD.RAW_MANIFEST}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (res.ok) return (await res.json()).version;
  } catch (_) {}
  return null; // offline / GitHub hiccup — try again on the next alarm
}

/** Fetch the manifest on main and, if newer, notify (once per version). */
async function gpmCheckForUpdate() {
  const latest = await gpmFetchLatestVersion();
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

  /**
   * One-click update: git pull via the native helper, then reload the
   * extension so Chrome picks up the new files. Responds BEFORE reloading so
   * the popup/banner can show feedback (reload kills all extension pages).
   */
  async updateNow() {
    let res;
    try {
      res = await gpmNative("pull");
    } catch (e) {
      return {
        ok: false,
        helperMissing: gpmHostMissing(e),
        error: String(e.message || e),
      };
    }
    if (res.updated) {
      await gpmUpdSave({ notified: null, dismissed: null });
      setTimeout(() => chrome.runtime.reload(), 400); // let the reply land first
      return { ok: true, updated: true };
    }
    return { ok: true, updated: false }; // already at origin/main
  },

  /**
   * "View the new code": GitHub compare between the locally checked-out
   * commit and main. Falls back to the commits page if the helper is missing.
   */
  async updateViewChanges() {
    let url = `${GPM_UPD.REPO_URL}/commits/main`;
    try {
      const st = await gpmNative("status");
      if (st.sha) url = `${GPM_UPD.REPO_URL}/compare/${st.sha}...main`;
    } catch (_) {}
    chrome.tabs.create({ url });
    return { ok: true, url };
  },

  /** Is the native update helper installed? (Cheap probe for the popup.) */
  async updateHelperStatus() {
    try {
      const st = await gpmNative("status");
      return { ok: true, installed: true, sha: st.shortSha, dirty: st.dirty };
    } catch (e) {
      return {
        ok: true,
        installed: false,
        helperMissing: gpmHostMissing(e),
        error: String(e.message || e),
      };
    }
  },
});

// Auto-reload on update -------------------------------------------------------
// Goal: never keep running old code after new files land on disk.

/**
 * Unpacked/git installs: compare the manifest version ON DISK (served fresh
 * by chrome-extension://) with the version this worker was LOADED with. They
 * diverge when `git pull` ran outside the updateNow flow (manually, or via
 * the helper from another browser profile) — in that case, reload so Chrome
 * picks up the new files. Returns true when a reload was triggered.
 */
async function gpmReloadIfStale() {
  try {
    const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (!res.ok) return false;
    const diskVer = (await res.json()).version;
    if (!diskVer || gpmCmpVer(diskVer, chrome.runtime.getManifest().version) === 0) {
      return false;
    }
    // Safety valve: never reload more than once a minute, in case something
    // ever makes disk/runtime versions disagree persistently.
    const { gpmLastAutoReload } = await chrome.storage.local.get("gpmLastAutoReload");
    if (gpmLastAutoReload && Date.now() - gpmLastAutoReload < 60_000) return false;
    await chrome.storage.local.set({ gpmLastAutoReload: Date.now() });
    chrome.runtime.reload();
    return true;
  } catch (_) {
    return false;
  }
}

// Chrome-managed updates (e.g. if this ever ships via the Web Store or a
// policy install): apply the downloaded update immediately instead of letting
// the old version linger until the next browser restart.
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());

// After every install/update/reload, re-inject the content script into open
// Calendar tabs so they run the NEW code right away. The fresh copy announces
// itself and the orphaned old copy tears down (handshake in content.js) — no
// manual tab refresh, no stale scripts.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://calendar.google.com/*" });
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (_) {
      /* discarded/errored tab — it gets the new script on its next load */
    }
  }
});

// Catch stale code as soon as the worker wakes.
gpmReloadIfStale();

// Scheduling ------------------------------------------------------------------

chrome.alarms.create(GPM_UPD.ALARM, {
  delayInMinutes: 1,
  periodInMinutes: GPM_UPD.PERIOD_MIN,
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== GPM_UPD.ALARM) return;
  if (await gpmReloadIfStale()) return; // new files already on disk — just reload
  gpmCheckForUpdate();
});
