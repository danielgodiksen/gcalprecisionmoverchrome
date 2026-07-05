"use strict";
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "gpm-play-sound") {
    new Audio(chrome.runtime.getURL("beep.wav")).play().catch(() => {});
  }
});
