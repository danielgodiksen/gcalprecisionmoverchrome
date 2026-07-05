/* GCal Precision Mover — toolbar popup: manual update check */

"use strict";

const $ = (id) => document.getElementById(id);

async function bg(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res && res.error) throw new Error(res.error);
  return res;
}

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
