# Architecture and roadmap

## How the pieces fit

```
┌──────────── Web view (TypeScript, src/) ────────────┐
│ main.ts    shell: sign-in, toolbar, navigation,     │
│            keyboard shortcuts, cache of ranges      │
│ views/     index.ts (range/step/title per view),    │
│            timeline.ts (day+week), month.ts,        │
│            year.ts, agenda.ts                       │
│ time.ts    date helpers shared by all views         │
│ api.ts     typed invoke() wrappers                  │
│ settings.ts Settings, Google accounts, Todoist      │
│ preferences.ts settings kept on this device         │
│ event-form.ts New/Edit event or task form;          │
│            quick-parse.ts reads the sentence        │
│ details.ts event/task details, Edit and Delete      │
│ search.ts  search window                            │
│ flyout.ts  the menu bar window (desktop)            │
│ sync.ts    tells the other window about changes     │
│ dev-mock.ts sample data for `npm run dev` in a      │
│            browser (dev only)                       │
└───────────────────────┬─────────────────────────────┘
                        │ invoke("get_agenda") etc. (Tauri IPC)
┌───────────────────────┴──── Rust (src-tauri/src/) ──┐
│ lib.rs             commands + shared state          │
│ agenda.rs          AgendaItem model, merge + sort   │
│ google/auth.rs     OAuth PKCE + loopback, tokens    │
│ google/calendar.rs Calendar API v3 client           │
│ todoist.rs         Todoist API v1: tasks, add, done │
│ search.rs          search across accounts/Todoist   │
│ cache.rs           saved items for offline use      │
│ desktop.rs         menu bar icon + window, ⌥⌘N      │
│ alerts.rs          notifications, time to leave,    │
│                    the menu bar's next event        │
│ prefs.rs           settings kept for the Rust side  │
│ apple.rs           Mac: Calendar + Reminders apps   │
│ travel.rs          Mac: location, Apple Maps times  │
│ secrets.rs         OS keychain                      │
│ error.rs           AppError → { kind, message }     │
└─────────────────────────────────────────────────────┘
```

Design rules:

1. **Tokens never reach the web view.** Every network call and secret lives in
   Rust. The web view gets only agenda data. If a malicious event title ever
   ran script in the web view (the UI only uses `textContent`, so it shouldn't),
   it still couldn't read your tokens.
2. **One model for everything on the agenda.** `AgendaItem` has `source`
   (`google`, `todoist`) and `kind` (`event`, `task`). New sources
   add items to the list; the UI doesn't need to know where they came from.
3. **Views are plain functions.** Each view takes a `ViewContext` (items plus
   date range) and draws into an element. The menu bar window reuses
   `renderAgenda`.
4. **The backend serves any date range.** `get_agenda(from, to)` takes local
   dates. Each view decides its own range (a week, six weeks for a month grid,
   a year).

## Menu bar, quick add shortcut, background alerts (done)

Desktop only (`#[cfg(desktop)]`), in `desktop.rs` and `alerts.rs`:

- A `TrayIconBuilder` icon (`icons/tray.png`: the logo in colour, rendered
  from `icons/source/tray.svg`, the icon artwork cropped to its tile, at 60
  of 72 px so the menu bar's 18 pt shows a 15 pt tile, 1 pt above centre to
  sit level with the text beside it, with a thin gold ring (the brand gold, `--gold`) so the navy shows
  on a dark menu bar). Left click toggles the `flyout` window; right click shows
  Open / New Event… / Quit.
- The `flyout` window is built in `setup` (380×600, resizable, no frame,
  always on top, hidden) and loads the same page with
  `window.__MINUTEMAN_FLYOUT__` set, so `main.ts` hands over to
  `flyout.ts`. `place_under_icon` puts it under the icon, on the screen the
  icon is on (its last click or hover gives its place, in that screen's
  pixels; on a Mac, where windows are placed in points and screens can
  differ in scale, the screen is the one the pointer is on); it hides when
  it loses focus or on Esc.
- Detaching (its header's button, or dragging it: a `Moved` event the app
  didn't cause) makes it an ordinary window that stays where you put it and
  stays open; the header then has put-back and close buttons.
- `tauri-plugin-global-shortcut` registers ⌥⌘N, which shows the flyout
  and emits `flyout-new` to open New event in it.
- Closing the main window hides it (`CloseRequested` → `prevent_close`);
  `RunEvent::Reopen` (Dock click) shows it again.
- `sync.ts`: each window emits `agenda-changed` after a change, and the
  other reloads.

Mac only (`#[cfg(target_os = "macos")]`), through the `objc2-*` crates:

- **Apple Calendar and Reminders** (`apple.rs`): EventKit on one background
  thread that owns the `EKEventStore`. Events and reminders become
  `AgendaItem { source: Apple }` (read-only; reminders can be ticked off via
  `set_task_completed`). `agenda::load` adds them when turned on in Settings
  (`prefs.rs`). Calendars whose account looks like one of your Google ones
  start hidden, to avoid doubles.
- **Time to leave** (`travel.rs`, used by `alerts.rs`): `CLLocationManager`
  on the main thread follows the location while it's on; `MKLocalSearch`
  finds the event's place near you and `MKDirections` the driving time,
  arriving at the start. The alert comes at start − drive − 5 minutes.
- Permissions: the prompts' texts are in `Info.macos.plist`, and the hardened
  runtime's calendar and location entitlements in `Entitlements.macos.plist`
  (`tauri.conf.json` → bundle → macOS).
- To check Mac code compiles on Linux: `rustup target add
  aarch64-apple-darwin`, then `cargo check --target aarch64-apple-darwin`
  with `CC_aarch64_apple_darwin` set to a stand-in compiler that writes empty
  object files (a check never links).

The multi-day view ("3 Days", `days` in `views/index.ts`) works the same
way with fewer columns across: `multiDayCount()` from `preferences.ts`, set
in Settings (`settings.ts`) and kept in local storage per device.

Week view slides: it draws six weeks (`WEEK_DRAWN_DAYS`) with columns a
seventh of the width, in one box that scrolls both ways (headers and hours
are `position: sticky`), with `scroll-snap-type: x mandatory` so it settles
on a day. `ViewContext.slid` reports the first day shown; once it settles in
another week, `main.ts` draws six weeks around it. Arrows and Today slide
there with `slideTimeline` when it's among the days drawn.

## Todoist (done)

- Uses Todoist's API v1 with the personal API token, stored in the keychain
  under `todoist-token` (`settings.ts` is the connect dialog).
- `todoist.rs` fetches all active tasks and projects, keeps tasks with a due
  date in the requested range, and maps them to
  `AgendaItem { source: Todoist, kind: Task, … }`. Overdue tasks are shown on
  today. Project colors and P1–P4 priorities carry over.
- `agenda::load` fetches Google and Todoist at the same time. A Todoist
  failure becomes a warning banner instead of hiding the calendar.
- Ticking a checkbox calls `set_task_completed` (Todoist's close/reopen).
  Done tasks stay visible, struck through, until the app restarts.
- Limits for now: recurring tasks show only their next occurrence (that's all
  the API returns), and tasks completed elsewhere aren't shown.

## Adding and editing (done)

- **+** in the top bar (or `N`) opens `event-form.ts`. The sentence box at
  the top is read locally by `quick-parse.ts` with
  [`chrono-node`](https://github.com/wanasit/chrono) (English only): date and
  time, a range ("9-10:30am", "Nov 12-14"), a length ("for 30 min", default
  1 hour), a place ("at Cafe Roma", "in Berlin"), a repeat ("every weekday",
  "every 2 weeks", "monthly on the 1st"), an alert ("remind me 30 min
  before", "no alert") and guests (email addresses). It fills the fields
  below, except ones edited by hand. A bare hour from 1 to 7 means pm.
- Events: `create_event` POSTs to `calendars/{id}/events` (with
  `recurrence` RRULEs, `reminders` and `attendees`; guests are emailed).
  `update_event` PATCHes only the fields that changed and can move the event
  to another calendar first; `delete_event` DELETEs. For one occurrence of
  a repeating event, "all events" uses `seriesId`; editing all events
  (`update_series`) shifts the series' own start by as much as the edited
  occurrence moved, so it keeps its first date. The `calendar.events`
  scope is in `google/auth.rs`; accounts added before need adding again
  once.
- Tasks go to Todoist (`create_task`, `update_task`, `delete_task`), into
  the chosen project (Inbox first). Repeats are sent as Todoist's own words
  (`due_string`, e.g. "every month on the 1st"); "p1"–"p4" set the priority.
  Repeating tasks can't be moved or have their date changed here (Todoist
  would end the repeat).

## Details, moving, search, alerts, offline (done)

- **Details** (`details.ts`): clicking any item opens a popup instead of the
  browser. Google's HTML notes are parsed with `DOMParser` into a detached
  document; only text and link addresses are shown (no HTML reaches the
  page). The video link comes from `conferenceData`/`hangoutLink`, or a
  Zoom/Meet/Teams/Webex address in the location or notes.
- **Moving** (`views/timeline.ts`): mouse/trackpad drag in day and week
  views, in 15-minute steps; the bottom 7px resize. Pointer moves are
  listened for on the window, because moving the block to another day's
  column ends pointer capture. `set_event_times` PATCHes start and end; one
  occurrence of a repeating event changes only that occurrence. Month view
  and the all-day row move items by whole days (`views/drag.ts`); tasks use
  `set_task_due`.
  `AgendaItem.editable` = account granted `calendar.events` + calendar
  owner/writer + organized by you (or `guestsCanModify`).
- **Search** (`search.rs`): Google's `q` per calendar for a year either
  side; Todoist tasks matched locally on every word; the offline cache
  when nothing is reachable. 50 results each side of now.
- **Alerts** (`alerts.rs`): a background task checks every 30 s today's and
  tomorrow's timed events against their popup reminders (the event's own,
  or the calendar's defaults), reloading every 5 minutes or after a change
  made in the app. Alerts more than 2 minutes late are skipped (after
  sleep). It runs in Rust, so it keeps going with no window open. Desktop
  only via `tauri-plugin-notification`; iPhone alerts would need scheduling
  ahead with iOS.
- **Hidden calendars**: `prefs.rs` `google_calendars_hidden` on the desktop
  (and in KV, `hiddenCalendars`, on the web). `find_events` skips those
  calendars, so views, search, alerts and the menu bar all leave them out,
  and the offline cache filters them too. Settings → Calendars lists every
  calendar (`google_calendars`) and flips one (`set_google_calendar_shown`).
- **Weather** (`weather.ts`): Open-Meteo's forecast (16 days, plus the past
  7) for a place chosen in Settings, found with Open-Meteo's geocoding, or
  the current location, found again at each fetch (the Mac app asks Core
  Location through `current_location` in `travel.rs`; elsewhere the page
  asks the browser, `navigator.geolocation`);
  fetched by the page itself (the CSPs in `tauri.conf.json` and
  `web/src/index.ts` allow its two hosts), kept in local storage and fetched
  again after 3 hours. The views ask `weatherOn(day)` when they draw.
- **Sync** (`main.ts` `sync`, `flyout.ts`): the open window fetches its
  range again every minute, and on focus, `visibilitychange` and `online`;
  it redraws only if the answer differs from what's drawn, and skips while
  hidden, dragging or with a menu open. (Google push notifications need a
  public web address to call, which a desktop app doesn't have.)
- **Zoom to fit** (`views/timeline.ts` `busyHours`, `fit`): when other days
  come on screen (opening a view, or once a slide settles, animated), the
  hour height is set so their timed items fill the hours' height (between
  `MIN_HOUR_HEIGHT` and 96 px, at least 8 hours, 8 AM–6 PM if none; the
  small hours of last night's late event don't count; the phone's floating
  buttons are left clear). A pinch or scroll of your own keeps until other
  days come on screen. `fitted` remembers what was fitted, so redraws for
  the same days don't jump.
- **All-day row scrolling**: a gesture that starts up or down on it scrolls
  only it (`touchmove` is prevented, so the hours and days don't move too);
  one that starts sideways slides the days. A trackpad swipe keeps scrolling
  whichever it started on (`wheelGesture`), momentum included.
- **Creating from the grid** (`views/create.ts`): double-click a day or a
  time (snapped to 15 minutes) for New event there; right-click for a menu
  of New Event / New Task. `openNew` takes the place clicked as `At`.
- **Overlaps** (`views/timeline.ts` `layoutColumns`): events starting
  within a title's height of each other share the width side by side;
  a later one starting inside another is drawn over it, indented, as in
  Apple's Calendar.
- **Offline** (`cache.rs`): each successful fetch replaces the saved items
  in its range for the sources that loaded; `get_agenda` falls back to them
  on network errors (`offlineSince` drives the banner), and
  `get_saved_agenda` lets a view draw instantly before the fetch.

## Later: branding and design

- **Logo (done):** the sources are in `src-tauri/icons/source/`:
  `icon-mac.svg` (rounded tile with Apple's margins), `icon-windows.svg` (the
  same tile, nearly filling the square, so it isn't small in the Windows
  taskbar) and `icon-ios.svg` (full square; iOS rounds the corners itself).
  After editing, run `npm run tauri icon src-tauri/icons/source/icon-mac.svg`;
  then generate `icon-windows.svg` into a scratch folder
  (`npx tauri icon src-tauri/icons/source/icon-windows.svg -o <folder>`) and
  copy its `icon.ico`, `Square*Logo.png` and `StoreLogo.png` over; then copy
  the `ios/` images generated from `icon-ios.svg` into
  `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/` (iOS icons must
  not have transparency).
  The website's icons are in `public/` (copied into the build as they are):
  `favicon.svg` is `icons/source/tray.svg` (the rounded tile);
  `apple-touch-icon.png` (180px), `icon-192.png` and `icon-512.png` are
  `icon-ios.svg` rendered full square without transparency, for phones' home
  screens and `manifest.webmanifest`.
- **Name (done): Minuteman.** It's `productName` and the window `title` in
  `src-tauri/tauri.conf.json`, the page title and heading in `index.html`
  and `main.ts`, the sign-in page in `google/loopback.rs`, and
  `PRODUCT_NAME` in the iOS project (`gen/apple/project.yml` and
  `project.pbxproj`). The `identifier` stays `com.lukesassa.calendar`:
  changing it would move the app's data folder and keychain access, so
  you'd sign in again.
- **Visual design (done):** taken from the icon. A navy header like the
  flag's canton (`--chrome`) over a thin red/ivory/red stripe band, ivory
  backgrounds, flag-red accent, and today as a star in a red square.
  Headings use Libre Caslon (Caslon was the type of the first printed
  Declaration of Independence), bundled from `@fontsource/libre-caslon-text`
  so it works offline. Dark mode is navy throughout with ivory text. All
  colors are CSS variables at the top of `src/styles.css`, with the dark
  block just below.
- **Google consent screen:** the app name, and a logo if you want one, on
  Google Auth Platform → Branding. Uploading a logo requires Google's brand
  verification once the app is published.

## iPhone (in progress)

Code is prepared; building happens on a Mac. See [ios-setup.md](ios-setup.md).
Sign-in uses Google's "iOS" client with a custom URL scheme (deep link)
instead of the desktop loopback server; `#[cfg(desktop)]` / `#[cfg(mobile)]`
pick the right path at compile time.

## Mobile later

- **Tauri v2 mobile:** the Rust core and the web UI are reused as they are. `keyring`'s
  `apple-native` feature also covers iOS. Android needs a different secure
  store (Android Keystore), e.g. via a Tauri plugin, behind the same
  `secrets.rs` functions. The loopback sign-in is replaced by a custom URL scheme or
  app link redirect with an "iOS" or "Android" OAuth client type.
- **PWA alternative:** the TypeScript UI could run in a browser, but OAuth
  and token storage would have to move to browser-safe flows (no client
  secret, no keychain). That's a bigger change, so Tauri mobile is the
  smoother path.
