"use strict";

const RT = globalThis.browser ?? chrome;
const key = new URLSearchParams(location.search).get("key");
const info = document.getElementById("info");
const controls = document.getElementById("controls");
const status = document.getElementById("status");

function fmt(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", hour: "2-digit", minute: "2-digit",
  });
}

async function init() {
  const res = await RT.runtime.sendMessage({ type: "getFollowup", key });
  if (!res || res.error || !res.followup) {
    info.textContent = "This follow-up prompt has already been handled.";
    return;
  }
  info.textContent = `"${res.followup.summary}" has ended. Schedule a follow-up block?`;
  document.getElementById("dur").value = String(res.followup.durationMin || 30);
  controls.hidden = false;
}

document.getElementById("accept").addEventListener("click", async () => {
  status.textContent = "Finding a free slot…";
  const durationMin = parseInt(document.getElementById("dur").value, 10);
  const res = await RT.runtime.sendMessage({ type: "acceptFollowup", key, durationMin });
  if (res && res.ok) {
    status.textContent = `Booked: ${fmt(res.start)} – ${fmt(res.end)} on your primary calendar.`;
    status.style.color = "#188038";
    controls.hidden = true;
  } else {
    status.textContent = res?.error || "Scheduling failed.";
    status.style.color = "#d93025";
  }
});

document.getElementById("dismiss").addEventListener("click", async () => {
  await RT.runtime.sendMessage({ type: "dismissFollowup", key });
  status.textContent = "Dismissed.";
  controls.hidden = true;
});

init();
