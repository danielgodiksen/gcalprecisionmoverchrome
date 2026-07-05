/* GCal Precision Mover — reminder engine (shared by Firefox and Chrome builds)
 *
 * Loaded after background.js in the same global scope, so it can use
 * apiFetch / resolveEvent / handlers / enc defined there.
 *
 * Concepts:
 *  - A WATCH is attached to an event series (recurring) or a single event.
 *    Config per watch: leads (minutes-before list, 0 = at start),
 *    focusEvery (minutes between "still on task?" pings during the event, 0 = off),
 *    followUp (bool) + followUpMin (duration of the follow-up block).
 *  - A TICK runs every 15s (Firefox, persistent background) or 30s
 *    (Chrome, alarms waking the service worker). Fired notifications are
 *    deduplicated through persisted keys, so a late tick fires once, never twice.
 *  - A FOLLOW-UP prompt re-notifies every 30s until clicked (safety cap: 60
 *    repeats = 30 minutes). Clicking opens followup.html; accepting there books
 *    a block in the next free gap on your primary calendar.
 */

"use strict";

const RT = globalThis.browser ?? chrome;
const REM_ICON = RT.runtime.getURL("icons/icon96.png");
const LATE_WINDOW_MS = 5 * 60_000; // still fire a lead alert up to 5 min late
const FU_REPEAT_MS = 30_000;
const FU_MAX_REPEATS = 60;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function remState() {
  const st = await RT.storage.local.get({ watches: [], fired: {}, followups: {} });
  return st;
}

async function remSave(patch) {
  await RT.storage.local.set(patch);
}

async function notify(id, title, message) {
  try {
    await RT.notifications.create(id, {
      type: "basic",
      iconUrl: REM_ICON,
      title,
      message,
    });
  } catch (_) {}
  playSound();
}

/** Play the bundled chime. Browser notifications are silent by default and the
 *  OS may suppress its own sound, so the extension brings its own. */
async function playSound() {
  try {
    // Respect the "play sound" toggle in the popup settings (default: on).
    try {
      const { gpmNotifSettings } = await RT.storage.local.get("gpmNotifSettings");
      if (gpmNotifSettings && gpmNotifSettings.sound === false) return;
    } catch (_) {}
    if (RT.offscreen && RT.offscreen.createDocument) {
      // Chrome MV3: service workers can't play audio; use an offscreen document.
      try {
        await RT.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Play the reminder chime",
        });
      } catch (_) {
        /* already exists */
      }
      RT.runtime.sendMessage({ type: "gpm-play-sound" }).catch?.(() => {});
    } else {
      // Firefox MV2: the persistent background page can play audio directly.
      new Audio(RT.runtime.getURL("beep.wav")).play().catch(() => {});
    }
  } catch (_) {}
}

/** Fetch without ever popping an interactive sign-in (background ticks must
 *  never open windows). Throws on auth failure; caller decides how to surface it. */
async function quietFetch(path) {
  let token = await getToken(false);
  let res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    if (typeof clearTokenCache === "function") await clearTokenCache();
    else { cachedToken = null; tokenExpiry = 0; }
    token = await getToken(false);
    res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`);
  return res.json();
}

let lastAuthAlert = 0;
function isAuthError(msg) {
  return /oauth|authentication|client id|access token|sign-?in/i.test(msg || "");
}
async function maybeAuthAlert(msg) {
  if (!isAuthError(msg)) return;
  const now = Date.now();
  if (now - lastAuthAlert < 3600_000) return;
  lastAuthAlert = now;
  await notify(
    "gpm-auth",
    "Reminders paused: sign-in needed",
    "The extension couldn't refresh your Google session silently. Open the extension options and use \"Save & test sign-in\", or perform any move in Google Calendar once."
  );
}

// ---------------------------------------------------------------------------
// Occurrence cache (per watch, refreshed every 10 min)
// ---------------------------------------------------------------------------

async function refreshWatch(w) {
  const now = Date.now();
  const timeMin = new Date(now - 3 * 3600_000).toISOString();
  const timeMax = new Date(now + 26 * 3600_000).toISOString();
  try {
    if (w.isRecurring) {
      const data = await quietFetch(
        `/calendars/${enc(w.calendarId)}/events/${enc(w.masterId)}/instances` +
          `?timeMin=${enc(timeMin)}&timeMax=${enc(timeMax)}&maxResults=25`
      );
      w.occ = (data.items || [])
        .filter((i) => i.start?.dateTime && i.status !== "cancelled")
        .map((i) => ({ start: i.start.dateTime, end: i.end.dateTime }));
    } else {
      const ev = await quietFetch(`/calendars/${enc(w.calendarId)}/events/${enc(w.masterId)}`);
      w.occ =
        ev.start?.dateTime && ev.status !== "cancelled"
          ? [{ start: ev.start.dateTime, end: ev.end.dateTime }]
          : [];
      if (ev.summary) w.summary = ev.summary;
    }
    w.refreshedAt = now;
    w.lastError = null;
  } catch (e) {
    w.refreshedAt = now; // don't hammer the API on persistent errors
    w.lastError = e.message;
    maybeAuthAlert(e.message);
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

let ticking = false;

async function remTick() {
  if (ticking) return;
  ticking = true;
  try {
    const st = await remState();
    if (!st.watches.length && !Object.keys(st.followups).length) return;
    const now = Date.now();
    let dirty = false;

    const fireOnce = async (key, title, msg, nid) => {
      if (st.fired[key]) return;
      st.fired[key] = now;
      dirty = true;
      try {
        await notify(nid || `gpm-rem|${key}`, title, msg);
      } catch (_) {}
    };

    for (const w of st.watches) {
      if (!w.refreshedAt || now - w.refreshedAt > 10 * 60_000) {
        await refreshWatch(w);
        dirty = true;
      }
      const cfg = w.config || {};
      for (const occ of w.occ || []) {
        const s = Date.parse(occ.start);
        const e = Date.parse(occ.end);

        // Lead alerts (e.g. 5 min before, at start)
        for (const off of cfg.leads || []) {
          const t = s - off * 60_000;
          if (now >= t && now < t + LATE_WINDOW_MS && now < e) {
            const when =
              off === 0
                ? "starts NOW"
                : now >= s
                  ? "has started"
                  : `starts in ${Math.max(1, Math.round((s - now) / 60_000))} min`;
            await fireOnce(
              `${w.key}|${occ.start}|lead${off}`,
              `${w.summary || "Event"} ${when}`,
              off === 0 ? "Time to switch. Stop what you're doing." : "Wrap up what you're doing."
            );
          }
        }

        // Focus pings during the event
        if (cfg.focusEvery > 0 && now > s + 30_000 && now < e) {
          const k = Math.floor((now - s) / (cfg.focusEvery * 60_000));
          if (k >= 1) {
            const minsIn = Math.round((now - s) / 60_000);
            await fireOnce(
              `${w.key}|${occ.start}|focus${k}`,
              `Focus check: ${w.summary || "current block"}`,
              `${minsIn} min in. Still on task, or did something sidetrack you?`
            );
          }
        }

        // Follow-up prompt at the end of the event
        if (cfg.followUp && now >= e && now < e + 6 * 3600_000) {
          const fuKey = `${w.key}|${occ.start}|fu`;
          if (!st.fired[fuKey]) {
            st.fired[fuKey] = now;
            st.followups[fuKey] = {
              key: fuKey,
              summary: w.summary || "Event",
              calendarId: w.calendarId,
              durationMin: cfg.followUpMin || 30,
              created: now,
              last: 0,
              repeats: 0,
              clicked: false,
            };
            dirty = true;
          }
        }
      }
    }

    // Follow-up re-notify loop (every 30s until clicked, capped)
    for (const fu of Object.values(st.followups)) {
      if (fu.clicked) continue;
      if (fu.repeats >= FU_MAX_REPEATS) continue;
      if (now - fu.last >= FU_REPEAT_MS) {
        fu.last = now;
        fu.repeats++;
        dirty = true;
        try {
          await RT.notifications.clear(`gpm-fu|${fu.key}`);
          await notify(
            `gpm-fu|${fu.key}`,
            `Follow up on: ${fu.summary}`,
            `Click to schedule a ${fu.durationMin}-min follow-up in your next free slot.` +
              (fu.repeats > 1 ? ` (reminder ${fu.repeats})` : "")
          );
        } catch (_) {}
      }
    }

    // Prune fired keys older than 2 days
    for (const [k, ts] of Object.entries(st.fired)) {
      if (now - ts > 2 * 86400_000) {
        delete st.fired[k];
        dirty = true;
      }
    }

    if (dirty) {
      await remSave({ watches: st.watches, fired: st.fired, followups: st.followups });
    }
  } catch (e) {
    console.warn("[gpm] reminder tick failed:", e.message);
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Free-slot finder + follow-up scheduling
// ---------------------------------------------------------------------------

async function findFreeSlot(calendarIds, durationMin, fromMs) {
  const horizon = fromMs + 36 * 3600_000;
  const busy = [];
  for (const cal of [...new Set(calendarIds)]) {
    try {
      const data = await apiFetch(
        `/calendars/${enc(cal)}/events?singleEvents=true&orderBy=startTime` +
          `&timeMin=${enc(new Date(fromMs).toISOString())}&timeMax=${enc(new Date(horizon).toISOString())}&maxResults=100`
      );
      for (const ev of data.items || []) {
        if (ev.start?.dateTime && ev.status !== "cancelled" && ev.transparency !== "transparent") {
          busy.push([Date.parse(ev.start.dateTime), Date.parse(ev.end.dateTime)]);
        }
      }
    } catch (_) {}
  }
  busy.sort((a, b) => a[0] - b[0]);

  // Start looking 10 min from now, rounded up to the next 5 minutes.
  let cursor = Math.ceil((fromMs + 10 * 60_000) / (5 * 60_000)) * 5 * 60_000;
  const need = durationMin * 60_000;
  for (const [bs, be] of busy) {
    if (bs - cursor >= need) return cursor;
    if (be > cursor) cursor = be;
  }
  if (horizon - cursor >= need) return cursor;
  return null;
}

// ---------------------------------------------------------------------------
// Message handlers (extend the existing `handlers` object from background.js)
// ---------------------------------------------------------------------------

Object.assign(handlers, {
  /** Attach a watch to an event (resolves recurring instance -> series). */
  async addWatch({ calendarId, eventId, config }) {
    const ref = await resolveEvent(calendarId, eventId);
    const ev = ref.event;
    if (!ev.start?.dateTime) {
      return { skipped: true, reason: "all-day events aren't supported for reminders" };
    }
    const isRecurring = !!(ev.recurringEventId || ev.recurrence);
    const masterId = ev.recurringEventId || ev.id;
    const key = `${ref.calendarId}|${masterId}`;
    const st = await remState();
    const watch = {
      key,
      calendarId: ref.calendarId,
      masterId,
      isRecurring,
      summary: ev.summary || "(untitled)",
      config: {
        leads: (config.leads || [5, 0]).map(Number).filter((n) => Number.isFinite(n) && n >= 0),
        focusEvery: Math.max(0, Number(config.focusEvery) || 0),
        followUp: !!config.followUp,
        followUpMin: Math.max(5, Number(config.followUpMin) || 30),
      },
      occ: [],
      refreshedAt: 0,
    };
    const i = st.watches.findIndex((x) => x.key === key);
    if (i >= 0) st.watches[i] = watch;
    else st.watches.push(watch);
    await remSave({ watches: st.watches });
    remTick();
    return { ok: true, key, summary: watch.summary, isRecurring };
  },

  async listWatches() {
    const st = await remState();
    return {
      watches: st.watches.map((w) => ({
        key: w.key,
        summary: w.summary,
        isRecurring: w.isRecurring,
        config: w.config,
        lastError: w.lastError || null,
      })),
    };
  },

  async removeWatch({ key }) {
    const st = await remState();
    st.watches = st.watches.filter((w) => w.key !== key);
    for (const k of Object.keys(st.followups)) {
      if (k.startsWith(key + "|")) delete st.followups[k];
    }
    await remSave({ watches: st.watches, followups: st.followups });
    return { ok: true };
  },

  async getFollowup({ key }) {
    const st = await remState();
    return { followup: st.followups[key] || null };
  },

  async acceptFollowup({ key, durationMin }) {
    const st = await remState();
    const fu = st.followups[key];
    if (!fu) return { error: "This follow-up no longer exists." };
    const dur = Math.max(5, Number(durationMin) || fu.durationMin);
    const slot = await findFreeSlot(["primary", fu.calendarId], dur, Date.now());
    if (slot === null) return { error: "No free slot found in the next 36 hours." };
    const created = await apiFetch(`/calendars/primary/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: `Follow-up: ${fu.summary}`,
        start: { dateTime: new Date(slot).toISOString() },
        end: { dateTime: new Date(slot + dur * 60_000).toISOString() },
      }),
    });
    delete st.followups[key];
    await remSave({ followups: st.followups });
    await RT.notifications.clear(`gpm-fu|${key}`);
    return { ok: true, start: created.start.dateTime, end: created.end.dateTime };
  },

  async testNotification() {
    await notify(
      `gpm-test|${Date.now()}`,
      "Test notification",
      "If you can see this and heard a chime, reminders can reach you."
    );
    return { ok: true };
  },

  async dismissFollowup({ key }) {
    const st = await remState();
    delete st.followups[key];
    await remSave({ followups: st.followups });
    await RT.notifications.clear(`gpm-fu|${key}`);
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Notification clicks + scheduling
// ---------------------------------------------------------------------------

RT.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith("gpm-fu|")) {
    const key = id.slice("gpm-fu|".length);
    // Clicked => stop the re-notify loop; the page takes over the decision.
    const st = await remState();
    if (st.followups[key]) {
      st.followups[key].clicked = true;
      await remSave({ followups: st.followups });
    }
    RT.tabs.create({ url: RT.runtime.getURL(`followup.html?key=${encodeURIComponent(key)}`) });
    RT.notifications.clear(id);
  } else if (id.startsWith("gpm-rem|")) {
    RT.notifications.clear(id);
  }
});

// ---------------------------------------------------------------------------
// Scheduler: alarms in Chrome MV3 (service worker sleeps), interval in Firefox
// ---------------------------------------------------------------------------

if (RT.alarms) {
  RT.alarms.create("gpm-rem-tick", { periodInMinutes: 0.5 });
  RT.alarms.onAlarm.addListener((a) => {
    if (a.name === "gpm-rem-tick") remTick();
  });
  remTick();
} else {
  setInterval(remTick, 15_000);
  remTick();
}
