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
│ settings.ts Google accounts and Todoist dialogs     │
│ dev-mock.ts sample data for `npm run dev` in a      │
│            browser (dev only)                       │
└───────────────────────┬─────────────────────────────┘
                        │ invoke("get_agenda") etc. (Tauri IPC)
┌───────────────────────┴──── Rust (src-tauri/src/) ──┐
│ lib.rs             commands + shared state          │
│ agenda.rs          AgendaItem model, merge + sort   │
│ google/auth.rs     OAuth PKCE + loopback, tokens    │
│ google/calendar.rs Calendar API v3 client           │
│ todoist.rs         Todoist API v1: tasks, complete  │
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
   date range) and draws into an element. The tray flyout can reuse
   `renderAgenda` or `renderTimeline` with a one-day range.
4. **The backend serves any date range.** `get_agenda(from, to)` takes local
   dates. Each view decides its own range (a week, six weeks for a month grid,
   a year).

## Phase 2: tray icon and flyout

- Enable Tauri's `tray-icon` feature in `Cargo.toml` and build a `TrayIconBuilder`
  in `lib.rs` `setup`.
- Add a second window, label `flyout`, to `tauri.conf.json`: `decorations: false`,
  `skipTaskbar: true`, `alwaysOnTop: true`, `visible: false`, about 360×480.
  It loads the same `index.html?view=flyout`, and `main.ts` chooses a compact layout.
- On tray click, use `tauri-plugin-positioner` (`Position::TrayBottomCenter`
  on Windows, `TrayCenter` on macOS) to place the window above the taskbar
  or below the menu bar, then show and focus it. Hide it on blur.
- Add `"flyout"` to the `windows` list in `capabilities/default.json`.
- Optionally keep the app running when the main window closes (handle
  `CloseRequested` → hide) so the tray stays available.

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

## Phase 3: natural-language creation

- Parsing runs locally and for free: e.g. [`chrono-node`](https://github.com/wanasit/chrono)
  in TypeScript turns "lunch with Sam tomorrow 1pm" into a title and a date.
  Show a live preview before saving, like Fantastical.
- A leading keyword or prefix ("task:", or a toggle) sends the item to Todoist.
  Otherwise it becomes a Google event.
- Add the `calendar.events` scope in `google/auth.rs` and on the consent
  screen. Existing users sign in again once to grant it.
- New Rust commands: `create_event` (POST `calendars/{id}/events`) and
  `create_task` (Todoist).

## Later: custom logo, branding and design

The app icon in `src-tauri/icons/` is still Tauri's placeholder. Plan:

- **Logo:** make one square 1024×1024 PNG or SVG, then run
  `npm run tauri icon <file>` to generate every platform size.
- **Name:** update `productName` and the window `title` in
  `src-tauri/tauri.conf.json`. Changing `identifier` would also move the
  keychain entry (`SERVICE` in `secrets.rs`), so you'd sign in again once.
- **Visual design:** colors, fonts and spacing live as CSS variables at the
  top of `src/styles.css` (`--accent`, `--bg`, and so on), with a dark-mode
  block below. Restyling starts there.
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
