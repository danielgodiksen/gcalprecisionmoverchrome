"use strict";

// Chrome build: alias the WebExtension namespace (Chrome MV3 APIs are promise-based).
const browser = globalThis.browser ?? chrome;

const input = document.getElementById("client-id");
const status = document.getElementById("status");

document.getElementById("redirect-uri").textContent = browser.identity.getRedirectURL();

browser.storage.local.get("clientId").then(({ clientId }) => {
  if (clientId) input.value = clientId;
});

async function save() {
  const clientId = input.value.trim();
  await browser.storage.local.set({ clientId });
  status.textContent = clientId ? "Saved." : "Cleared.";
  status.style.color = "#188038";
  return clientId;
}

document.getElementById("save").addEventListener("click", save);

document.getElementById("test").addEventListener("click", async () => {
  const clientId = await save();
  if (!clientId) {
    status.textContent = "Enter a Client ID first.";
    status.style.color = "#d93025";
    return;
  }
  status.textContent = "Opening Google sign-in…";
  status.style.color = "#5f6368";
  try {
    const res = await browser.runtime.sendMessage({ type: "auth" });
    if (res && res.error) throw new Error(res.error);
    status.textContent = "Signed in — the extension can now move your events.";
    status.style.color = "#188038";
  } catch (e) {
    status.textContent = `Sign-in failed: ${e.message}`;
    status.style.color = "#d93025";
  }
});
