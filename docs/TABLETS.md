# Tablets — kiosk lock and offline board

Floor tablets are Chrome on a shared device, pointed at the home-base PC. This is not a phone layout.

## Kiosk lock

Open the board with `?kiosk=1` (caja or cocina):

- `http://HOME_BASE:3000/?kiosk=1`
- `http://HOME_BASE:3000/?kiosk=1&board=cocina` still uses the on-screen board toggle; the flag only locks the chrome.

What it does:

- The web app manifest uses `display: fullscreen` and `start_url: /?kiosk=1`, so **Chrome → Add to Home screen** (or Install app) opens the floor board without the browser toolbar.
- The first tap asks for the Fullscreen API.
- The Back button is trapped (`history.pushState`).
- Closing the tab raises a `beforeunload` prompt.

How to enable it on a tablet:

1. In Chrome, open `http://HOME_BASE:3000/?kiosk=1`.
2. Chrome menu → **Add to Home screen** / **Install app**.
3. Launch **Floor Boards** from the home screen, not from a normal tab.
4. Tap once if Chrome asks to go fullscreen.

Leave kiosk by closing the installed app from the Android overview (the in-page prompt only slows an accidental close). Do not use kiosk mode on the desktop back office.

## Offline read-only board

Each tablet stores the last board it successfully loaded (`localStorage`, key `taco-oasis-last-board-v1`).

If Wi-Fi or the home base drops, that snapshot stays on screen with an offline badge. Seat, swap, upload, tareas, and the training switch stay disabled. Nothing is queued. When the tablet reconnects, the live board replaces the snapshot and edits work again.

Two tablets cannot seat the same station from a stale copy, because the cached board never writes. The server still enforces one person per station when the network is back.
