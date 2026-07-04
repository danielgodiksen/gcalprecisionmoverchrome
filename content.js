/* GCal Precision Mover — content script
 *
 * Interactions (all namespaced behind the Alt key so normal GCal behavior is untouched):
 *   Alt+drag an event (day/week view)  -> move it in 1-minute increments, live time tooltip.
 *                                         If the dragged event is part of the current
 *                                         selection, the WHOLE selection moves together.
 *   Alt+click events                   -> multi-select; a bulk-shift panel appears
 *   Alt+ArrowUp / Alt+ArrowDown        -> nudge every selected event ±1 min (hold Shift: ±5 min)
 *   Escape                             -> cancel an in-progress precision drag / clear selection
 *
 * All time changes are committed through the Google Calendar API (background script),
 * so they are exact to the minute — Google Calendar's own 15-minute drag snap never applies.
 */

"use strict";

// Chrome build: alias the WebExtension namespace (Chrome MV3 APIs are promise-based).
const browser = globalThis.browser ?? chrome;

// ---------------------------------------------------------------------------
// Event identification
// ---------------------------------------------------------------------------

/** Decode GCal's data-eventid attribute -> { eventId, calendarId } or null. */
function decodeEventId(raw) {
  if (!raw) return null;
  try {
    let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = atob(b64);
    const parts = decoded.split(" ");
    if (parts.length >= 2) {
      return { eventId: parts[0], calendarId: parts[1] };
    }
    if (parts.length === 1 && parts[0]) {
      return { eventId: parts[0], calendarId: "primary" };
    }
  } catch (_) {
    /* not base64 — e.g. task chips; ignore */
  }
  return null;
}

function findChip(target) {
  const el = target instanceof Element ? target.closest("[data-eventid]") : null;
  if (!el) return null;
  const ids = decodeEventId(el.getAttribute("data-eventid"));
  if (!ids) return null;
  return { el, ...ids, raw: el.getAttribute("data-eventid") };
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

async function bg(msg) {
  const res = await browser.runtime.sendMessage(msg);
  if (res && res.error) throw new Error(res.error);
  return res;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastEl = null;
let toastTimer = null;
function toast(text, ms = 3500) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "gpm-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("gpm-toast--visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("gpm-toast--visible"), ms);
}

// ---------------------------------------------------------------------------
// Selection state + bulk panel
// ---------------------------------------------------------------------------

const selection = new Map(); // raw data-eventid -> { eventId, calendarId }
let panel = null;

function remarkSelection() {
  document.querySelectorAll(".gpm-selected").forEach((el) => {
    if (!selection.has(el.getAttribute("data-eventid"))) el.classList.remove("gpm-selected");
  });
  for (const raw of selection.keys()) {
    document
      .querySelectorAll(`[data-eventid="${CSS.escape(raw)}"]`)
      .forEach((el) => el.classList.add("gpm-selected"));
  }
}

// GCal re-renders constantly; keep selection highlights alive.
const observer = new MutationObserver(() => {
  if (selection.size) {
    clearTimeout(observer._t);
    observer._t = setTimeout(remarkSelection, 150);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

function toggleSelect(chip) {
  if (selection.has(chip.raw)) {
    selection.delete(chip.raw);
  } else {
    selection.set(chip.raw, { eventId: chip.eventId, calendarId: chip.calendarId });
  }
  remarkSelection();
  renderPanel();
}

function clearSelection() {
  selection.clear();
  remarkSelection();
  renderPanel();
}

function renderPanel() {
  if (selection.size === 0) {
    if (panel) panel.remove();
    panel = null;
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "gpm-panel";
    panel.innerHTML = `
      <div class="gpm-panel__head">
        <span class="gpm-panel__count"></span>
        <button class="gpm-btn gpm-btn--ghost" data-act="clear" title="Clear selection (Esc)">Clear</button>
      </div>
      <div class="gpm-panel__row gpm-panel__row--fields">
        <label>Days <input type="number" step="1" value="0" data-f="d"></label>
        <label>Hours <input type="number" step="1" value="0" data-f="h"></label>
        <label>Min <input type="number" step="1" value="0" data-f="m"></label>
      </div>
      <div class="gpm-panel__row">
        <button class="gpm-btn gpm-btn--primary" data-act="apply">Shift selected</button>
      </div>
      <div class="gpm-panel__row gpm-panel__nudge">
        <span>Nudge</span>
        <button class="gpm-btn" data-nudge="-5">−5m</button>
        <button class="gpm-btn" data-nudge="-1">−1m</button>
        <button class="gpm-btn" data-nudge="1">+1m</button>
        <button class="gpm-btn" data-nudge="5">+5m</button>
      </div>
      <div class="gpm-panel__hint">Alt+drag a selected event to move the whole selection · Alt+↑/↓ nudges 1 min</div>
    `;
    document.body.appendChild(panel);
    panel.addEventListener("click", onPanelClick);
  }
  panel.querySelector(".gpm-panel__count").textContent =
    `${selection.size} event${selection.size === 1 ? "" : "s"} selected`;
}

async function onPanelClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.act === "clear") return clearSelection();
  if (btn.dataset.act === "apply") {
    const d = parseInt(panel.querySelector('[data-f="d"]').value || "0", 10);
    const h = parseInt(panel.querySelector('[data-f="h"]').value || "0", 10);
    const m = parseInt(panel.querySelector('[data-f="m"]').value || "0", 10);
    const delta = d * 1440 + h * 60 + m;
    if (!delta) return toast("Enter a non-zero shift first.");
    return shiftSelected(delta);
  }
  if (btn.dataset.nudge) {
    return shiftSelected(parseInt(btn.dataset.nudge, 10));
  }
}

let busy = false;
async function shiftSelected(deltaMinutes) {
  if (busy) return;
  if (selection.size === 0) return;
  busy = true;
  const items = [...selection.values()];
  let done = 0;
  let skipped = 0;
  toast(`Shifting ${items.length} event(s) by ${deltaMinutes} min…`, 60000);
  try {
    for (const it of items) {
      const res = await bg({ type: "shiftEvent", ...it, deltaMinutes });
      if (res.skipped) skipped++;
      else done++;
      toast(`Shifting… ${done + skipped}/${items.length}`, 60000);
    }
    toast(
      `Done: ${done} moved${skipped ? `, ${skipped} skipped (all-day / sub-day shift)` : ""}. ` +
        `Calendar view updates within a few seconds.`
    );
  } catch (err) {
    toast(`Error after ${done} moved: ${err.message}`, 8000);
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// Precision drag (Alt+drag, 1-minute snapping, group-aware)
// ---------------------------------------------------------------------------

let drag = null; // active drag state
let tooltip = null;
let suppressNextClickUntil = 0;

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function ensureTooltip() {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "gpm-tooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

/** Height of the full-day column the chip sits in -> px per minute, or null. */
function pxPerMinuteFor(el) {
  let node = el.offsetParent;
  let best = null;
  for (let i = 0; node && i < 6; i++) {
    const h = node.offsetHeight;
    if (h > 500) {
      best = h;
      break;
    }
    node = node.offsetParent;
  }
  if (!best) return null;
  return best / 1440;
}

/** All DOM chips belonging to the drag group (the selection, or just the grabbed chip). */
function collectGroupEls(chip, groupRaws) {
  const els = new Set();
  for (const raw of groupRaws) {
    document
      .querySelectorAll(`[data-eventid="${CSS.escape(raw)}"]`)
      .forEach((el) => els.add(el));
  }
  els.add(chip.el);
  return [...els];
}

function startDragTracking(chip, downEvent) {
  const isGroupDrag = selection.has(chip.raw) && selection.size > 1;
  const groupRaws = isGroupDrag ? [...selection.keys()] : [chip.raw];
  drag = {
    chip,
    isGroupDrag,
    groupRaws,
    groupEls: collectGroupEls(chip, groupRaws),
    startY: downEvent.clientY,
    startX: downEvent.clientX,
    ppm: pxPerMinuteFor(chip.el), // null => month view / all-day row
    moved: false,
    deltaMin: 0,
    eventData: null,
    eventPromise: bg({ type: "getEvent", calendarId: chip.calendarId, eventId: chip.eventId })
      .then((ev) => (drag && drag.chip === chip ? (drag.eventData = ev) : null))
      .catch(() => null),
  };
  window.addEventListener("mousemove", onDragMove, true);
  window.addEventListener("mouseup", onDragUp, true);
}

function onDragMove(e) {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  const dx = e.clientX - drag.startX;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return; // still a click, not a drag

  if (!drag.moved) {
    drag.moved = true;
    if (!drag.ppm) {
      toast("Precision drag works on timed events in Day/Week view. (Use the panel to shift by days.)");
      cancelDrag();
      return;
    }
    drag.groupEls.forEach((el) => el.classList.add("gpm-dragging"));
  }

  e.preventDefault();
  e.stopImmediatePropagation();

  drag.deltaMin = Math.round(dy / drag.ppm);
  const px = drag.deltaMin * drag.ppm;
  drag.groupEls.forEach((el) => (el.style.transform = `translateY(${px}px)`));

  const tip = ensureTooltip();
  tip.style.left = `${e.clientX + 14}px`;
  tip.style.top = `${e.clientY + 14}px`;
  tip.classList.add("gpm-tooltip--visible");

  const sign = drag.deltaMin >= 0 ? "+" : "−";
  const deltaTxt = `${sign}${Math.abs(drag.deltaMin)} min`;
  const groupTxt = drag.isGroupDrag ? ` · ${drag.groupRaws.length} events` : "";

  const ev = drag.eventData;
  if (ev && ev.start && ev.start.dateTime) {
    const start = new Date(ev.start.dateTime);
    const end = new Date(ev.end.dateTime);
    start.setMinutes(start.getMinutes() + drag.deltaMin);
    end.setMinutes(end.getMinutes() + drag.deltaMin);
    tip.textContent = `${fmtTime(start)} – ${fmtTime(end)}  (${deltaTxt})${groupTxt}`;
  } else {
    tip.textContent = `${deltaTxt}${groupTxt}`;
  }
}

async function onDragUp(e) {
  if (!drag) return;
  const d = drag;
  window.removeEventListener("mousemove", onDragMove, true);
  window.removeEventListener("mouseup", onDragUp, true);

  if (!d.moved) {
    // Alt+click without movement -> selection toggle.
    drag = null;
    suppressNextClickUntil = Date.now() + 400;
    toggleSelect(d.chip);
    return;
  }

  e.preventDefault();
  e.stopImmediatePropagation();
  suppressNextClickUntil = Date.now() + 400;
  if (tooltip) tooltip.classList.remove("gpm-tooltip--visible");
  d.groupEls.forEach((el) => el.classList.remove("gpm-dragging"));
  drag = null;

  const clearVisuals = () =>
    setTimeout(() => d.groupEls.forEach((el) => (el.style.transform = "")), 2500);

  if (d.deltaMin === 0) {
    d.groupEls.forEach((el) => (el.style.transform = ""));
    return;
  }

  try {
    if (d.isGroupDrag) {
      // Whole selection moves by the dragged delta; shiftSelected handles
      // progress toasts and per-event errors.
      await shiftSelected(d.deltaMin);
    } else {
      toast(`Moving by ${d.deltaMin > 0 ? "+" : ""}${d.deltaMin} min…`, 30000);
      await d.eventPromise;
      if (d.eventData && !d.eventData.start?.dateTime) {
        toast("That's an all-day event — precision drag applies to timed events.");
        d.groupEls.forEach((el) => (el.style.transform = ""));
        return;
      }
      await bg({
        type: "shiftEvent",
        calendarId: d.chip.calendarId,
        eventId: d.chip.eventId,
        deltaMinutes: d.deltaMin,
      });
      toast(`Moved ${d.deltaMin > 0 ? "+" : ""}${d.deltaMin} min. View syncs in a moment.`);
    }
  } catch (err) {
    toast(`Move failed: ${err.message}`, 8000);
  } finally {
    // Leave the ghost offset briefly so chips don't jump back before GCal repaints.
    clearVisuals();
  }
}

function cancelDrag() {
  if (!drag) return;
  window.removeEventListener("mousemove", onDragMove, true);
  window.removeEventListener("mouseup", onDragUp, true);
  drag.groupEls.forEach((el) => {
    el.classList.remove("gpm-dragging");
    el.style.transform = "";
  });
  if (tooltip) tooltip.classList.remove("gpm-tooltip--visible");
  drag = null;
}

// ---------------------------------------------------------------------------
// Global listeners
// ---------------------------------------------------------------------------

document.addEventListener(
  "mousedown",
  (e) => {
    if (!e.altKey || e.button !== 0) return;
    const chip = findChip(e.target);
    if (!chip) return;
    // Keep GCal's own drag/open logic out of the way while Alt is held.
    e.preventDefault();
    e.stopImmediatePropagation();
    startDragTracking(chip, e);
  },
  true
);

// Swallow the click GCal would otherwise use to open the event bubble.
document.addEventListener(
  "click",
  (e) => {
    if (Date.now() < suppressNextClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") {
      if (drag) {
        cancelDrag();
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (selection.size) {
        clearSelection();
      }
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && selection.size) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const step = e.shiftKey ? 5 : 1;
      shiftSelected(e.key === "ArrowUp" ? -step : step);
    }
  },
  true
);

// First-run auth nudge.
(async () => {
  const { clientId } = await browser.storage.local.get("clientId");
  if (!clientId) {
    toast(
      "GCal Precision Mover: set your OAuth Client ID in the extension options (see README) to enable moving events.",
      8000
    );
  }
})();
