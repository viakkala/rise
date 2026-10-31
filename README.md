# Rise

A gentle daily planner for self-care, family and focus — for when distracting apps are blocked.

Single-file Progressive Web App (`index.html`), installable on Android from Chrome. Works offline; syncs between the family's phones through Firebase.

- `index.html` — the whole app (HTML, CSS, JS)
- `sw.js` — offline cache (bump `CACHE` on every release)
- `manifest.webmanifest`, `icon-*.png` — install metadata and icons
- `firestore.rules` — Firestore security rules (paste into the Firebase console)
