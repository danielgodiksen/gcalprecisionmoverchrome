/* GCal Precision Mover — background service worker (Chrome, Manifest V3)
 *
 * Responsibilities:
 *  - OAuth token acquisition/caching (implicit flow via chrome.identity.launchWebAuthFlow)
 *  - Google Calendar API calls, proxied for the content script
 *  - Robust resolution of DOM event IDs -> real API event references
 *
 * MV3 notes: this is a service worker, so in-memory state can vanish whenever
 * Chrome suspends it. The access token is therefore cached in
 * chrome.storage.session (cleared when the browser closes).
 *
 * Why event resolution is needed: the eventId decoded from GCal's DOM is not
 * always directly usable with the API. Recurring-event instances in the DOM
 * carry a suffix like `_20260703T223000` in LOCAL wall-clock time, while the
 * API's instance IDs use UTC (`_20260703T203000Z`). Patching the raw DOM id
 * therefore 404s. We resolve by listing the recurrence's instances around
 * that time and matching the wall clock, and also fall back across the user's
 * writable calendars if the decoded calendarId doesn't hold the event.
 */

"use strict";

// events read/write + read-only calendar list (needed to resolve which calendar an event lives on)
const SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const API = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Token cache (survives service-worker suspension via storage.session)
// ---------------------------------------------------------------------------

async function readTokenCache() {
  try {
    const { gpmToken } = await chrome.storage.session.get("gpmToken");
    if (gpmToken && Date.now() < gpmToken.expiry - 60_000) return gpmToken;
  } catch (_) {}
  return null;
}

async function writeTokenCache(token, expiry) {
  try {
    await chrome.storage.session.set({ gpmToken: { token, expiry } });
  } catch (_) {}
}

async function clearTokenCache() {
  try {
    await chrome.storage.session.remove("gpmToken");
  } catch (_) {}
}

async function getClientId() {
  const { clientId } = await chrome.storage.local.get("clientId");
  if (!clientId) {
    throw new Error(
      "No OAuth Client ID configured. Open the extension's options page and paste your Google OAuth Client ID (see README)."
    );
  }
  return clientId.trim();
}

function buildAuthUrl(clientId, interactive) {
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: SCOPE,
  });
  if (!interactive) params.set("prompt", "none");
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function parseTokenFromRedirect(redirectUrl) {
  const frag = new URL(redirectUrl).hash.replace(/^#/, "");
  const p = new URLSearchParams(frag);
  const err = p.get("error");
  if (err) throw new Error(`OAuth error: ${err}`);
  const token = p.get("access_token");
  const expiresIn = parseInt(p.get("expires_in") || "3600", 10);
  if (!token) throw new Error("No access token in OAuth response.");
  return { token, expiresIn };
}

function launchAuthFlow(details) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(details, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!redirectUrl) {
        reject(new Error("Authentication window was closed."));
      } else {
        resolve(redirectUrl);
      }
    });
  });
}

async function getToken(interactive = true) {
  const cached = await readTokenCache();
  if (cached) return cached.token;

  const clientId = await getClientId();
  const attempts = interactive ? [false, true] : [false];
  let lastErr = null;
  for (const useInteractive of attempts) {
    try {
      const redirectUrl = await launchAuthFlow({
        url: buildAuthUrl(clientId, useInteractive),
        interactive: useInteractive,
      });
      const { token, expiresIn } = parseTokenFromRedirect(redirectUrl);
      await writeTokenCache(token, Date.now() + expiresIn * 1000);
      return token;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Authentication failed.");
}

// ---------------------------------------------------------------------------
// API plumbing
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, text) {
    super(`Calendar API ${status}: ${text}`);
    this.status = status;
  }
}

async function apiFetch(path, options = {}, _retried = false) {
  const token = await getToken();
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && !_retried) {
    await clearTokenCache();
    return apiFetch(path, options, true);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Event reference resolution
// ---------------------------------------------------------------------------

let calendarListCache = null;
let calendarListFetchedAt = 0;

async function getWritableCalendars() {
  if (calendarListCache && Date.now() - calendarListFetchedAt < 5 * 60_000) {
    return calendarListCache;
  }
  const data = await apiFetch(`/users/me/calendarList?minAccessRole=writer&maxResults=250`);
  calendarListCache = (data.items || []).map((c) => c.id);
  calendarListFetchedAt = Date.now();
  return calendarListCache;
}

/** Split a DOM event id into { base, suffix } where suffix is a timestamp-like tail, if any. */
function splitRecurringSuffix(eventId) {
  const i = eventId.lastIndexOf("_");
  if (i <= 0) return null;
  const suffix = eventId.slice(i + 1);
  const m = suffix.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  return {
    base: eventId.slice(0, i),
    parts: {
      y: +m[1], mo: +m[2], d: +m[3],
      h: m[4] !== undefined ? +m[4] : null,
      mi: m[5] !== undefined ? +m[5] : null,
      s: m[6] !== undefined ? +m[6] : null,
    },
    raw: suffix,
  };
}

/** Format a Date as YYYYMMDDTHHMMSS wall-clock in a given IANA timezone. */
function wallClockIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}${p.month}${p.day}T${hour}${p.minute}${p.second}`;
}

function basicUtc(ms) {
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Convert a wall-clock time in an IANA timezone to a UTC epoch (ms), or null on DST edge. */
function zonedWallClockToUtc(parts, timeZone) {
  const target = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h ?? 0, parts.mi ?? 0, parts.s ?? 0);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const w = wallClockIn(new Date(guess), timeZone); // YYYYMMDDTHHMMSS
    const asUtc = Date.UTC(
      +w.slice(0, 4), +w.slice(4, 6) - 1, +w.slice(6, 8),
      +w.slice(9, 11), +w.slice(11, 13), +w.slice(13, 15)
    );
    const diff = target - asUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return null;
}

async function tryGet(calendarId, eventId) {
  try {
    return await apiFetch(`/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

/**
 * Resolve a possibly-stale/local-time DOM event reference to a real API reference.
 * Returns { calendarId, eventId, event } or throws with a descriptive error.
 */
async function resolveEvent(calendarId, eventId) {
  const candidates = [];
  if (calendarId && (calendarId === "primary" || calendarId.includes("@"))) {
    candidates.push(calendarId);
  }

  // 1. Direct hit on the decoded calendar.
  for (const cal of candidates) {
    const ev = await tryGet(cal, eventId);
    if (ev) return { calendarId: cal, eventId, event: ev };
  }

  // 2. Recurring instance: DOM suffix is local wall-clock; match against real instances.
  const rec = splitRecurringSuffix(eventId);
  const allCals = await getWritableCalendars();
  const searchCals = [...new Set([...candidates, ...allCals])];

  if (rec) {
    const { base, parts, raw } = rec;
    const naive = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h ?? 0, parts.mi ?? 0, parts.s ?? 0);
    let sawMaster = false;

    for (const cal of searchCals) {
      const master = await tryGet(cal, base);
      if (!master) continue;
      sawMaster = true;
      const tz = master.start?.timeZone || "UTC";

      // (a) Deterministic path: the DOM suffix is the instance's ORIGINAL start in
      // local wall-clock time. Convert it to UTC in the series' timezone and request
      // exactly that instance id. No guessing.
      if (parts.h !== null) {
        const utcMs = zonedWallClockToUtc(parts, tz);
        if (utcMs !== null) {
          const idUtc = `${base}_${basicUtc(utcMs)}Z`;
          const exact = await tryGet(cal, idUtc);
          if (exact) return { calendarId: cal, eventId: idUtc, event: exact };
        }
        // Some surfaces already emit the suffix in UTC.
        const idAsUtc = `${base}_${raw.endsWith("Z") ? raw : raw + "Z"}`;
        const exact2 = await tryGet(cal, idAsUtc);
        if (exact2) return { calendarId: cal, eventId: idAsUtc, event: exact2 };
      }

      // (b) Fallback: list instances in a tight window and require an EXACT match on
      // wall clock or UTC — including against originalStartTime, so occurrences that
      // were already moved (exceptions) still resolve. NEVER "take the nearest/only
      // instance": a wrong pick moves a different day's occurrence, which looks like
      // the original staying put while a duplicate appears.
      let data;
      try {
        const timeMin = new Date(naive - 26 * 3600_000).toISOString();
        const timeMax = new Date(naive + 26 * 3600_000).toISOString();
        data = await apiFetch(
          `/calendars/${enc(cal)}/events/${enc(base)}/instances?timeMin=${enc(timeMin)}&timeMax=${enc(timeMax)}&maxResults=50`
        );
      } catch (e) {
        continue;
      }
      const instances = data.items || [];
      const wantDate = `${String(parts.y).padStart(4, "0")}${String(parts.mo).padStart(2, "0")}${String(parts.d).padStart(2, "0")}`;
      const wantFull = parts.h === null
        ? null
        : `${wantDate}T${String(parts.h).padStart(2, "0")}${String(parts.mi).padStart(2, "0")}${String(parts.s).padStart(2, "0")}`;

      const hit = instances.find((ins) => {
        if (ins.start?.date) return ins.start.date.replace(/-/g, "") === wantDate;
        if (!ins.start?.dateTime) return false;
        const candidates = [];
        const st = new Date(ins.start.dateTime);
        candidates.push(wallClockIn(st, ins.start.timeZone || tz), wallClockIn(st, "UTC"));
        if (ins.originalStartTime?.dateTime) {
          const ost = new Date(ins.originalStartTime.dateTime);
          candidates.push(
            wallClockIn(ost, ins.originalStartTime.timeZone || tz),
            wallClockIn(ost, "UTC")
          );
        }
        if (wantFull) return candidates.includes(wantFull);
        return candidates.some((c) => c.slice(0, 8) === wantDate);
      });
      if (hit) return { calendarId: cal, eventId: hit.id, event: hit };
    }

    if (sawMaster) {
      throw new Error(
        `Couldn't pin down the exact occurrence of this recurring event. Refusing to guess ` +
          `(moving the wrong occurrence would look like a duplicate). Reload the Calendar tab and retry.`
      );
    }
  }

  // 3. Non-recurring event that simply lives on a different calendar than decoded.
  for (const cal of searchCals) {
    if (candidates.includes(cal)) continue;
    const ev = await tryGet(cal, eventId);
    if (ev) return { calendarId: cal, eventId, event: ev };
  }

  throw new Error(
    `Couldn't locate this event via the API (id "${eventId}" on "${calendarId}"). ` +
      `If it's on a calendar you can't edit, moving it isn't possible.`
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function patchTimes(ref, body) {
  return apiFetch(`/calendars/${enc(ref.calendarId)}/events/${enc(ref.eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const handlers = {
  async ping() {
    return { ok: true };
  },

  async auth() {
    await getToken(true);
    return { ok: true };
  },

  async getEvent({ calendarId, eventId }) {
    const ref = await resolveEvent(calendarId, eventId);
    return ref.event;
  },

  /** Shift an event by deltaMinutes (negative allowed; whole-day deltas allowed). */
  async shiftEvent({ calendarId, eventId, deltaMinutes }) {
    const ref = await resolveEvent(calendarId, eventId);
    const ev = ref.event;

    if (ev.start?.date) {
      const days = Math.trunc(deltaMinutes / 1440);
      if (days === 0) {
        return { skipped: true, reason: "all-day event; shift smaller than a day", id: eventId };
      }
      const shiftDate = (d) => {
        const [y, m, day] = d.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, day + days));
        return dt.toISOString().slice(0, 10);
      };
      const updated = await patchTimes(ref, {
        start: { date: shiftDate(ev.start.date) },
        end: { date: shiftDate(ev.end.date) },
      });
      return { ok: true, calendarId: ref.calendarId, event: updated };
    }

    const shiftDateTime = (obj) => {
      const dt = new Date(obj.dateTime);
      dt.setUTCMinutes(dt.getUTCMinutes() + deltaMinutes);
      const out = { dateTime: dt.toISOString() };
      if (obj.timeZone) out.timeZone = obj.timeZone;
      return out;
    };

    const updated = await patchTimes(ref, {
      start: shiftDateTime(ev.start),
      end: shiftDateTime(ev.end),
    });
    return { ok: true, calendarId: ref.calendarId, event: updated };
  },

  /** Resize an event: shift only its start or only its end by N minutes. */
  async resizeEvent({ calendarId, eventId, deltaStartMin = 0, deltaEndMin = 0 }) {
    const ref = await resolveEvent(calendarId, eventId);
    const ev = ref.event;
    if (!ev.start?.dateTime) {
      return { skipped: true, reason: "not a timed event", id: eventId };
    }
    const s = new Date(ev.start.dateTime);
    s.setUTCMinutes(s.getUTCMinutes() + deltaStartMin);
    const e = new Date(ev.end.dateTime);
    e.setUTCMinutes(e.getUTCMinutes() + deltaEndMin);
    if (e.getTime() - s.getTime() < 60_000) {
      throw new Error("Resize would make the event shorter than 1 minute.");
    }
    const updated = await patchTimes(ref, {
      start: { dateTime: s.toISOString(), ...(ev.start.timeZone ? { timeZone: ev.start.timeZone } : {}) },
      end: { dateTime: e.toISOString(), ...(ev.end.timeZone ? { timeZone: ev.end.timeZone } : {}) },
    });
    return { ok: true, calendarId: ref.calendarId, event: updated };
  },

  /** Set a new absolute start (ISO string), preserving duration. */
  async moveEventTo({ calendarId, eventId, newStartIso }) {
    const ref = await resolveEvent(calendarId, eventId);
    const ev = ref.event;
    if (!ev.start?.dateTime) {
      return { skipped: true, reason: "not a timed event", id: eventId };
    }
    const durationMs = new Date(ev.end.dateTime) - new Date(ev.start.dateTime);
    const newStart = new Date(newStartIso);
    const newEnd = new Date(newStart.getTime() + durationMs);

    const updated = await patchTimes(ref, {
      start: { dateTime: newStart.toISOString(), ...(ev.start.timeZone ? { timeZone: ev.start.timeZone } : {}) },
      end: { dateTime: newEnd.toISOString(), ...(ev.end.timeZone ? { timeZone: ev.end.timeZone } : {}) },
    });
    return { ok: true, calendarId: ref.calendarId, event: updated };
  },
};

// Chrome MV3: async responses must use sendResponse + `return true`
// (returning a Promise from the listener is Firefox-only behavior).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "gpm-play-sound") return false; // handled by the offscreen page
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `Unknown message type: ${msg?.type}` });
    return false;
  }
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e.message || String(e) }));
  return true; // keep the message channel open for the async response
});

// Reminder engine (shares this global scope; must load after handlers exist).
importScripts("reminders.js");

// GitHub update checker (shares this global scope; extends `handlers`).
importScripts("updater.js");
