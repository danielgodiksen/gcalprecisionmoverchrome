# GCal Precision Mover (Chrome)

Move Google Calendar events **in bulk** and reposition them in **1-minute increments** —
no more typing exact start times by hand.

## Why it works this way

Google Calendar's 15-minute drag snap is hard-coded inside Google's compiled frontend
JavaScript, so no extension can cleanly change the snap of the *native* drag.
This extension sidesteps that: it adds its own interaction layer (behind the **Alt** key)
and commits every change through the official **Google Calendar API**, which is exact
to the second. Google's UI then syncs the new time back into the view within a few seconds.

## Features

| Action | What it does |
|---|---|
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
