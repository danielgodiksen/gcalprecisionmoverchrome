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
  clearTimeout(observer._b);
  observer._b = setTimeout(scanEventBubbles, 200);
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
        <button class="gpm-btn" data-act="reminders" title="Notification reminders for selected events">🔔</button>
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
  if (btn.dataset.act === "reminders") return openReminderDialog();
  if (btn.dataset.nudge) {
    return shiftSelected(parseInt(btn.dataset.nudge, 10));
  }
}

// ---------------------------------------------------------------------------
// Reminder configuration dialog
// ---------------------------------------------------------------------------

let remDialog = null;
let remTarget = null; // set when opened from an event bubble
let remBackdropClose = false; // close on backdrop click? (configurable in the toolbar popup)

/** Inject a Reminders button into GCal's own event popup, so reminders are
 *  added exactly where GCal's native notifications live.
 *
 *  Two gotchas with GCal's popup:
 *  - The `role="dialog"` node is a positioning wrapper that can be wider than
 *    the visible card (flex layout), so a child appended to it renders as a
 *    stretched strip beside the card. Insert into the card itself: the
 *    largest direct child of the dialog.
 *  - GCal handles focus/close on `mousedown` at the document level and often
 *    re-renders the popup before a `click` can fire on injected nodes. Act on
 *    `pointerdown` and stop propagation so the popup neither closes nor eats
 *    the interaction.
 */
function scanEventBubbles() {
  document.querySelectorAll('div[role="dialog"]').forEach((dlg) => {
    if (dlg.querySelector(".gpm-bubble-btn")) return;
    const idEl = dlg.hasAttribute("data-eventid") ? dlg : dlg.querySelector("[data-eventid]");
    if (!idEl) return;
    const raw = idEl.getAttribute("data-eventid");
    const ids = decodeEventId(raw);
    if (!ids) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gpm-bubble-btn";
    btn.textContent = "🔔";
    btn.title = "Reminders (GCal Precision Mover)";
    btn.setAttribute("aria-label", "Reminders");
    const open = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openReminderDialog({ raw, eventId: ids.eventId, calendarId: ids.calendarId });
    };
    // pointerdown fires before GCal's document-level mousedown handling can
    // close/re-render the popup; keep the other handlers as inert guards.
    btn.addEventListener("pointerdown", open);
    for (const t of ["mousedown", "mouseup", "click"]) {
      btn.addEventListener(t, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }

    // Extend GCal's own action toolbar (pencil / trash / mail / kebab / X):
    // it's the row of buttons at the very top of the popup. Insert the bell
    // just before the close button's wrapper so it reads as a native action.
    const dlgRect = dlg.getBoundingClientRect();
    const headBtns = [...dlg.querySelectorAll("button")].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top - dlgRect.top < 64;
    });
    if (headBtns.length) {
      const anchor = headBtns[headBtns.length - 1]; // rightmost = close (X)
      // Climb from the close button to its top-level wrapper inside the
      // toolbar row (the row is the first ancestor holding several buttons).
      let node = anchor;
      while (
        node.parentElement &&
        node.parentElement !== dlg &&
        node.parentElement.querySelectorAll("button").length < 2
      ) {
        node = node.parentElement;
      }
      node.parentElement.insertBefore(btn, node);
    } else {
      // Fallback: small inline button at the end of the popup content.
      btn.classList.add("gpm-bubble-btn--fallback");
      btn.textContent = "🔔 Reminders";
      (dlg.firstElementChild || dlg).appendChild(btn);
    }
  });
}

async function openReminderDialog(target) {
  remTarget = target || null;
  if (remDialog) remDialog.remove();
  remDialog = document.createElement("div");
  remDialog.className = "gpm-dialog";
  remDialog.innerHTML = `
    <div class="gpm-dialog__box">
      <div class="gpm-dialog__head">
        <div class="gpm-dialog__title">Reminders</div>
        <button class="gpm-dialog__close" data-r="close" title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <div class="gpm-dialog__section">
        <div class="gpm-dialog__label">Alert before start (minutes, comma-separated; 0 = at start)</div>
        <input type="text" data-r="leads" value="5,0">
        <div class="gpm-dialog__label">Focus ping every N minutes during the event (0 = off)</div>
        <input type="number" data-r="focus" value="0" min="0" step="5">
        <label class="gpm-dialog__check">
          <input type="checkbox" data-r="fu"> Prompt me to schedule a follow-up when it ends
          (re-notifies every 30 s until clicked)
        </label>
        <div class="gpm-dialog__label">Follow-up length (minutes)</div>
        <input type="number" data-r="fumin" value="30" min="5" step="5">
      </div>
      <div class="gpm-dialog__row">
        <button class="gpm-btn gpm-btn--primary" data-r="add"></button>
        <button class="gpm-btn" data-r="test" title="Send a test notification with sound now">Test</button>
        <button class="gpm-btn" data-r="close">Close</button>
      </div>
      <div class="gpm-dialog__title" style="margin-top:14px">Watched events</div>
      <div class="gpm-dialog__list" data-r="list">Loading...</div>
      <div class="gpm-panel__hint">Recurring events are watched as a series (every occurrence notifies).
      Reminders fire while the browser is open (no Calendar tab needed).</div>
    </div>`;
  document.body.appendChild(remDialog);

  // Prefill from the notification defaults configured in the toolbar popup.
  remBackdropClose = false;
  try {
    const { gpmNotifSettings: ns } = await browser.storage.local.get("gpmNotifSettings");
    if (ns) {
      remBackdropClose = !!ns.dialogBackdropClose;
      if (ns.defLeads) remDialog.querySelector('[data-r="leads"]').value = ns.defLeads;
      if (ns.defFocusEvery != null)
        remDialog.querySelector('[data-r="focus"]').value = ns.defFocusEvery;
      remDialog.querySelector('[data-r="fu"]').checked = !!ns.defFollowUp;
      if (ns.defFollowUpMin)
        remDialog.querySelector('[data-r="fumin"]').value = ns.defFollowUpMin;
    }
  } catch (_) {}

  remDialog.querySelector('[data-r="add"]').textContent = remTarget
    ? "Watch this event"
    : `Watch ${selection.size} selected event${selection.size === 1 ? "" : "s"}`;

  remDialog.addEventListener("click", async (e) => {
    // Backdrop click only closes when the user opted in via the popup setting;
    // otherwise the dialog closes only via the ✕ / Close buttons or Esc.
    if (e.target === remDialog) {
      if (remBackdropClose) closeReminderDialog();
      return;
    }
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.r === "close") return closeReminderDialog();
    if (btn.dataset.r === "test") {
      try {
        await bg({ type: "testNotification" });
        toast("Test sent. No banner or chime? Check your OS notification settings for the browser (and Do Not Disturb / Focus Assist).", 9000);
      } catch (err) {
        toast(`Test failed: ${err.message}`, 8000);
      }
      return;
    }
    if (btn.dataset.r === "rm") {
      await bg({ type: "removeWatch", key: btn.dataset.key });
      return renderWatchList();
    }
    if (btn.dataset.r === "add") {
      const q = (sel) => remDialog.querySelector(sel);
      const config = {
        leads: q('[data-r="leads"]').value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n) && n >= 0),
        focusEvery: parseInt(q('[data-r="focus"]').value || "0", 10),
        followUp: q('[data-r="fu"]').checked,
        followUpMin: parseInt(q('[data-r="fumin"]').value || "30", 10),
      };
      if (!config.leads.length && !config.focusEvery && !config.followUp) {
        return toast("Set at least one alert, focus ping, or follow-up.");
      }
      const targets = remTarget ? [remTarget] : [...selection.values()];
      if (!targets.length) {
        return toast("Open an event or Alt+click events first.");
      }
      btn.disabled = true;
      let added = 0, skipped = 0;
      for (const it of targets) {
        try {
          const res = await bg({ type: "addWatch", ...it, config });
          if (res.skipped) skipped++; else added++;
        } catch (err) {
          toast(`Watch failed: ${err.message}`, 6000);
        }
      }
      btn.disabled = false;
      toast(`Watching ${added} event(s)${skipped ? `, ${skipped} skipped (all-day)` : ""}.`);
      renderWatchList();
    }
  });

  renderWatchList();
}

function closeReminderDialog() {
  if (remDialog) remDialog.remove();
  remDialog = null;
}

async function renderWatchList() {
  if (!remDialog) return;
  const list = remDialog.querySelector('[data-r="list"]');
  try {
    const { watches } = await bg({ type: "listWatches" });
    if (!watches.length) {
      list.textContent = "Nothing watched yet.";
      return;
    }
    list.innerHTML = "";
    for (const w of watches) {
      const row = document.createElement("div");
      row.className = "gpm-dialog__item";
      const cfg = w.config || {};
      const bits = [];
      if (cfg.leads && cfg.leads.length) bits.push(`alerts: ${cfg.leads.join(", ")}m`);
      if (cfg.focusEvery) bits.push(`focus: every ${cfg.focusEvery}m`);
      if (cfg.followUp) bits.push(`follow-up: ${cfg.followUpMin}m`);
      if (w.lastError) bits.push("⚠ " + String(w.lastError).slice(0, 60));
      row.innerHTML = `<span class="gpm-dialog__item-name"></span>
        <span class="gpm-dialog__item-meta"></span>
        <button class="gpm-btn gpm-btn--ghost" data-r="rm">✕</button>`;
      row.querySelector(".gpm-dialog__item-name").textContent =
        w.summary + (w.isRecurring ? " (recurring)" : "");
      row.querySelector(".gpm-dialog__item-meta").textContent = bits.join(" | ");
      row.querySelector("button").dataset.key = w.key;
      list.appendChild(row);
    }
  } catch (e) {
    list.textContent = `Couldn't load watches: ${e.message}`;
  }
}

let busy = false;
async function shiftSelected(deltaMinutes) {
  if (busy) return;
  if (selection.size === 0) return;
  busy = true;
  const items = [...selection.entries()];
  let done = 0;
  let skipped = 0;
  toast(`Shifting ${items.length} event(s) by ${deltaMinutes} min…`, 60000);
  try {
    for (const [raw, it] of items) {
      const res = await bg({ type: "shiftEvent", ...it, deltaMinutes });
      if (res.skipped) skipped++;
      else {
        done++;
        // Cache the exact API ids so the next shift skips resolution entirely
        // (one GET + one PATCH instead of several lookups) — much faster nudging.
        if (res.event && res.event.id) {
          selection.set(raw, {
            eventId: res.event.id,
            calendarId: res.calendarId || it.calendarId,
          });
        }
        // Move the chip immediately instead of waiting for Google's sync.
        applyOptimisticShift(raw, deltaMinutes);
      }
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
// Optimistic UI: pin chips at their new position the instant the API confirms
// a move, and release the override exactly when GCal repaints them (detected
// by the old chip node leaving the DOM — moved events get re-rendered with a
// fresh node). Google's own sync timing can't be forced; this hides it.
// ---------------------------------------------------------------------------

const pendingVisuals = new Set();

function watchAndClear(items) {
  // Accepts Elements or { el, height } records (height = original inline height
  // to restore after a resize; GCal sets chip heights inline).
  const list = [...items]
    .filter(Boolean)
    .map((x) => (x instanceof Element ? { el: x, height: null } : x));
  if (list.length) pendingVisuals.add({ items: list, started: Date.now() });
}

setInterval(() => {
  for (const entry of [...pendingVisuals]) {
    const repainted = entry.items.some((it) => !it.el.isConnected);
    if (repainted || Date.now() - entry.started > 30000) {
      entry.items.forEach((it) => {
        it.el.style.transform = "";
        if (it.height !== null) it.el.style.height = it.height;
      });
      pendingVisuals.delete(entry);
    }
  }
}, 250);

/** Visually shift all chips of an event by deltaMin right away (sub-day only). */
function applyOptimisticShift(raw, deltaMin) {
  if (Math.abs(deltaMin) >= 1440) return; // day-sized jumps don't map to translateY
  const els = [];
  document
    .querySelectorAll(`[data-eventid="${CSS.escape(raw)}"]`)
    .forEach((el) => {
      const ppm = pxPerMinuteFor(el);
      if (!ppm) return; // month view / all-day row
      el.style.transform = `translateY(${deltaMin * ppm}px)`;
      els.push(el);
    });
  watchAndClear(els);
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

/** Which part of the chip was grabbed: "start" (top edge), "end" (bottom edge), or "move". */
function dragZone(chip, ev) {
  const r = chip.el.getBoundingClientRect();
  if (r.height >= 28) {
    if (ev.clientY - r.top <= 8) return "start";
    if (r.bottom - ev.clientY <= 8) return "end";
  }
  return "move";
}

function startDragTracking(chip, downEvent) {
  const mode = dragZone(chip, downEvent);
  const isGroupDrag = mode === "move" && selection.has(chip.raw) && selection.size > 1;
  const groupRaws = isGroupDrag ? [...selection.keys()] : [chip.raw];
  const rect = chip.el.getBoundingClientRect();
  drag = {
    chip,
    mode,
    origHeightStyle: chip.el.style.height,
    origHeightPx: rect.height,
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

  let deltaMin = Math.round(dy / drag.ppm);
  if (drag.mode === "move") {
    drag.deltaMin = deltaMin;
    const px = deltaMin * drag.ppm;
    drag.groupEls.forEach((el) => (el.style.transform = `translateY(${px}px)`));
  } else {
    // Resize: clamp so the event never drops below 1 minute.
    const origMin = Math.max(1, Math.round(drag.origHeightPx / drag.ppm));
    if (drag.mode === "end") deltaMin = Math.max(deltaMin, -(origMin - 1));
    else deltaMin = Math.min(deltaMin, origMin - 1);
    drag.deltaMin = deltaMin;
    const el = drag.chip.el;
    if (drag.mode === "end") {
      el.style.height = `${drag.origHeightPx + deltaMin * drag.ppm}px`;
    } else {
      el.style.transform = `translateY(${deltaMin * drag.ppm}px)`;
      el.style.height = `${drag.origHeightPx - deltaMin * drag.ppm}px`;
    }
  }

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
    if (drag.mode !== "end") start.setMinutes(start.getMinutes() + drag.deltaMin);
    if (drag.mode !== "start") end.setMinutes(end.getMinutes() + drag.deltaMin);
    if (drag.mode === "move") {
      tip.textContent = `${fmtTime(start)} – ${fmtTime(end)}  (${deltaTxt})${groupTxt}`;
    } else {
      const dur = Math.max(1, Math.round((end - start) / 60000));
      tip.textContent = `${fmtTime(start)} – ${fmtTime(end)}  (${dur} min long)`;
    }
  } else {
    tip.textContent = drag.mode === "move" ? `${deltaTxt}${groupTxt}` : `length ${deltaTxt}`;
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

  if (d.deltaMin === 0) {
    d.groupEls.forEach((el) => (el.style.transform = ""));
    if (d.mode !== "move") d.chip.el.style.height = d.origHeightStyle;
    return;
  }

  if (d.mode !== "move") {
    // Resize commit: move only the grabbed edge, in 1-minute increments.
    try {
      const edge = d.mode === "start" ? "Start" : "End";
      toast(`${edge}: ${d.deltaMin > 0 ? "+" : ""}${d.deltaMin} min…`, 30000);
      await d.eventPromise;
      if (d.eventData && !d.eventData.start?.dateTime) {
        toast("That's an all-day event — precision resize applies to timed events.");
        d.chip.el.style.transform = "";
        d.chip.el.style.height = d.origHeightStyle;
        return;
      }
      await bg({
        type: "resizeEvent",
        calendarId: d.chip.calendarId,
        eventId: d.chip.eventId,
        deltaStartMin: d.mode === "start" ? d.deltaMin : 0,
        deltaEndMin: d.mode === "end" ? d.deltaMin : 0,
      });
      toast(`${edge} moved ${d.deltaMin > 0 ? "+" : ""}${d.deltaMin} min.`);
    } catch (err) {
      toast(`Resize failed: ${err.message}`, 8000);
    } finally {
      watchAndClear([{ el: d.chip.el, height: d.origHeightStyle }]);
    }
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
    // Keep the ghost offset until GCal actually repaints the moved chips.
    watchAndClear(d.groupEls);
  }
}

function cancelDrag() {
  if (!drag) return;
  window.removeEventListener("mousemove", onDragMove, true);
  window.removeEventListener("mouseup", onDragUp, true);
  if (drag.mode !== "move") drag.chip.el.style.height = drag.origHeightStyle;
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
      if (remDialog) {
        closeReminderDialog();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
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

// ---------------------------------------------------------------------------
// Update banner: background checks GitHub for a newer version; if one exists
// (and wasn't skipped), show a dismissible banner with an "Open GitHub" link.
// ---------------------------------------------------------------------------

(async () => {
  let st;
  try {
    st = await bg({ type: "updateStatus" });
  } catch (_) {
    return; // background not ready / check failed — stay quiet
  }
  if (!st || !st.updateAvailable || st.showBanner === false) return;

  const bar = document.createElement("div");
  bar.className = "gpm-update-banner";

  const text = document.createElement("span");
  text.className = "gpm-update-banner__text";
  text.textContent = `GCal Precision Mover ${st.latest} is available on GitHub (you have ${st.current}). Update?`;

  const updBtn = document.createElement("button");
  updBtn.className = "gpm-update-banner__btn gpm-update-banner__btn--primary";
  updBtn.textContent = "Update now";
  updBtn.addEventListener("click", async () => {
    updBtn.disabled = true;
    updBtn.textContent = "Updating…";
    let res;
    try {
      res = await bg({ type: "updateNow" });
    } catch (_) {
      res = null;
    }
    if (res && res.ok && res.updated) {
      text.textContent = `Updated to ${st.latest} ✓ — refresh this tab to load the new version.`;
      updBtn.remove();
      skipBtn.textContent = "Refresh now";
      skipBtn.onclick = () => location.reload();
      return;
    }
    if (res && res.ok && !res.updated) {
      text.textContent = "Code already matches GitHub.";
      updBtn.remove();
      return;
    }
    // Helper not installed (or pull failed) — fall back to GitHub.
    text.textContent =
      res && res.helperMissing
        ? "One-click updates need the helper (run native-host/install.sh once) — or update via GitHub:"
        : `Update failed: ${(res && res.error) || "helper unavailable"}. Update via GitHub:`;
    updBtn.disabled = false;
    updBtn.textContent = "Open GitHub";
    updBtn.onclick = () => {
      window.open(st.url, "_blank", "noopener");
      bar.remove();
    };
  });

  const skipBtn = document.createElement("button");
  skipBtn.className = "gpm-update-banner__btn";
  skipBtn.textContent = "Skip this version";
  skipBtn.addEventListener("click", async () => {
    bar.remove();
    try {
      await bg({ type: "updateDismiss", version: st.latest });
    } catch (_) {}
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "gpm-update-banner__close";
  closeBtn.textContent = "×";
  closeBtn.title = "Dismiss (asks again next session)";
  closeBtn.addEventListener("click", () => bar.remove());

  bar.append(text, updBtn, skipBtn, closeBtn);
  document.body.appendChild(bar);
})();
