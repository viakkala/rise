# Rise

A gentle daily planner for self-care, family and focus — for when distracting apps are blocked.

Single-file Progressive Web App (`index.html`), installable on Android from Chrome. Works offline; syncs between the family's phones through Firebase.

- `index.html` — the whole app (HTML, CSS, JS)
- `sw.js` — offline cache (bump `CACHE` on every release)
- `manifest.webmanifest`, `icon-*.png` — install metadata and icons
- `firestore.rules` — Firestore security rules (paste into the Firebase console)
- `badge-96.png` — small white icon shown in the Android status bar for reminders

## Demo and docs for other developers

- Open `index.html?demo` to try Rise with a made-up household (admin PIN 1234). It uses separate storage, never syncs and has a **Reset demo** button.
- `AGENTS.md` (also linked from `CLAUDE.md`) explains the concepts, code layout, data model and rules for changing the code.
- `sample-data/demo.json` holds the demo household.

## Reminders

The user phone can get notifications with today's list (about 7:30 AM, 1 PM and 7 PM India time, plus a Thursday-evening nudge if the weekend plan is still open). Nothing is sent when everything is done.

- `.github/workflows/reminders.yml` runs on a schedule and calls `scripts/notify.mjs`.
- The script signs in to Firebase as `rise.reminders@yourmail.com` (read-only by the rules), works out today's open tasks, and sends a web push to every phone that tapped **🔔 Turn on reminders**.
- Repository secrets needed: `RISE_BOT_PASSWORD` (that account's password) and `VAPID_PRIVATE_KEY`. The matching public key is in `index.html` and the workflow.
- Test any time: GitHub → Actions → Rise reminders → Run workflow.
