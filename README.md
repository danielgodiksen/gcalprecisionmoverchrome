# GCal Precision Mover

Move Google Calendar events **in bulk** and reposition them in **1-minute increments** —
no more typing exact start times by hand.

## Why it works this way

Google Calendar's 15-minute drag snap is hard-coded inside Google's compiled frontend
JavaScript, so no extension can cleanly change the snap of the *native* drag.
This extension sidesteps that: it adds its own interaction layer (behind the **Alt** key)
and commits every change through the official **Google Calendar API**, which is exact
to the second. Google's UI then syncs the new time back into the view within a few seconds.

> **v1.3.0 fix:** moving an occurrence of a recurring event could previously move the
> *wrong* occurrence (nearest-match guessing), which looked like the original staying in
> place while a duplicate appeared. Resolution is now deterministic — the exact instance
> is computed from its timestamp and timezone, and the extension refuses to guess rather
> than touch a different occurrence. If you have leftover misplaced occurrences from
> before, delete them once by hand; new moves won't create them.

## Features

| Action | What it does |
|---|---|
| **Alt + drag an event's top/bottom edge** (Day/Week view) | Resize the start or end of the event in **1-minute** increments, with a live duration tooltip |
| **Alt + drag** an event (Day/Week view) | Precision move with a live tooltip showing the new start–end time, snapping to **1 minute**. If the dragged event is part of your selection, **the whole selection moves together** by the same amount |
| **Alt + click** events | Multi-select (blue outline); a bulk panel appears bottom-right |
| Bulk panel | Shift all selected events by ± days / hours / minutes in one go, or use the −5/−1/+1/+5 min nudge buttons |
| **Alt + ↑ / Alt + ↓** | Nudge all selected events ±1 minute (**Shift+Alt+↑/↓** = ±5 min) |
| **Esc** | Cancel an in-progress drag, or clear the selection |

Recurring events: moving an instance shown in the grid creates a one-off exception for
that occurrence (same as moving it by hand in GCal).

## Install (~1 minute)

1. Unzip this folder somewhere permanent (Chrome loads it from disk — don't delete it later).
2. Open `chrome://extensions`, enable **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select the unzipped folder.

The extension ID will be **`kclgolgegafpegabmfgpliifdpjpcofl`** — it is pinned in the
manifest, so it is identical for every person who installs this folder. That matters
for the OAuth step below.

## One-time Google setup (~5 minutes)

The extension talks to the Calendar API as *you*, using an OAuth client that you own.
Nothing goes through any third-party server.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → create a project (any name).
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External → fill in the minimal fields,
   add your own Google account under **Test users** (staying in "Testing" mode is fine
   for personal use).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type: **Web application** → under **Authorized redirect URIs**, add:

   ```
   https://kclgolgegafpegabmfgpliifdpjpcofl.chromiumapp.org/
   ```

   (This is also shown on the extension's options page — they must match exactly,
   including the trailing slash.) → **Create**, then copy the **Client ID**.
5. Open the extension's **Options** page (`chrome://extensions` → GCal Precision Mover →
   **Details** → **Extension options**), paste the Client ID → **Save & test sign-in** →
   approve the Google consent screen once. Done.

> Access tokens expire after ~1 hour; the extension refreshes them silently. If a silent
> refresh fails you'll briefly see the Google popup again. Tokens are kept only in
> session storage and are cleared when Chrome closes.

## Event reminders (browser notifications)

Open any event's popup in Google Calendar and click the injected **Reminders** button (it sits
in the same popup where GCal's own notifications live), or select events with **Alt+click**
and press the bell button in the panel. Both work for recurring and one-off events.
Recurring events are watched as a **series** (a daily lunch block = one watch, every
occurrence notifies). Per watch you can configure:

- **Lead alerts**: comma-separated minutes before start, e.g. `5,0` = five minutes
  before *and* on the dot.
- **Focus pings**: a "still on task?" notification every N minutes while the event is
  running (for study/revision blocks).
- **Follow-up prompt**: when the event ends, a notification asks whether to schedule a
  follow-up. It **re-notifies every 30 seconds until you click it** (capped at 30
  minutes of retries). Clicking opens a page where accepting books the follow-up into
  the **next free gap** on your primary calendar (checks the next 36 h, avoids busy
  timed events); declining dismisses it.

Practical notes:

- Reminders fire as long as the **browser is running** — no Calendar tab needed.
  They stop when the browser is closed (this is a browser extension, not a system service).
- Timing granularity: checks run every 15 s (Firefox) / 30 s (Chrome), so "on the dot"
  means within that margin.
- The watchlist (with remove buttons) lives in the same bell dialog.
- All-day events aren't supported for reminders.

### If notifications don't appear or make no sound

1. Open the Reminders dialog and press **Test** — a notification with a chime should fire
   immediately. This isolates OS problems from extension problems.
2. No banner: allow notifications from the browser at the OS level
   (Windows: Settings > System > Notifications > enable for the browser, and check
   Focus Assist / Do Not Disturb; macOS: System Settings > Notifications > browser > Allow).
3. No sound: the extension plays its own chime (beep.wav) with every reminder, independent
   of OS notification sounds. If the test shows a banner but stays silent, check the
   browser's site/system volume and OS per-app sound settings.
4. A watch showing a warning in the list means its background refresh failed — usually an
   expired Google session. Background checks never open sign-in popups; if the session
   lapses you get one "sign-in needed" notification per hour. Re-auth via the options page.
5. Reminders only run while the browser is running.

## Notes & limitations

- **Precision drag is vertical (time-of-day)** in Day/Week view. To move events across
  days, use the bulk panel's *Days* field (works even with a single selected event).
- **All-day events** can be shifted by whole days via the panel; sub-day shifts are skipped.
- After a move, the chip may briefly show its old position until Google's own sync
  repaints it (usually 1–3 seconds).
- Google Calendar's DOM changes occasionally. The extension anchors on the
  `data-eventid` attribute — historically stable — but if Google ships a redesign,
  the selectors in `content.js` (`findChip`, `pxPerMinuteFor`) are the places to update.
- Scopes requested: `calendar.events` (read/write events) plus `calendar.readonly`
  (read-only calendar list — used to figure out which calendar an event lives on).
- Chrome may show a "developer mode extensions" notice at startup on some systems;
  it's informational and can be dismissed.

## File map

```
manifest.json   extension manifest (MV3, Chrome; "key" pins the extension ID)
background.js   OAuth + Calendar API calls (service worker)
content.js      Alt+drag / Alt+click / nudges / bulk panel
content.css     injected UI styles
options.html/js Client ID configuration + auth test
```
