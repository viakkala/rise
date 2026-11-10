# Rise: guide for AI agents and new developers

Rise is a small installable web app (PWA) for a family. One person (the **user**) gets a calm daily list of tasks to do instead of doomscrolling. The other (the **admin**) sets up the weekly routine, plans ahead and reviews how things went. The app focuses on self-compassion: partial progress counts, Me Time is guaranteed, and nothing shames you for a missed day.

**Try it in 10 seconds:** serve the folder (for example `python -m http.server 8000`) and open `http://localhost:8000/index.html?demo`. Demo mode loads a made-up household (**Sam** is the user, **Alex** is the admin) with a week of history. The admin PIN is `1234`. Demo data is stored separately and never synced, so it can't touch real data.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: HTML, CSS and one vanilla JS script (ES2017, no framework, no build step). ~3,000 lines. |
| `sw.js` | Service worker: offline cache (stale-while-revalidate) plus push-notification display. |
| `manifest.webmanifest`, `icon-*.png`, `badge-96.png` | PWA install metadata and icons. |
| `sample-data/demo.json` | Demo household used by `?demo`. See "Sample data" below. |
| `firestore.rules` | Security rules for the Firebase cloud sync (pasted into the Firebase console by hand). |
| `scripts/notify.mjs` + `.github/workflows/reminders.yml` | Scheduled GitHub Action that sends the user's daily task reminders as web push. |
| `README.md` | Setup notes for the owner (hosting, Firebase, reminders). |

## Core ideas (read these first)

- **Task**: one item on today's list. Title, `context` (`online` or `offline`, shown as two tabs), `category` (label), `est` minutes, optional steps.
- **Labels (categories)**: Me Time, Self-care, Family, Home, Deep Work by default. Editable, 3 to 10 of them. Me Time is always kept. Each label is an axis on the "mastery" radar chart.
- **Weekly routine (templates)**: `state.templates.mon … sun`, each a list of template items. Every morning the day's routine is "seeded" into today's tasks.
- **Task kinds**:
  - `normal`: a plain task.
  - `plan`: for example "Plan tomorrow's breakfast". Doing it asks *what* and creates tomorrow's follow-up task ("Breakfast: Poha"), replacing the plain routine item.
  - `weekend`: "Plan the weekend with family", on Thursdays. It always carries over until done, and it creates Saturday/Sunday tasks.
- **Finishing a task**: each card has three buttons:
  - **✓ Done**: one sheet with two choices. "Finished: how long did it take?" (Quicker / About right / Longer / Much longer, relative to the estimate) or "Not finished: how far?" (25 / 50 / 75%).
  - **Later**: later today (sinks to the bottom), tomorrow (moves with its progress), someone else did it, or not needed today.
  - **💗 Love**: hand the task to the admin, with an optional note.
- **Day rollover** (new day): unfinished tasks *with progress* carry over (setting `carryOver`). Untouched ones drop. Weekend plans and tasks handed to Love always carry. Then the day's routine and any tasks scheduled for that date are added.
- **Plan ahead** (admin): for a specific date, untick routine items, use "Help at home" (drop Home tasks), or add one-off extra tasks for one or more days. Stored in `state.dayPlans[date]` and `state.scheduled`.
- **Away / vacation** (admin): a date range where only chosen labels stay (Self-care and Me Time by default). Unfinished work in paused labels waits in `state.held` and returns on the first normal day. Extra tasks added for those dates still appear.
- **Change history**: every add, edit, delete, skip, move, hand-over and plan change is logged with who did it (user/admin). It's stored separately from the task data and shown in Admin → Changes.
- **Habit log** (`state.log`): one entry per Done / partial event with estimated vs actual minutes. Shown in Admin → Analytics and exportable as CSV.
- **"Why you're not scrolling" card**: one random benefit of not doomscrolling plus one reason a task on today's list matters (`BENEFITS`, `TASK_WHYS`, `CATEGORY_WHYS`).

## Data model (localStorage)

- `focusPwa.state.v1`: the app state, `version: 3`. Main fields:
  - `pin`, `settings {carryOver, loveName}`, `categories[]`
  - `templates {mon..sun: [template]}`
  - `tasks[]` (today), `scheduled[{id, date, task}]` (future days), `held[]` (paused while away)
  - `log[]`, `lastSeedDate`, `dayPlans {date: {skip[], keep[], away, awayKeep[], awayId}}`, `why {…}`
- `focusPwa.changes.v1`: the change history `{seenTs, entries[{id, ts, who, action, summary}]}`.
- Demo mode uses `rise.demo.state` and `rise.demo.changes` instead.
- Template item: `{id, title, context, category, est, subtasks[titles], kind, followTitle, followEst, whys[]}`.
- Task: template fields plus:
  - `timeSpent, progress, status ('active'|'partial'|'done'|'skipped')`
  - `carried, later, skipReason ('covered'|'not-needed'|'moved'), movedTo`
  - `assignee ('love'|null), assignedAt, loveNote, doneBy`
  - `extra` (admin-added for a date), `replaces`, `date`
- **All loaded data goes through `normalize()` / `normTask()` / `normTpl()`** (section "Normalisation"). If you add a field, add it there or it will be dropped on load.

## Code map (`index.html` script, by section comment)

| Section | Contents |
|---|---|
| Constants & helpers | `dateKey`, `addDays`, `esc` (always use it for HTML), `uid` |
| Why not doomscroll | The 42 benefits and the task reasons |
| Default data | Default routine, `defaultState()` |
| Normalisation | Validation and migrations |
| Persistence | `loadState`, `save()`. `save()` also schedules a cloud sync. |
| Change history | `logChange(action, summary)` |
| Cloud sync | Firebase over plain REST (see below) |
| Reminders | Push opt-in on the user phone |
| Domain logic | `seedToday`, `placeTask`, `scheduleTask`, `injectScheduled`, `rollover`, `markDone` |
| User view rendering | `renderUser`, `renderTasks`, `taskCardHtml`, Love tab, radar chart |
| User actions | Done sheet, Later sheet, plan/weekend modals, task editor, labels |
| Admin rendering / actions | Tabs: Today, Plan ahead, Weekly, Analytics, Changes, Settings |
| Demo data / Boot | `?demo` loader, start-up, timers |

UI conventions:
- Every button has a `data-action` and is handled by one delegated click listener per view.
- Dialogs use `openModal({title, body, confirmText, onConfirm, onPick, extra})`.
- Small messages use `toast(msg, undoFn)`.

## Cloud sync (optional)

There is no SDK: the app calls Firebase Auth and Firestore REST endpoints directly (`FB`, `ADMIN_EMAIL` near the top of the sync section).
- Every entity (task, template day, log entry, plan, setting, change) is one document in `households/main/items/{col__id}`.
- Each phone pushes only what changed (hashes stored in `rise.sync.v1`) and pulls only what changed since the last sync.
- Conflicts are resolved per entity: last writer wins, but local unsynced edits win.
- The admin is whoever signs in with `ADMIN_EMAIL`. The user phone hides the Admin Panel. Without signing in ("Use on this device only"), everything stays local and the Admin Panel is protected by the PIN.
- To run without the cloud, use demo mode or local mode. To point at your own Firebase project, change `FB` and `ADMIN_EMAIL` in `index.html`, `scripts/notify.mjs` and `firestore.rules`.

## Rules when changing the code

1. **Bump `CACHE` in `sw.js` on every release**, or installed phones keep the old version (phones update after the app is closed and reopened twice).
2. Keep it one file, vanilla JS, no build step. Load nothing from third-party CDNs (it must work offline).
3. New state fields go through `normTask`/`normalize`, and through `entities()`/`applyEntity()` if they must sync.
4. Log user-visible data changes with `logChange()`.
5. Escape all user text with `esc()` before putting it in HTML.
6. Test at phone width (390 px). Rendering is mobile-first with a dark theme.

## Sample data

`sample-data/demo.json` = `{about, anchor, state, changes}`. It was recorded by using the app for six days (anchor = the last day).
- On load, `shiftDemo()` moves every date, seeded task id and timestamp so the anchor becomes today, so the demo always looks current.
- It includes: done/partly-done tasks with real vs estimated minutes, skips, a task moved to tomorrow, tasks handed to Alex (two still open; an earlier one done by Alex shows in the change history), meal and play plans with follow-ups, a weekend plan, "Help at home" tomorrow, a two-day trip in a few days with extra tasks, and a change history.
- **Reset demo** (top banner) reloads it fresh.
- To regenerate or edit it, change the JSON directly (it uses the same format as the real state) or record new data and copy `localStorage['focusPwa.state.v1']` and `localStorage['focusPwa.changes.v1']` into it.
